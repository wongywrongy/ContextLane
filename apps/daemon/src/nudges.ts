import type { LaneEvent } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Store } from "./db/store.js";
import type { HostLinks } from "./hosts.js";

/** Steps a lane may take without a plan before it is asked for one. */
export const PLAN_AFTER = 40;
/** Share of the context window at which the agent is told to commit and stay focused. */
export const CONTEXT_AT = 0.7;

export const PLAN_NUDGE = "From ContextLanes: you have taken a lot of steps without a plan. Write a short plan of what is left (3 to 7 steps) with your plan or todo tool and mark what is done. If what is left has independent parts that touch different files, consider split_lanes so they run in parallel. Then carry on.";
export const CONTEXT_NUDGE = "From ContextLanes: your context is over 70% full. Commit what works now with a clear message, keep the rest of the task focused, and avoid re-reading large files. If the remaining work splits into independent parts, split_lanes runs them in fresh contexts.";

/**
 * Nudges: ContextLanes steps in once per lane and kind, so a long lane does not drift. With no plan after
 * PLAN_AFTER steps the agent is asked for one; past CONTEXT_AT of its context it is asked to commit and keep
 * focused (and the owner sees "Restart with a summary" in Progress). Each nudge is a lane.nudged event and a
 * queued message, delivered after the agent's current step; it never interrupts.
 */
export class Nudges {
  private steps = new Map<string, number>();
  private done = new Set<string>();
  constructor(private deps: { store: Store; bus: EventBus; hosts: HostLinks }) {}

  start(): () => void { return this.deps.bus.subscribeAll((e) => this.see(e)); }

  private sent(lane: string, kind: "plan" | "context"): boolean {
    if (this.done.has(`${lane}/${kind}`)) return true;
    const sent = this.deps.store.eventsOfType(["lane.nudged"], { lanes: [lane] }).some((e) => e.payload.kind === kind);
    if (sent) this.done.add(`${lane}/${kind}`);
    return sent;
  }

  private nudge(lane: string, kind: "plan" | "context", text: string): void {
    const { store, bus, hosts } = this.deps;
    this.done.add(`${lane}/${kind}`);
    bus.publish(store.appendEvent(lane, { type: "lane.nudged", payload: { kind, text } }));
    hosts.command(lane, { kind: "prompt", text, immediate: false, files: [], images: [] });
  }

  private see(e: LaneEvent): void {
    const lane = this.deps.store.getLane(e.lane);
    if (!lane || lane.state !== "working") return;
    if (e.type === "agent.plan") { this.steps.set(e.lane, -Infinity); return; }
    if (e.type === "tool.call") {
      const n = (this.steps.get(e.lane) ?? 0) + 1;
      this.steps.set(e.lane, n);
      // Counted in memory and checked against the log every tenth step, so a restart neither nudges twice nor forgets.
      if (n % 10 !== 0) return;
      const events = this.deps.store.eventsOfType(["tool.call", "agent.plan"], { lanes: [e.lane] });
      if (events.some((x) => x.type === "agent.plan")) { this.steps.set(e.lane, -Infinity); return; }
      if (events.length >= PLAN_AFTER && !this.sent(e.lane, "plan")) this.nudge(e.lane, "plan", PLAN_NUDGE);
      return;
    }
    if (e.type === "usage" && e.payload.contextSize > 0 && e.payload.contextUsed / e.payload.contextSize >= CONTEXT_AT && !this.sent(e.lane, "context")) this.nudge(e.lane, "context", CONTEXT_NUDGE);
  }
}
