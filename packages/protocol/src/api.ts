import { z } from "zod";
import { LANE_COLOURS, LaneId, ProjectId } from "./ids.js";
import { LaneState } from "./states.js";

export const Project = z.object({
  id: ProjectId,
  name: z.string(),
  path: z.string(),
  remote: z.string().nullable(),
  recipeHash: z.string().nullable(),
});
export type Project = z.infer<typeof Project>;

export const Lane = z.object({
  id: LaneId,
  project: ProjectId,
  goal: z.string().nullable(),
  task: z.string(),
  agent: z.string(),
  model: z.string().nullable(),
  mode: z.enum(["ask", "edits", "plan"]),
  branch: z.string(),
  worktree: z.string(),
  terminal: z.string(),
  state: LaneState,
  colour: z.enum(LANE_COLOURS),
  createdAt: z.string(),
});
export type Lane = z.infer<typeof Lane>;

export const AddProjectRequest = z.object({ path: z.string().min(1), name: z.string().optional() });
export type AddProjectRequest = z.infer<typeof AddProjectRequest>;

export const StartLaneRequest = z.object({
  project: ProjectId,
  task: z.string().min(1),
  agent: z.string().default("claude-code"),
  model: z.string().optional(),
  mode: z.enum(["ask", "edits", "plan"]).default("ask"),
  goal: z.string().optional(),
  base: z.string().default("main"),
});
export type StartLaneRequest = z.input<typeof StartLaneRequest>;

export const AnswerRequest = z.object({ optionId: z.string().nullable(), via: z.enum(["web", "phone", "telegram", "cli"]).default("web") });
export type AnswerRequest = z.input<typeof AnswerRequest>;
export const AskOwnerRequest = z.object({ requestId: z.uuid(), question: z.string().min(1).max(10_000), options: z.array(z.string().min(1).max(200)).min(2).max(4) });

/** One thing waiting on you, derived from the event log. */
export const InboxItem = z.object({
  id: z.string(),
  lane: LaneId,
  kind: z.enum(["permission", "question", "review", "approval"]),
  title: z.string(),
  since: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string(), kind: z.string() })).default([]),
});
export type InboxItem = z.infer<typeof InboxItem>;

export const Health = z.object({ ok: z.literal(true), version: z.string(), host: z.string() });
export type Health = z.infer<typeof Health>;
