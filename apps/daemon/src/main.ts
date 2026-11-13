#!/usr/bin/env node
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { EventBus } from "./bus.js";
import { loadConfig, configPath, defaultRuntime, ensureConfigFile, listenHost } from "./config.js";
import { inspectSelf, type ControlInfo } from "./docker/control.js";
import { DockerFolders } from "./docker/folders.js";
import { DockerLanes } from "./docker/lanes.js";
import { writeFile, mkdir as mkdirp } from "node:fs/promises";
import { Store } from "./db/store.js";
import { HostLinks } from "./hosts.js";
import { buildServer } from "./http/server.js";
import { LaneManager } from "./lanes/manager.js";
import { runCommand } from "./run.js";
import { SetupManager } from "./setup.js";
import { Notifier } from "./notifications/notifier.js";
import { Runtime } from "./runtime.js";
import { releaseVersion, layoutOf, exists } from "./layout.js";
import { homedir } from "node:os";
import { installBackupTimer } from "./install.js";
import { confineGit, socketPath } from "./sandbox.js";
import { CodeMaps } from "./codemap.js";
import { Collisions } from "./collisions.js";
import { LocalModels } from "./localmodels.js";
import { Briefs } from "./briefs.js";
import { Insights } from "./insights.js";
import { Schedules } from "./schedules.js";
import { recover } from "./recover.js";
import { tidyFiles } from "./janitor.js";
import { fileURLToPath } from "node:url";
import { detectDriver } from "./supervisor/index.js";

async function main(): Promise<void> {
  // The commit this release was built from; `contextlanes update` waits for it after a restart.
  const VERSION = await releaseVersion(runCommand, fileURLToPath(new URL("../../../", import.meta.url)), process.env.CONTEXTLANES_VERSION || "0.1.0");
  // The control image starts with no settings file: write one with the defaults, once.
  if (defaultRuntime() === "docker" && await ensureConfigFile()) console.log(`Wrote ${configPath()} with the default settings.`);
  const config = loadConfig();
  const docker = config.runtime.mode === "docker";
  if (docker) {
    // Lanes are containers (docker/lanes.ts) and their processes run in them (supervisor/docker.ts); the
    // process driver is only for anything the control service itself would run.
    config.supervisor.driver = "process";
    console.log("Docker runtime: the control service mounts none of your folders; git on a project runs in a helper container, and each lane is its own container.");
  } else {
    // Settled once: everything built below runs lane services the same way.
    if (config.supervisor.driver === "auto") config.supervisor.driver = await detectDriver(runCommand);
    console.log(config.supervisor.driver === "systemd" ? "Lane services run as systemd user units." : "Lane services run as process groups watched by this daemon (no systemd user session found).");
    if (config.sandbox.mode === "off") console.warn("The sandbox is off ([sandbox] mode = \"off\"): agents and lane services run with your full access, including ContextLanes' own data.");
  }
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const layout = await layoutOf(root, homedir());
  mkdirSync(config.paths.data, { recursive: true, mode: 0o700 });
  const store = Store.open(join(config.paths.data, "contextlanes.sqlite"));
  if (layout.managed && !docker) await installBackupTimer({ root: await exists(layout.current) ? layout.current : layout.repo, home: homedir(), node: process.execPath, run: runCommand, config: configPath() })
    .catch((err) => console.error("Nightly backups could not be scheduled:", err));
  const bus = new EventBus();
  const hosts = new HostLinks({ store, bus });
  // shortcut: releases before migration 8 kept the socket in the data folder; drop this once none remain.
  rmSync(join(config.paths.data, "lanes.sock"), { force: true });
  mkdirSync(dirname(socketPath(config)), { recursive: true, mode: 0o700 });
  // Lane hosts are ACP; the socket also stays up while ACP lanes from before the feature was turned off are open.
  const acpLanes = store.listLanes().some((l) => l.kind === "acp" && !["cleaned", "archived", "merged", "failed"].includes(l.state));
  if (config.features.acp || acpLanes) await hosts.listen(socketPath(config));
  // The Docker runtime: the control service's own container, found once (and again while it is not found).
  let control: ControlInfo | null = null;
  const findControl = async () => { control = await inspectSelf(runCommand).catch((err: Error) => { console.error(err.message); return null; }); };
  if (docker) {
    await findControl();
    if (!control) { const again = setInterval(() => void findControl().then(() => { if (control) clearInterval(again); }), 30_000); again.unref(); }
  }
  const folders = docker ? new DockerFolders({ run: runCommand, control: () => control, store }) : undefined;
  // Every git and gh the daemon runs goes through confineGit: the lane sandbox on the host, a helper
  // container per call in the Docker runtime.
  const run = confineGit(folders ? folders.runner() : runCommand, config, undefined, (cwd) => {
    const lane = store.listLanes().find((l) => l.worktree === cwd);
    return lane ? store.getProject(lane.project)?.path : store.listProjects().find((p) => p.path === cwd)?.path;
  });
  // Lane containers. dataFile: a file in ./data that one helper mounts read-only (the Dev Container CLI's passwd line).
  const dockerLanes = docker && folders ? new DockerLanes({ docker: runCommand, git: run, folders, store, bus, config, control: () => control,
    dataFile: async (name, content) => {
      const host = (control as ControlInfo | null)?.data;
      if (!host) return null;
      const path = join(config.paths.data, name);
      await mkdirp(dirname(path), { recursive: true, mode: 0o755 });
      await writeFile(path, content, { mode: 0o644 });
      return join(host, name);
    } }) : undefined;
  const lanes = new LaneManager({ store, bus, config, run, ...(dockerLanes ? { docker: dockerLanes } : {}) });
  const setup = new SetupManager(config, store, run, { changed: async () => { await notifier.close(); notifier = makeNotifier(); notifier.start(); }, ...(folders ? { folders } : {}) });
  await setup.initialize();
  // In the Docker runtime a lane's app runs in its container (docs/V4.md 3.4): the runtime gets the lanes.
  const runtime = new Runtime({ store, bus, config, run, ...(dockerLanes ? { docker: dockerLanes } : {}) });
  const codemaps = new CodeMaps({ run, store, config });
  const localModels = new LocalModels({ config, run, journal: join(config.paths.data, "local-jobs.json") });
  const briefs = new Briefs({ config, store, codemaps, models: localModels });
  const insights = new Insights({ config, store, bus, models: localModels, codemaps, briefs });
  const collisions = new Collisions({ store, bus, codemaps, hosts });
  // Timers call the CLI of the running install, through `current` when this is a managed install.
  const cli = join(layout.managed && await exists(layout.current) ? layout.current : root, "apps/cli/dist/main.js");
  const schedules = config.features.schedules ? new Schedules({ config, store, lanes, setup, run, home: homedir(), node: process.execPath, cli }) : undefined;
  for (const line of await recover({ store, bus, config, run }).catch((err) => { console.error("Startup recovery failed:", err); return []; })) console.log(`Recovered: ${line}`);
  // Lane containers keep running while the control container is replaced: find them again by their labels.
  if (dockerLanes && control) {
    const found = await dockerLanes.reconcile().catch((err: Error) => { console.error("Finding lane containers failed:", err.message); return null; });
    for (const line of found?.lines ?? []) console.log(`Lanes: ${line}`);
    if (found?.strays.length) console.log(`Lanes: containers labelled as lanes that no open lane owns: ${found.strays.join(", ")} (left as they are; contextlanes doctor lists them)`);
  }
  const app = buildServer({ store, bus, lanes, hosts, config, version: VERSION, setup, runtime, run, codemaps, collisions, localModels, briefs, insights, schedules, ...(docker ? { docker: { control: () => control, ...(dockerLanes ? { lanes: dockerLanes, config } : {}) } } : {}) });
  const makeNotifier = () => new Notifier({ store, bus, config: config.notifications,
    answer: async (token) => (await app.inject({ method: "POST", url: "/api/answers", headers: { authorization: `Bearer ${token}` }, payload: {} })).statusCode === 202 });
  let notifier = makeNotifier();
  // Routes for services that kept running while the daemon was down, before anything can ask for them.
  const restored = await runtime.restoreLinks().catch((err) => { console.error("Preview router could not start:", err); return 0; });
  if (restored) console.log(`Preview links restored: ${restored}`);
  await app.listen({ host: listenHost(config), port: config.listen.port });
  notifier.start();
  runtime.watch();
  if (config.features.architecture) collisions.start();
  if (config.features.insights) insights.start();
  // Hosts that died quietly (out of memory, a reboot) fail their lane; the first pass waits for reconnects.
  let sweeping = false;
  const sweep = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void lanes.sweep((id) => hosts.connected(id)).then((ids) => { for (const id of ids) console.log(`Lane ${id}: its agent host stopped`); }, (err) => console.error("Lane sweep failed:", err)).finally(() => { sweeping = false; });
  }, 60_000);
  sweep.unref();
  // Old attachments, screenshots and answer links of finished lanes: once soon after start, then daily.
  const tidy = () => void tidyFiles({ store, config }).then((lines) => { for (const line of lines) console.log(`Tidied: ${line}`); }, (err) => console.error("Tidying files failed:", err));
  const tidyFirst = setTimeout(tidy, 5 * 60_000); tidyFirst.unref();
  const tidyDaily = setInterval(tidy, 86_400_000); tidyDaily.unref();
  console.log(`ContextLanes ${VERSION} on http://${listenHost(config)}:${config.listen.port}${docker ? " (inside the container; not published)" : ""}`);
  if (config.previews.mode === "router") console.log(`Preview router on ${config.previews.bind}:${config.previews.localPort}${config.previews.domain ? ` for *.${config.previews.domain}` : ""}`);

  // Stop within seconds: open requests (a long model call, a clone) are cut rather than waited for, so
  // systemd's restart during an update never hits its kill timeout. A second signal is ignored.
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => { console.error("Shutdown took too long; exiting."); process.exit(0); }, 10_000).unref();
    try {
      clearInterval(sweep); clearTimeout(tidyFirst); clearInterval(tidyDaily);
      await notifier.close();
      runtime.close();
      collisions.close();
      insights.close();
      await app.close();
      await hosts.close();
      store.close();
    } catch (err) { console.error("Shutdown error:", err); }
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  // A stray rejection is logged and the daemon keeps serving; systemd restarts it only on a real crash.
  process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
