import type { LaneEvent } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Store } from "./db/store.js";
import type { HostLinks } from "./hosts.js";

/** Optional owner-facing observations; they never send prompts or change the agent's work. */
export const CHECKIN_EVERY = 45 * 60_000;

export class Nudges {
  constructor(private deps: { store: Store; bus: EventBus; hosts: HostLinks; checkIns?: boolean }) {}

  start(): () => void {
    return this.deps.checkIns ? this.deps.bus.subscribeAll((e) => this.see(e)) : () => {};
  }

  private see(e: LaneEvent): void {
    if (e.type !== "tool.call" || this.deps.store.getLane(e.lane)?.state !== "working") return;
    const events = this.deps.store.eventsOfType(["agent.turn", "lane.nudged"], { lanes: [e.lane] });
    const turn = events.findLast(x => x.type === "agent.turn");
    if (turn?.type !== "agent.turn" || !turn.payload.active) return;
    const last = events.findLast(x => x.seq > turn.seq && x.type === "lane.nudged" && x.payload.kind === "checkin");
    if (Date.parse(e.at) - Date.parse(last?.at ?? turn.at) < CHECKIN_EVERY) return;
    this.deps.bus.publish(this.deps.store.appendEvent(e.lane, { type: "lane.nudged", payload: {
      kind: "checkin", text: "This turn has continued for at least 45 minutes. Recent tool activity is available in Steps.",
    } }));
  }
}
