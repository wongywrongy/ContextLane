import type { Checkpoint, LaneEvent } from "@contextlanes/protocol";
import { estimateTokens } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Store } from "./db/store.js";
import { NotFound, Refused, type LaneManager } from "./lanes/manager.js";
import { hostUnit } from "./lanes/naming.js";
import type { Runner } from "./run.js";

/**
 * Ask another agent to review (4.2): a read-only lane of its own (plan mode), started from the lane's
 * branch, asked to review the checkpoint's change. When its first turn ends, its answer becomes a
 * section of the review packet and the review lane is archived. It never approves anything.
 */
export class SecondReviews {
  constructor(private deps: { store: Store; bus: EventBus; lanes: LaneManager; run: Runner }) {
    deps.bus.subscribeAll((e) => this.observe(e));
  }

  /** Shown before starting: the diff read twice (once whole, once while checking) plus the agent's own overhead. */
  async estimate(checkpointId: string): Promise<{ tokens: number }> {
    const c = this.deps.store.checkpoint(checkpointId);
    if (!c) throw new NotFound("no such checkpoint");
    const lane = this.deps.store.getLane(c.lane)!;
    const diff = await this.deps.run("git", ["diff", "--no-color", c.base, c.head], { cwd: lane.worktree }).then((r) => r.stdout, () => "");
    return { tokens: Math.round((estimateTokens(diff) * 2 + 15_000) / 1000) * 1000 };
  }

  async start(checkpointId: string, agent: string): Promise<Checkpoint> {
    const { store, lanes } = this.deps;
    const c = store.checkpoint(checkpointId);
    if (!c) throw new NotFound("no such checkpoint");
    if (c.decision) throw new Refused("This checkpoint has been decided already.");
    if (c.secondReview?.state === "running") throw new Refused("A second review is already running.");
    const lane = store.getLane(c.lane)!;
    if (agent === lane.agent) throw new Refused("Choose a different agent from the one that wrote the change.");
    const prompt = [`Review a change another coding agent made, before its owner merges it. You are read-only: do not edit files or run anything that changes them.`,
      `The change is ${c.base}..${c.head} in this checkout (run: git diff ${c.base} ${c.head}). The agent's summary: ${c.summary}`,
      c.plan.length ? `Its plan: ${c.plan.map((p) => `${p.status === "completed" ? "[done]" : "[open]"} ${p.text}`).join("; ")}` : "",
      c.checks.length ? `Checks: ${c.checks.map((x) => `${x.name} ${x.passed ? "passed" : "failed"}`).join(", ")}` : "",
      `Reply with findings only, most serious first, one per line: "blocker", "should fix" or "nit" — file:line — what is wrong and why. Then one line: "Verdict: merge", "Verdict: merge after fixes" or "Verdict: do not merge".`].filter(Boolean).join("\n\n");
    const review = await lanes.start({ project: lane.project, task: `Second review of ${lane.id.split("/")[1]} by ${agent}`, agent, mode: "plan", base: lane.branch, goal: lane.goal ?? undefined }, { firstPrompt: prompt });
    store.setSecondReview(c.id, { agent, lane: review.id, state: review.state === "failed" ? "failed" : "running", text: null, at: new Date().toISOString() });
    return store.checkpoint(c.id)!;
  }

  private observe(e: LaneEvent): void {
    // The review ends when its agent finishes a turn, or when its lane fails (not signed in, never connected).
    const failed = e.type === "lane.state" && e.payload.to === "failed";
    if (!failed && (e.type !== "agent.turn" || e.payload.active)) return;
    const { store, bus } = this.deps;
    const reviewLane = store.getLane(e.lane);
    if (!reviewLane) return;
    const c = store.checkpoints(reviewLane.project).find((x) => x.secondReview?.lane === e.lane && x.secondReview.state === "running");
    if (!c) return;
    const events: LaneEvent[] = [];
    for (;;) { const page = store.events(e.lane, events.at(-1)?.seq ?? 0); if (!page.length) break; events.push(...page); }
    const text = events.filter((x): x is Extract<LaneEvent, { type: "agent.message" }> => x.type === "agent.message" && x.payload.role === "agent").map((x) => x.payload.text).join("").trim();
    store.setSecondReview(c.id, { ...c.secondReview!, state: text ? "done" : "failed", text: text || null, at: new Date().toISOString() });
    bus.publish(store.setLaneState(e.lane, "archived", "second review written"));
    void this.deps.run("systemctl", ["--user", "stop", reviewLane.hostUnit ?? hostUnit(reviewLane.id)]).catch(() => {});
  }
}
