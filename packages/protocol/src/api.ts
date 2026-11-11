import { TestCounts } from "./testsummary.js";
import { z } from "zod";
import { LANE_COLOURS, LaneId, ProjectId } from "./ids.js";
import { LaneState } from "./states.js";
import { ServiceProposal } from "./resources.js";

/** Who owns a project's folder on the host. Read once when it is added (v4, Docker); git on it runs as this user. */
export const ProjectOwner = z.object({ uid: z.number().int().min(0).max(4_294_967_294), gid: z.number().int().min(0).max(4_294_967_294) });
export type ProjectOwner = z.infer<typeof ProjectOwner>;

export const Project = z.object({
  id: ProjectId,
  name: z.string(),
  path: z.string(),
  remote: z.string().nullable(),
  recipeHash: z.string().nullable(),
  /** Pinned projects come first on Projects; then the owner's order, then name. */
  pinned: z.boolean(),
  /** Set in the Docker runtime; null for projects added by the host runtime, which runs git as itself. */
  owner: ProjectOwner.nullable().optional(),
});
export type Project = z.infer<typeof Project>;
/** Rename or pin a project. The id, path and checkouts never change. */
export const ProjectUpdate = z.object({ name: z.string().trim().min(1).max(80).optional(), pinned: z.boolean().optional() }).refine((b) => b.name !== undefined || b.pinned !== undefined, "Nothing to change.");
export const ProjectOrder = z.object({ ids: z.array(ProjectId).min(1).max(500) });
/** Delete a lane: its agent, services, terminal and checkout go; its branch only when asked. */
export const DiscardLane = z.object({ deleteBranch: z.boolean().default(false) });
export type DiscardPreview = { uncommitted: number; commits: number; branch: string; worktree: string; present: boolean };
/** A lane's title. */
/** The CLI's check that the daemon on the port can read the setup token, before it sends that token. */
export const ProveRequest = z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/) });

/** Whether the lane's agent host is on the daemon's socket right now, and whether it was started recently. */
export const AgentLink = z.object({ connected: z.boolean(), starting: z.boolean() });
export type AgentLink = z.infer<typeof AgentLink>;

export const LaneRename = z.object({ task: z.string().trim().min(1).max(300) });

export const LaneKind = z.enum(["cli", "shell", "acp"]);
export type LaneKind = z.infer<typeof LaneKind>;

export const Lane = z.object({
  id: LaneId,
  project: ProjectId,
  goal: z.string().nullable(),
  task: z.string(),
  agent: z.string(),
  /** cli: the agent's own CLI in the lane's terminal. shell: no agent; you or your own agent work in it. acp: an agent over ACP (frozen). */
  kind: LaneKind.default("acp"),
  direct: z.boolean().default(false),
  remoteControl: z.boolean().default(false),
  model: z.string().nullable(),
  mode: z.enum(["ask", "edits", "plan"]),
  /** Auto mode: ContextLanes approves the agent's requests except the dire ones (guard.ts), which wait for you. */
  auto: z.boolean().default(false),
  /** How hard the agent thinks, when the lane started with a choice: low, medium or high. */
  effort: z.string().nullable().optional(),
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
/** Only measured facts for a board card; absent reporting stays null. */
export type BoardLane = { lane: Lane; mergedAt: string | null; contextPct: number | null; verdict: "merge" | "fix first" | "do not merge" | null; preview: string | null };

export const AddProjectRequest = z.object({ path: z.string().min(1), name: z.string().optional() });
export type AddProjectRequest = z.infer<typeof AddProjectRequest>;

/** Reasoning effort as the owner picks it; the lane host maps it onto the agent's own levels. */
export const Effort = z.enum(["low", "medium", "high"]);
export type Effort = z.infer<typeof Effort>;

export const StartLaneRequest = z.object({
  project: ProjectId,
  task: z.string().min(1),
  agent: z.string().default("claude-code"),
  kind: LaneKind.optional(),
  direct: z.boolean().default(false),
  remoteControl: z.boolean().default(false),
  cliArgs: z.array(z.string().max(64_000)).max(100).optional(),
  model: z.string().optional(),
  mode: z.enum(["ask", "edits", "plan"]).default("ask"),
  auto: z.boolean().default(false),
  effort: Effort.optional(),
  goal: z.string().optional(),
  adoption: ServiceProposal.optional(),
  /** A branch name git cannot read as an option: no leading "-", no "..", no spaces. */
  base: z.string().regex(/^(?!-)(?!.*\.\.)[\w./-]+$/, "Use a branch name").default("main"),
  /**
   * Work on this existing branch instead of making a new lane/NN-… branch off `base`. The lane checks it
   * out in its own folder, so it must not be open anywhere else (git allows a branch in one place at a time).
   */
  branch: z.string().regex(/^(?!-)(?!.*\.\.)[\w./-]+$/, "Use a branch name").max(200).optional(),
  /** contextlanes bench: "baseline" lanes start without ContextLanes notes, briefs or MCP tools. */
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

/** contextlanes bench: each task runs twice from one pinned commit, without and with ContextLanes enhancers. */
export const BenchTask = z.object({ project: ProjectId, base: z.string().regex(/^(?!-)(?!.*\.\.)[\w./-]+$/).default("main"), task: z.string().min(1).max(4000),
  check: z.array(z.string().min(1)).min(1).max(50), kind: z.enum(["cli", "acp"]).optional(), agent: z.string().default("claude-code"), model: z.string().optional(), timeoutMinutes: z.number().int().min(1).max(240).default(60) });
export const BenchRequest = z.object({ tasks: z.array(BenchTask).min(1).max(20) });
export type BenchRun = { lane: string | null; baseline: boolean; tokens: number | null; minutes: number | null; passed: boolean | null; state: "running" | "checking" | "done" | "failed"; detail: string | null };
export type BenchResult = { id: string; startedAt: string; finishedAt: string | null; tasks: { task: string; project: string; base?: string; agent?: string; model?: string | null; kind?: "cli" | "acp"; runs: BenchRun[] }[] };

/** Auto mode for a lane; only the owner's token can change it. */
export const AutoRequest = z.object({ on: z.boolean() });
export const AnswerRequest = z.object({ optionId: z.string().nullable(), via: z.enum(["web", "phone", "telegram", "cli"]).default("web"), message: z.string().max(4000).optional() });
export type AnswerRequest = z.input<typeof AnswerRequest>;
/** split_lanes: the agent proposes 2 to 5 parallel sub-lanes; the owner says yes once for all of them. */
export const SplitLanesRequest = z.object({ requestId: z.uuid(), why: z.string().trim().min(1).max(1000),
  lanes: z.array(z.object({ title: z.string().trim().min(3).max(100), task: z.string().trim().min(10).max(8000) })).min(2).max(5) });
const Branch = z.string().regex(/^(?!-)(?!.*\.\.)[\w./-]+$/).max(200);
export const LaneStartRequest = z.object({ requestId: z.uuid(), task: z.string().trim().min(1).max(8000), agent: z.string().min(1).max(100).optional(), base: Branch.optional() });
export const LaneTarget = z.object({ lane: LaneId });
export const LaneSendRequest = LaneTarget.extend({ text: z.string().trim().min(1).max(100_000) });
export const SublaneProposal = z.object({ requestId: z.uuid(), why: z.string().min(1).max(1000), lanes: z.array(z.object({ title: z.string().min(1).max(100), task: z.string().min(1).max(8000), agent: z.string().min(1).max(100).optional(), base: Branch.optional() })).min(1).max(5) });
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

export const ReviewComment = z.object({ file: z.string().min(1).max(512), line: z.number().int().positive().nullable(), side: z.enum(["old", "new"]).default("new"), quote: z.string().max(4000), text: z.string().trim().min(1).max(2000) });
export type ReviewComment = z.infer<typeof ReviewComment>;
export const RequestChanges = z.object({ note: z.string().trim().max(10_000).default(""), comments: z.array(ReviewComment).max(50).default([]) }).refine((v) => !!v.note || v.comments.length > 0, "Add a note or a comment.").refine((v) => reviewMessage(v.note, v.comments).length <= 100_000, "Keep the complete request under 100,000 characters.");
export function reviewMessage(note: string, comments: ReviewComment[]): string {
  return [note, ...comments.map((c) => `${c.file}${c.line ? `:${c.line}` : ""}${c.side === "old" ? " (before)" : ""}\n${c.quote ? `${c.quote.split("\n").map((line) => `> ${line}`).join("\n")}\n` : ""}${c.text}`)].filter(Boolean).join("\n\n");
}
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
export const JudgeFinding = z.object({ severity: z.enum(["blocker", "should fix", "nit"]), file: z.string(), line: z.number().int().positive().nullable(), text: z.string() });
export type JudgeFinding = z.infer<typeof JudgeFinding>;
/** running: reading the change. done: verdict written. failed: the model did not answer usably. off: no local model for it. */
export const CheckpointJudge = z.object({ state: z.enum(["running", "done", "failed", "off"]), model: z.string().nullable(), verdict: z.enum(["merge", "fix first", "do not merge"]).nullable(),
  headline: z.string().nullable(), findings: z.array(JudgeFinding), error: z.string().nullable(), at: z.string(),
  /** Files the judge did not read (too large, generated or lockfiles). */
  skipped: z.array(z.string()).default([]) });
export type CheckpointJudge = z.infer<typeof CheckpointJudge>;
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
  /** The local judge's read of the change: a verdict and the few things to look at, each on a changed file. */
  judge: CheckpointJudge.nullable().optional(),
  decision: z.enum(["approved", "changes"]).nullable(),
  prUrl: z.string().nullable(),
  createdAt: z.string(),
});
export type Checkpoint = z.infer<typeof Checkpoint>;

export const Health = z.object({ ok: z.literal(true), version: z.string(), host: z.string(), sandbox: z.enum(["bwrap", "off"]).optional(), runtime: z.literal("docker").optional() });
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
    const change = off?.tokens !== null && off?.tokens !== undefined && off.tokens > 0 && on?.tokens !== null && on?.tokens !== undefined ? `${Math.round((1 - on.tokens / off.tokens) * 100)}% fewer` : "–";
    const pass = (x?: BenchRun) => x?.passed === null || x?.passed === undefined ? "–" : x.passed ? "passed" : "failed";
    return `| ${t.task.split("\n")[0]!.slice(0, 60)} | ${off?.tokens ?? "–"} | ${on?.tokens ?? "–"} | ${change} | ${pass(off)} / ${pass(on)} |`;
  });
  const sum = (b: boolean) => {
    const values = r.tasks.map(t => t.runs.find(x => x.baseline === b)?.tokens);
    return values.length && values.every((v): v is number => v !== null && v !== undefined) ? values.reduce((a, b) => a + b, 0) : null;
  };
  const off = sum(true), on = sum(false);
  return ["| Task | Tokens without | Tokens with | Change | Check (without / with) |", "|---|---|---|---|---|", ...rows,
    `| **All** | ${off ?? "–"} | ${on ?? "–"} | ${off !== null && off > 0 && on !== null ? `${Math.round((1 - on / off) * 100)}% fewer` : "–"} | |`].join("\n");
}

/** Hand off (another agent), fresh session (same agent) or fork (a new lane from this one). */
export const HandoffRequest = z.object({ agent: z.string().min(1).max(60).optional(), model: z.string().max(200).optional(), note: z.string().max(2000).optional() });
export const SecondReviewRequest = z.object({ agent: z.string().min(1).max(60) });
