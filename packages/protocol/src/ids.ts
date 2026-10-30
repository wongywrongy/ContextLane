import { z } from "zod";

/** Short stable ids. Projects use the repo slug; lanes use a project-local number ("01"). */
export const ProjectId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lowercase letters, digits and dashes");
export type ProjectId = z.infer<typeof ProjectId>;

export const LaneId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}\/\d{2,3}$/, "project/NN");
export type LaneId = z.infer<typeof LaneId>;

/** Six lane colours, reused for rails, badges, graph edges and the architecture overlay. */
export const LANE_COLOURS = ["lc1", "lc2", "lc3", "lc4", "lc5", "lc6"] as const;
export type LaneColour = (typeof LANE_COLOURS)[number];

export function laneId(project: ProjectId, n: number): LaneId {
  return `${project}/${String(n).padStart(2, "0")}`;
}

export function laneNumber(id: LaneId): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

export function laneColour(n: number): LaneColour {
  return LANE_COLOURS[(Math.max(1, n) - 1) % LANE_COLOURS.length]!;
}
