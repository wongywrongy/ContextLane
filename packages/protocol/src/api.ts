import { TestCounts } from "./testsummary.js";
import { z } from "zod";
import { LANE_COLOURS, LaneId, ProjectId } from "./ids.js";
import { LaneState } from "./states.js";
import { ServiceProposal } from "./resources.js";

export const Project = z.object({
  id: ProjectId,
  name: z.string(),
  path: z.string(),
  remote: z.string().nullable(),
  recipeHash: z.string().nullable(),
  /** Pinned projects come first on Projects; then the owner's order, then name. */
  pinned: z.boolean(),
});
export type Project = z.infer<typeof Project>;
/** Rename or pin a project. The id, path and checkouts never change. */
export const ProjectUpdate = z.object({ name: z.string().trim().min(1).max(80).optional(), pinned: z.boolean().optional() }).refine((b) => b.name !== undefined || b.pinned !== undefined, "Nothing to change.");
export const ProjectOrder = z.object({ ids: z.array(ProjectId).min(1).max(500) });
/** A lane's title. */
export const LaneRename = z.object({ task: z.string().trim().min(1).max(300) });

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
  adoption: ServiceProposal.optional(),
  /** A branch name git cannot read as an option: no leading "-", no "..", no spaces. */
  base: z.string().regex(/^(?!-)(?!.*\.\.)[\w./-]+$/, "Use a branch name").default("main"),
  /** contextlanes bench: "baseline" lanes start without project notes, get_brief or delegate. */
  baseline: z.boolean().default(false),
  /** The lane's short name in lists and its branch; derived from the task when left out (laneTitle). */
  title: z.string().trim().min(1).max(120).optional(),
});

/**
 * A short lane title from a task that may be a whole plan: its first non-empty line without markdown
 * markers, cut at a word boundary. The full task is still what the agent receives.
 */
export function laneTitle(task: string, max = 80): string {
  const lines = task.split("\n").map((l) => l.replace(/^\s*(#{1,6}\s+|[-*>+]\s+|\d+[.)]\s+)/, "").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim());
  const line = lines.find(Boolean) ?? task.trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:(\u2013-]+$/, "")}…`;
}
export type StartLaneRequest = z.input<typeof StartLaneRequest>;

/** contextlanes bench: each task runs twice from the same commit, without and with phase 3's tools. */
export const BenchTask = z.object({ project: ProjectId, base: z.string().regex(/^(?!-)(?!.*\.\.)[\w./-]+$/).default("main"), task: z.string().min(1).max(4000),
  check: z.array(z.string().min(1)).min(1).max(50), agent: z.string().default("claude-code"), model: z.string().optional(), timeoutMinutes: z.number().int().min(1).max(240).default(60) });
export const BenchRequest = z.object({ tasks: z.array(BenchTask).min(1).max(20) });
export type BenchRun = { lane: string; baseline: boolean; tokens: number | null; minutes: number | null; passed: boolean | null; state: "running" | "checking" | "done" | "failed"; detail: string | null };
export type BenchResult = { id: string; startedAt: string; finishedAt: string | null; tasks: { task: string; project: string; runs: BenchRun[] }[] };

export const AnswerRequest = z.object({ optionId: z.string().nullable(), via: z.enum(["web", "phone", "telegram", "cli"]).default("web") });
export type AnswerRequest = z.input<typeof AnswerRequest>;
export const AskOwnerRequest = z.object({ requestId: z.uuid(), question: z.string().min(1).max(10_000), options: z.array(z.string().min(1).max(200)).min(2).max(4) });
export const LaneEventsQuery = z.object({ after: z.coerce.number().int().nonnegative().default(0) });
export const ActivityQuery = z.object({ since: z.iso.datetime().optional() });

/** One thing waiting on you, derived from the event log. */
export const InboxItem = z.object({
  id: z.string(),
  lane: LaneId,
  kind: z.enum(["permission", "question", "review", "approval", "collision"]),
  title: z.string(),
  since: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string(), kind: z.string() })).default([]),
});
export type InboxItem = z.infer<typeof InboxItem>;

export const RequestChanges = z.object({ note: z.string().trim().min(1).max(10_000) });
export const CheckpointRequest = z.object({ summary: z.string().trim().min(1).max(2000) });

/** A change ready for review: measured evidence only. */
export const CheckResult = z.object({ name: z.string(), passed: z.boolean(), ms: z.number(), detail: z.string(), counts: TestCounts.nullable().optional() });
export type CheckResult = z.infer<typeof CheckResult>;
export const Screenshot = z.object({ path: z.string(), url: z.string().nullable(), before: z.string().nullable(), after: z.string().nullable(), note: z.string().nullable(),
  /** Where after differs from before, in pixels of the after picture. Null when either is missing. */
  changes: z.object({ areas: z.array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })), width: z.number(), height: z.number() }).nullable().optional() });
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
  /** Ask another agent to review (4.2): it reads the change in a read-only lane of its own. */
  secondReview: z.object({ agent: z.string(), lane: z.string(), state: z.enum(["running", "done", "failed"]), text: z.string().nullable(), at: z.string() }).nullable().optional(),
  decision: z.enum(["approved", "changes"]).nullable(),
  prUrl: z.string().nullable(),
  createdAt: z.string(),
});
export type Checkpoint = z.infer<typeof Checkpoint>;

export const Health = z.object({ ok: z.literal(true), version: z.string(), host: z.string() });
export type Health = z.infer<typeof Health>;

/** A Claude Code or Codex session in a project's folder that no lane started (Work, "Watching only"). */
export const OutsideAgent = z.object({ agent: z.enum(["claude-code", "codex"]), pid: z.number().int(), cwd: z.string(), startedAt: z.string(), running: z.boolean(), endedAt: z.string().nullable(), session: z.string().nullable() });
export type OutsideAgent = z.infer<typeof OutsideAgent>;
export const TakeOverRequest = z.object({ pid: z.number().int().positive(), startedAt: z.iso.datetime() });

/** Collisions still open in a project, for Architecture and Review. */
export type Collision = { module: string; lanes: string[]; order: string[]; files: Record<string, string[]>; reason: string; since: string; planned: boolean };
export const PlanCollisionRequest = z.object({ module: z.string().min(1).max(300), lane: LaneId });

/** The table for docs/IMPLEMENTATION.md: tokens without and with phase 3, the change, and checks passed. */
export function benchTable(r: BenchResult): string {
  const rows = r.tasks.map((t) => {
    const off = t.runs.find((x) => x.baseline); const on = t.runs.find((x) => !x.baseline);
    const change = off?.tokens && on?.tokens ? `${Math.round((1 - on.tokens / off.tokens) * 100)}% fewer` : "–";
    const pass = (x?: BenchRun) => x?.passed === null || x?.passed === undefined ? "–" : x.passed ? "passed" : "failed";
    return `| ${t.task.split("\n")[0]!.slice(0, 60)} | ${off?.tokens ?? "–"} | ${on?.tokens ?? "–"} | ${change} | ${pass(off)} / ${pass(on)} |`;
  });
  const sum = (b: boolean) => r.tasks.reduce((n, t) => n + (t.runs.find((x) => x.baseline === b)?.tokens ?? 0), 0);
  const off = sum(true), on = sum(false);
  return ["| Task | Tokens without | Tokens with | Change | Check (without / with) |", "|---|---|---|---|---|", ...rows,
    `| **All** | ${off} | ${on} | ${off && on ? `${Math.round((1 - on / off) * 100)}% fewer` : "–"} | |`].join("\n");
}

/** Hand off (another agent), fresh session (same agent) or fork (a new lane from this one). */
export const HandoffRequest = z.object({ agent: z.string().min(1).max(60).optional(), model: z.string().max(200).optional(), note: z.string().max(2000).optional() });
export const SecondReviewRequest = z.object({ agent: z.string().min(1).max(60) });
