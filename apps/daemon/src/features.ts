import { featureOff, type Feature } from "@contextlanes/protocol";
import { LIVE_TOOLS, type ToolName } from "@contextlanes/toolbox";
import type { Config } from "./config.js";
import { Refused } from "./lanes/manager.js";

/** Routes that belong to a feature outside the core, by their registered pattern. */
const ROUTES: [RegExp, Feature][] = [
  [/^\/api\/setup\/registry(\/|$)/, "acp"],
  [/^\/api\/lanes\/:project\/:n\/(checkpoint|approve|request-changes)$/, "review"],
  [/^\/api\/projects\/:project\/checkpoints$/, "review"],
  [/^\/api\/checkpoints\//, "review"],
  [/^\/api\/projects\/:project\/(map|collisions)(\/|$)/, "architecture"],
  [/^\/api\/projects\/:project\/(insights|briefs|ask|tidy)(\/|$)/, "insights"],
  [/^\/api\/(helper|models\/local)$/, "helper"],
  [/^\/api\/setup\/model\/probe$/, "helper"],
  [/^\/api\/lanes\/:project\/:n\/(handoff|fork)$/, "handoff"],
  [/^\/api\/bench(\/|$)/, "bench"],
  [/^\/api\/schedules(\/|$)/, "schedules"],
  [/^\/api\/projects\/:project\/(outside-agents|takeover)$/, "adoption"],
];

/** Toolbox tools that belong to a feature; the rest are core. */
const TOOLS: Partial<Record<ToolName, Feature>> = {
  checkpoint: "review", get_brief: "insights", delegate: "helper",
  split_lanes: "sublanes", sublane_status: "sublanes", lanes_list: "sublanes", lane_status: "sublanes", lane_start: "sublanes", lane_send: "sublanes",
};

export function routeFeature(route: string | undefined): Feature | null {
  return route ? ROUTES.find(([pattern]) => pattern.test(route))?.[1] ?? null : null;
}

export function toolFeature(tool: string): Feature | null { return TOOLS[tool as ToolName] ?? null; }

/** Throws the refusal a request for a feature that is off gets: 404, naming the setting. */
export function requireFeature(config: Config, feature: Feature | null): void {
  if (feature && !config.features[feature]) throw new Refused(featureOff(feature), 404, "feature_off");
}

/** The tools agents are offered: live, and core or in a feature that is on. delegate is added separately while the helper works. */
export function laneTools(config: Config): ToolName[] {
  return LIVE_TOOLS.filter((tool) => { const f = toolFeature(tool); return !f || config.features[f]; });
}
