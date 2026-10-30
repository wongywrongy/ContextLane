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
  hostUnit: z.string().nullable(),
  /** The branch this lane started from and merges back to. Older lanes have none recorded. */
  base: z.string().nullable(),
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
export const LaneEventsQuery = z.object({ after: z.coerce.number().int().nonnegative().default(0) });
export const ActivityQuery = z.object({ since: z.iso.datetime().optional() });

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

export const CheckpointRequest = z.object({ summary: z.string().trim().min(1).max(2000) });

/** A change ready for review: measured evidence only. */
export const CheckResult = z.object({ name: z.string(), passed: z.boolean(), ms: z.number(), detail: z.string() });
export type CheckResult = z.infer<typeof CheckResult>;
export const Screenshot = z.object({ path: z.string(), url: z.string().nullable(), before: z.string().nullable(), after: z.string().nullable(), note: z.string().nullable() });
export type Screenshot = z.infer<typeof Screenshot>;
export const ChangedFile = z.object({ path: z.string(), added: z.number().int(), removed: z.number().int() });
export type ChangedFile = z.infer<typeof ChangedFile>;
export const Checkpoint = z.object({
  id: z.string(),
  lane: LaneId,
  base: z.string(),
  head: z.string(),
  summary: z.string(),
  checks: z.array(CheckResult),
  screenshots: z.array(Screenshot),
  files: z.array(ChangedFile),
  plan: z.array(z.object({ text: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })),
  /** Changed files nothing in the plan mentions. */
  unplanned: z.array(z.string()),
  process: z.array(z.object({ label: z.string(), ok: z.boolean() })),
  signal: z.enum(["strong", "mixed", "weak"]),
  decision: z.enum(["approved", "changes"]).nullable(),
  prUrl: z.string().nullable(),
  createdAt: z.string(),
});
export type Checkpoint = z.infer<typeof Checkpoint>;

export const Health = z.object({ ok: z.literal(true), version: z.string(), host: z.string() });
export type Health = z.infer<typeof Health>;
