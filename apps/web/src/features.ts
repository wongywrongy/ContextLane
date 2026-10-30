/**
 * Pages and controls that appear only once their phase is built ("tabs appear only when they
 * have something to show"). The markup for each is already in place: flip the flag when the
 * phase lands, then wire the action. See docs/IMPLEMENTATION.md.
 */
export const READY = {
  /** Phase 2: Review tab, "Send checkpoint to review", review rows in Needs you. */
  review: false,
  /** Phase 2: Run tab and the Environment block in the lane inspector. */
  run: false,
  /** Phase 3: Architecture tab. */
  architecture: false,
  /** Phase 3: Insights tab. */
  insights: false,
  /** Phase 4: hand off to another agent, fork into a new lane. */
  handoff: false,
} as const;
