import { z } from "zod";

/**
 * A lane's lifecycle. It waits on you only when it asks (needs_you) and at review (in_review).
 * paused and archived sit outside the main path.
 */
export const LaneState = z.enum([
  "draft",
  "setting_up",
  "working",
  "needs_you",
  "in_review",
  "merged",
  "cleaned",
  "failed",
  "paused",
  "archived",
]);
export type LaneState = z.infer<typeof LaneState>;

const NEXT: Record<LaneState, readonly LaneState[]> = {
  draft: ["setting_up", "archived"],
  setting_up: ["working", "failed", "archived"],
  working: ["needs_you", "in_review", "failed", "paused", "archived"],
  needs_you: ["working", "failed", "paused", "archived"],
  in_review: ["working", "merged", "archived"],
  merged: ["cleaned"],
  cleaned: ["archived"],
  failed: ["setting_up", "working", "archived"],
  paused: ["working", "archived"],
  archived: [],
};

export function canTransition(from: LaneState, to: LaneState): boolean {
  return NEXT[from].includes(to);
}

/** States that put the lane in your inbox. */
export function waitsOnOwner(state: LaneState): boolean {
  return state === "needs_you" || state === "in_review";
}
