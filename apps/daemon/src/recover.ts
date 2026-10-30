import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EventBus } from "./bus.js";
import type { Config } from "./config.js";
import type { Store } from "./db/store.js";
import { hostUnit } from "./lanes/naming.js";
import type { Runner } from "./run.js";

/**
 * Run once at startup, before the HTTP server listens: put right what a restart (crash, update, power
 * cut) left half done. A lane caught setting up becomes working if its agent host is running, else
 * failed with a reason; screenshot "before" checkouts and their services are removed; git forgets
 * worktrees whose folders are gone. Each step is best-effort and logged; none stops the daemon starting.
 */
export async function recover(deps: { store: Store; bus: EventBus; config: Config; run: Runner }): Promise<string[]> {
  const { store, bus, config, run } = deps;
  const done: string[] = [];
  for (const lane of store.listLanes().filter((l) => l.state === "draft" || l.state === "setting_up")) {
    const active = await run("systemctl", ["--user", "is-active", "--quiet", lane.hostUnit ?? hostUnit(lane.id)], { timeout: 10_000 }).then(() => true, () => false);
    try {
      if (lane.state === "draft") bus.publish(store.setLaneState(lane.id, "archived", "ContextLanes restarted before this lane was set up."));
      else if (active) bus.publish(store.setLaneState(lane.id, "working"));
      else bus.publish(store.setLaneState(lane.id, "failed", "ContextLanes restarted while this lane was being set up. Start a new lane with the same task; this branch is kept."));
      done.push(`${lane.id}: ${store.getLane(lane.id)!.state}`);
    } catch (err) { console.error(`Could not recover ${lane.id}:`, err); }
  }
  // Services started for "before" screenshots, and their temporary checkouts.
  const units = await run("systemctl", ["--user", "list-units", "--all", "--plain", "--no-legend", "--type=service", "contextlanes-env-before-*"], { timeout: 10_000 }).then((r) => r.stdout, () => "");
  for (const unit of units.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((u): u is string => !!u)) {
    await run("systemctl", ["--user", "stop", unit], { timeout: 30_000 }).catch(() => {});
    done.push(`stopped ${unit}`);
  }
  const before = join(config.paths.lanes, ".before");
  if ((await readdir(before).catch(() => [])).length) { await rm(before, { recursive: true, force: true }); done.push("removed old before-checkouts"); }
  for (const project of store.listProjects()) await run("git", ["worktree", "prune"], { cwd: project.path, timeout: 30_000 }).catch(() => {});
  return done;
}
