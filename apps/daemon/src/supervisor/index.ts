import { existsSync } from "node:fs";
import type { Config } from "../config.js";
import type { Runner } from "../run.js";
import { ProcessSupervisor } from "./process.js";
import { SystemdSupervisor } from "./systemd.js";
import type { Supervisor } from "./types.js";

export * from "./types.js";
export { ProcessSupervisor } from "./process.js";
export { SystemdSupervisor, systemdOneshotArgs, systemdServiceArgs } from "./systemd.js";
export { DockerSupervisor, UNIT_SH } from "./docker.js";

/** One process supervisor per data folder: it holds the children it restarts. */
const processes = new Map<string, ProcessSupervisor>();

/**
 * The supervisor configured for this daemon. "auto" is settled once at startup (detectDriver); anything
 * that has not been settled, such as a test's config, means systemd, which every caller already fakes.
 */
export function supervisorFor(config: Config, run: Runner): Supervisor {
  if (config.supervisor.driver !== "process") return new SystemdSupervisor(run);
  let found = processes.get(config.paths.data);
  if (!found) processes.set(config.paths.data, found = new ProcessSupervisor(config.paths.data));
  return found;
}

/** systemd when this user has a running systemd manager to talk to; otherwise plain processes. */
export async function detectDriver(run: Runner): Promise<"systemd" | "process"> {
  if (process.platform !== "linux" || !existsSync("/run/systemd/system")) return "process";
  const state = await run("systemctl", ["--user", "is-system-running"], { timeout: 5000 }).then((r) => r.stdout.trim(), (e: { stdout?: string }) => e.stdout?.trim() ?? "");
  return ["running", "degraded", "starting"].includes(state) ? "systemd" : "process";
}
