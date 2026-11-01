import type { BoardLane } from "@contextlanes/protocol";
import type { Store } from "./db/store.js";

export function boardLanes(store: Store, project?: string): BoardLane[] {
  return store.listLanes(project).map(lane => {
    const merged = store.eventsOfType(["lane.state"], { lanes: [lane.id] }).findLast(e => e.payload.to === "merged");
    const usage = store.eventsOfType(["usage"], { lanes: [lane.id] }).at(-1)?.payload;
    const preview = store.environment(lane.id)?.services.find(s => s.state === "healthy" && s.url)?.url ?? null;
    return { lane, mergedAt: merged?.at ?? null, contextPct: usage && usage.contextSize > 0 ? Math.min(100, Math.round(100 * usage.contextUsed / usage.contextSize)) : null, verdict: store.latestCheckpoint(lane.id)?.judge?.verdict ?? null, preview };
  });
}
