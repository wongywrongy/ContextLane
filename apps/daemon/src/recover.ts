import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { laneTitle } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Config } from "./config.js";
import type { Store } from "./db/store.js";
import { hostUnit } from "./lanes/naming.js";
import type { Runner } from "./run.js";
import { supervisorFor } from "./supervisor/index.js";

/**
 * Run once at startup, before the HTTP server listens: put right what a restart (crash, update, power
 * cut) left half done. A lane caught setting up becomes working if its agent host is running, else
 * failed with a reason; screenshot "before" checkouts and their services are removed. Stale Git
 * registrations are retained: the sandbox cannot distinguish hidden worktrees from deleted ones.
 * Each step is best-effort and logged; none stops the daemon starting.
 */
export async function recover(deps: { store: Store; bus: EventBus; config: Config; run: Runner }): Promise<string[]> {
  const { store, bus, config, run } = deps;
  const done: string[] = [];
  // The Docker runtime: a lane caught setting up has a half-made container; nothing tells whether its
  // last step finished, so it fails with its checkout kept, and the lane containers are found again in main.
  if (config.runtime.mode === "docker") {
    for (const lane of store.listLanes().filter((l) => l.state === "draft" || l.state === "setting_up")) {
      bus.publish(lane.state === "draft" ? store.setLaneState(lane.id, "archived", "ContextLanes restarted before this lane was set up.")
        : store.setLaneState(lane.id, "failed", "ContextLanes restarted while this lane was being set up. Delete it (contextlanes delete) and start a new lane with the same task."));
      done.push(`${lane.id}: ${store.getLane(lane.id)!.state}`);
    }
    return done;
  }
  for (const lane of store.listLanes().filter((l) => l.state === "draft" || l.state === "setting_up")) {
    const active = lane.kind === "cli" ? await run("tmux", ["display-message", "-p", "-t", `=${lane.terminal}:`, "#{pane_dead}"]).then((r) => r.stdout.trim() === "0", () => false) : await run("systemctl", ["--user", "is-active", "--quiet", lane.hostUnit ?? hostUnit(lane.id)], { timeout: 10_000 }).then(() => true, () => false);
    try {
      if (lane.state === "draft") bus.publish(store.setLaneState(lane.id, "archived", "ContextLanes restarted before this lane was set up."));
      else if (active) bus.publish(store.setLaneState(lane.id, "working"));
      else bus.publish(store.setLaneState(lane.id, "failed", "ContextLanes restarted while this lane was being set up. Start a new lane with the same task; this branch is kept."));
      done.push(`${lane.id}: ${store.getLane(lane.id)!.state}`);
    } catch (err) { console.error(`Could not recover ${lane.id}:`, err); }
  }
  // Lanes started with a whole plan as their name get a short title; the plan stays as their first message.
  for (const lane of store.listLanes().filter((l) => l.task.length > 120 || l.task.includes("\n"))) {
    const e = store.renameLane(lane.id, laneTitle(lane.task));
    if (e) { bus.publish(e); done.push(`${lane.id}: shortened its title`); }
  }
  // Services started for "before" screenshots, and their temporary checkouts.
  const supervisor = supervisorFor(config, run);
  for (const unit of await supervisor.list("contextlanes-env-before-").catch(() => [])) {
    await supervisor.stop(unit).catch(() => {});
    done.push(`stopped ${unit}`);
  }
  const before = join(config.paths.lanes, ".before");
  if ((await readdir(before).catch(() => [])).length) { await rm(before, { recursive: true, force: true }); done.push("removed old before-checkouts"); }
  return done;
}
