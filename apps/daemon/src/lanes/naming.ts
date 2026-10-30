import { join } from "node:path";
import { laneNumber, type LaneId, type ProjectId } from "@contextlanes/protocol";

/** "Billing phase 0: invoices!" -> "billing-phase-0-invoices" (max 40 chars). */
export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "lane";
}

/** Branches carry the lane number so two lanes with the same task never collide. */
export function branchName(n: number, task: string): string {
  return `lane/${String(n).padStart(2, "0")}-${slugify(task)}`;
}

/** Worktrees live outside the repo: ~/lanes/<project>/<NN>-<slug>. */
export function worktreePath(lanesDir: string, project: ProjectId, n: number, task: string): string {
  return join(lanesDir, project, `${String(n).padStart(2, "0")}-${slugify(task)}`);
}

/** One tmux session per lane, named so `tmux ls` stays readable. */
export function terminalSession(lane: LaneId): string {
  const project = lane.slice(0, lane.lastIndexOf("/"));
  return `cl-${project}-${laneNumber(lane)}`;
}

/** The systemd unit that keeps a lane host alive across daemon restarts. */
export function hostUnit(lane: LaneId): string {
  return `contextlanes-lane-${lane.replace("/", "-")}`;
}
