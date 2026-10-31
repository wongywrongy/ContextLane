#!/usr/bin/env node
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { EventBus } from "./bus.js";
import { loadConfig, configPath } from "./config.js";
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

async function main(): Promise<void> {
  // The commit this release was built from; `contextlanes update` waits for it after a restart.
  const VERSION = await releaseVersion(runCommand, fileURLToPath(new URL("../../../", import.meta.url)), "0.1.0");
  const config = loadConfig();
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const layout = await layoutOf(root, homedir());
  mkdirSync(config.paths.data, { recursive: true, mode: 0o700 });
  const store = Store.open(join(config.paths.data, "contextlanes.sqlite"));
  if (layout.managed) await installBackupTimer({ root: await exists(layout.current) ? layout.current : layout.repo, home: homedir(), node: process.execPath, run: runCommand, config: configPath() })
    .catch((err) => console.error("Nightly backups could not be scheduled:", err));
  const bus = new EventBus();
  const hosts = new HostLinks({ store, bus });
  // shortcut: releases before migration 8 kept the socket in the data folder; drop this once none remain.
  rmSync(join(config.paths.data, "lanes.sock"), { force: true });
  mkdirSync(dirname(socketPath(config)), { recursive: true, mode: 0o700 });
  await hosts.listen(socketPath(config));
  // Every git and gh the daemon runs goes through the lane sandbox (see confineGit).
  const run = confineGit(runCommand, config);
  const lanes = new LaneManager({ store, bus, config, run });
  const setup = new SetupManager(config, store, run, { changed: async () => { await notifier.close(); notifier = makeNotifier(); notifier.start(); } });
  await setup.initialize();
  const runtime = new Runtime({ store, bus, config, run });
  const codemaps = new CodeMaps({ run, store, config });
  const localModels = new LocalModels({ config, run, journal: join(config.paths.data, "local-jobs.json") });
  const briefs = new Briefs({ config, store, codemaps, models: localModels });
  const insights = new Insights({ config, store, bus, models: localModels, codemaps, briefs });
  const collisions = new Collisions({ store, bus, codemaps, hosts });
  // Timers call the CLI of the running install, through `current` when this is a managed install.
  const cli = join(layout.managed && await exists(layout.current) ? layout.current : root, "apps/cli/dist/main.js");
  const schedules = new Schedules({ config, store, lanes, setup, run, home: homedir(), node: process.execPath, cli });
  for (const line of await recover({ store, bus, config, run }).catch((err) => { console.error("Startup recovery failed:", err); return []; })) console.log(`Recovered: ${line}`);
  const app = buildServer({ store, bus, lanes, hosts, config, version: VERSION, setup, runtime, run, codemaps, collisions, localModels, briefs, insights, schedules });
  const makeNotifier = () => new Notifier({ store, bus, config: config.notifications,
    answer: async (token) => (await app.inject({ method: "POST", url: "/api/answers", headers: { authorization: `Bearer ${token}` }, payload: {} })).statusCode === 202 });
  let notifier = makeNotifier();
  await app.listen({ host: config.listen.host, port: config.listen.port });
  notifier.start();
  runtime.watch();
  collisions.start();
  insights.start();
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
  console.log(`ContextLanes ${VERSION} on http://${config.listen.host}:${config.listen.port}`);

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
