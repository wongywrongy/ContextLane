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
import { socketPath } from "./sandbox.js";
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
  const lanes = new LaneManager({ store, bus, config, run: runCommand });
  const setup = new SetupManager(config, store, runCommand, { changed: async () => { await notifier.close(); notifier = makeNotifier(); notifier.start(); } });
  await setup.initialize();
  const runtime = new Runtime({ store, bus, config, run: runCommand });
  const app = buildServer({ store, bus, lanes, hosts, config, version: VERSION, setup, runtime });
  const makeNotifier = () => new Notifier({ store, bus, config: config.notifications,
    answer: async (token) => (await app.inject({ method: "POST", url: "/api/answers", headers: { authorization: `Bearer ${token}` }, payload: {} })).statusCode === 202 });
  let notifier = makeNotifier();
  await app.listen({ host: config.listen.host, port: config.listen.port });
  notifier.start();
  runtime.watch();
  console.log(`ContextLanes ${VERSION} on http://${config.listen.host}:${config.listen.port}`);

  const stop = async () => {
    await notifier.close();
    runtime.close();
    await app.close();
    await hosts.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
