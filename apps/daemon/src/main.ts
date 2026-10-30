#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "./bus.js";
import { loadConfig } from "./config.js";
import { Store } from "./db/store.js";
import { HostLinks } from "./hosts.js";
import { buildServer } from "./http/server.js";
import { LaneManager } from "./lanes/manager.js";
import { runCommand } from "./run.js";
import { Notifier } from "./notifications/notifier.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.paths.data, { recursive: true, mode: 0o700 });
  const store = Store.open(join(config.paths.data, "contextlanes.sqlite"));
  const bus = new EventBus();
  const hosts = new HostLinks({ store, bus });
  await hosts.listen(join(config.paths.data, "lanes.sock"));
  const lanes = new LaneManager({ store, bus, config, run: runCommand });
  const app = buildServer({ store, bus, lanes, hosts, config, version: VERSION });
  const notifier = new Notifier({ store, bus, config: config.notifications,
    answer: async (token) => (await app.inject({ method: "POST", url: "/api/answers", headers: { authorization: `Bearer ${token}` }, payload: {} })).statusCode === 202 });
  await app.listen({ host: config.listen.host, port: config.listen.port });
  notifier.start();
  console.log(`ContextLanes ${VERSION} on http://${config.listen.host}:${config.listen.port}`);

  const stop = async () => {
    await notifier.close();
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
