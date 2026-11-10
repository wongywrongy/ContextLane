/**
 * Features outside the core, each off until the owner turns it on in config ([features] name = true).
 * A feature that is off registers no working routes, starts no background work and offers agents no tools.
 */
export const FEATURES = {
  acp: "ACP lanes for agents other than Claude Code and Codex, with the agent registry",
  review: "Checkpoints: checks, screenshots, the review judge, second reviews, approve and merge",
  architecture: "The code map, the Architecture page and collision warnings",
  insights: "Insights, module briefs, Ask, Tidy and nudges",
  helper: "The local-model helper agents can delegate to, and the local model endpoints",
  sublanes: "Agents splitting their work into child lanes",
  handoff: "Handing a lane to another agent, and forking it",
  bench: "Comparing token use with and without ContextLanes",
  schedules: "Lanes that start on a schedule",
  adoption: "Finding servers started outside ContextLanes and adopting them into lanes",
} as const;
export type Feature = keyof typeof FEATURES;
export type Features = Record<Feature, boolean>;
export const FEATURE_NAMES = Object.keys(FEATURES) as Feature[];

/** The sentence a refused request carries. */
export function featureOff(feature: Feature): string {
  return `${FEATURES[feature]} is turned off. Turn it on with [features] ${feature} = true in ~/.config/contextlanes/config.toml and restart ContextLanes.`;
}
