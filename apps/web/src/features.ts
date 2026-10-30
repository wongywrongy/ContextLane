/**
 * Pages and controls that appear only once their phase is built ("tabs appear only when they
 * have something to show"). The markup for each is already in place: flip the flag when the
 * phase lands, then wire the action. See docs/IMPLEMENTATION.md.
 */
export const READY = {
  /** Review tab, "Send checkpoint to review", review rows in Needs you. */
  review: true,
  /** Run tab and the Environment block in the lane inspector. */
  run: true,
  /** Phase 3: Architecture tab. */
  architecture: true,
  /** Phase 3: Insights tab. */
  insights: true,
  /** Phase 4: hand off to another agent, fork into a new lane. */
  handoff: false,
} as const;
