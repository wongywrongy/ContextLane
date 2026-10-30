import { TestCounts } from "./testsummary.js";
import { z } from "zod";
import { TurnUsage, UsageLimit } from "./usage.js";
import { ServiceProposal } from "./resources.js";
import { LaneId } from "./ids.js";
import { LaneState } from "./states.js";
import { LaneCommand } from "./commands.js";
import { NotificationChannel } from "./notifications.js";
import { ServiceState } from "./recipe.js";

/**
 * Everything that happens is an event in one append-only log. Pages, the inbox, the CLI
 * and insights are all queries over it. Payloads stay small; big outputs live in files.
 */

/** ACP tool kinds plus our own, grouped into six visual families on screen. */
export const StepKind = z.enum([
  "read", "search", "fetch",            // look
  "edit", "delete", "move",             // change
  "execute", "test", "environment",     // run
  "plan", "think",                      // mind
  "permission", "question", "checkpoint", // you
  "handoff", "subagent", "helper",      // team
  "other",
]);
export type StepKind = z.infer<typeof StepKind>;

export const STEP_FAMILY: Record<StepKind, "look" | "change" | "run" | "mind" | "you" | "team"> = {
  read: "look", search: "look", fetch: "look", other: "look",
  edit: "change", delete: "change", move: "change",
  execute: "run", test: "run", environment: "run",
  plan: "mind", think: "mind",
  permission: "you", question: "you", checkpoint: "you",
  handoff: "team", subagent: "team", helper: "team",
};

export const PermissionOption = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
});
export type PermissionOption = z.infer<typeof PermissionOption>;
const diffStat = z.object({ added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() });
const testResult = z.object({ name: z.string(), passed: z.boolean() });

const payloads = {
  "lane.renamed": z.object({ from: z.string(), task: z.string() }),
  "lane.created": z.object({ task: z.string(), agent: z.string(), branch: z.string(), worktree: z.string(), baseline: z.boolean().optional() }),
  "lane.state": z.object({ from: LaneState, to: LaneState, reason: z.string().optional() }),
  "agent.plan": z.object({ entries: z.array(z.object({ text: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })) }),
  "agent.thought": z.object({ text: z.string() }),
  "agent.message": z.object({ text: z.string(), role: z.enum(["agent", "user"]), files: z.array(z.string()).optional(), images: z.number().int().optional() }),
  "agent.command": z.object({ commandId: z.uuid(), command: LaneCommand }),
  "agent.command.result": z.object({ commandId: z.uuid(), ok: z.boolean(), error: z.string().optional() }),
  "agent.session": z.object({
    sessionId: z.string(), currentMode: z.string().optional(), currentModel: z.string().optional(),
    modes: z.array(z.object({ id: z.string(), label: z.string() })),
    models: z.array(z.object({ id: z.string(), label: z.string() })),
    /** Slash commands the agent offers (ACP available_commands_update); sent as "/name args". */
    commands: z.array(z.object({ name: z.string(), description: z.string() })).optional(),
    /** Whether the agent takes pictures in a prompt (ACP promptCapabilities.image). */
    images: z.boolean().optional(),
  }),
  "agent.turn": z.object({ active: z.boolean(), stopReason: z.string().optional(), commandId: z.uuid().optional() }),
  "agent.error": z.object({ message: z.string() }),
  "notification.sent": z.object({ requestId: z.string(), channel: NotificationChannel, target: z.string().default("") }),
  "notification.failed": z.object({ requestId: z.string(), channel: NotificationChannel, message: z.string() }),
  "tool.call": z.object({ callId: z.string(), kind: StepKind, title: z.string(), files: z.array(z.string()).default([]), status: z.enum(["pending", "in_progress", "completed", "failed"]).optional(), summary: z.string().optional(), diff: diffStat.optional(), tests: z.array(testResult).optional(), counts: TestCounts.optional() }),
  "tool.update": z.object({ callId: z.string(), status: z.enum(["pending", "in_progress", "completed", "failed"]).optional(), title: z.string().optional(), kind: StepKind.optional(), files: z.array(z.string()).optional(), summary: z.string().optional(), diff: diffStat.optional(), tests: z.array(testResult).optional(), counts: TestCounts.optional() }),
  "permission.requested": z.object({ requestId: z.string(), title: z.string(), detail: z.string().optional(), options: z.array(PermissionOption), kind: z.enum(["permission", "question"]).optional() }),
  "permission.answered": z.object({ requestId: z.string(), optionId: z.string().nullable(), by: z.enum(["web", "phone", "telegram", "cli"]) }),
  "recipe.requested": z.object({ hash: z.string() }),
  "recipe.approved": z.object({ hash: z.string() }),
  "env.status": z.object({ service: z.string(), up: z.boolean(), port: z.number().int().optional(), url: z.string().optional(), state: ServiceState.optional(), detail: z.string().optional() }),
  "service.proposed": ServiceProposal,
  "check.result": z.object({ name: z.string(), passed: z.boolean(), detail: z.string().optional() }),
  "checkpoint.created": z.object({ checkpointId: z.string(), summary: z.string(), head: z.string() }),
  /** The approved checkpoint was rebased or merged onto its base; a retry after a failed push continues from this head. */
  "checkpoint.updated": z.object({ checkpointId: z.string(), head: z.string() }),
  "checkpoint.decided": z.object({ checkpointId: z.string(), decision: z.enum(["approved", "changes"]), note: z.string().optional(), prUrl: z.string().optional() }),
  /** Two or more open lanes changed one module. `order` is the suggested merge order; the rest wait. */
  "collision.detected": z.object({ module: z.string(), lanes: z.array(z.string()), files: z.record(z.string(), z.array(z.string())), order: z.array(z.string()), reason: z.string() }),
  /** The lane's agent session was replaced: a fresh session of the same agent, or another agent, starting from a handoff. */
  "lane.handoff": z.object({ from: z.string(), to: z.string(), model: z.string().nullable(), chars: z.number().int(), file: z.string() }),
  "lane.forked": z.object({ from: z.string(), to: z.string() }),
  "collision.cleared": z.object({ module: z.string(), lanes: z.array(z.string()) }),
  /** The owner asked for a note to this lane once `first` merges. `delivered` once sent. */
  "collision.planned": z.object({ module: z.string(), first: z.string(), message: z.string() }),
  "collision.told": z.object({ module: z.string(), first: z.string() }),
  "helper.delegated": z.object({ kind: z.enum(["read", "edit", "check"]), model: z.string(), tokensSaved: z.number().int().nonnegative(),
    task: z.string().optional(), files: z.array(z.string()).optional(), resultTokens: z.number().int().optional(), ms: z.number().optional() }),
  /** The lead redid a delegation's work (read the files itself, reran the checks, or never applied the patch). */
  "helper.redone": z.object({ seq: z.number().int(), kind: z.enum(["read", "edit", "check"]) }),
  "usage": z.object({ contextUsed: z.number().int().nonnegative(), contextSize: z.number().int().nonnegative(), costUsd: z.number().nonnegative().optional(), source: z.literal("acp").default("acp") }),
  "usage.turn": TurnUsage,
  "usage.limit": UsageLimit,
  "usage.compaction": z.object({ sessionId: z.string().min(1), compactionId: z.string().min(1), source: z.literal("acp") }),
} as const;

export type EventType = keyof typeof payloads;
export const EVENT_TYPES = Object.keys(payloads) as EventType[];

export type EventPayload<T extends EventType> = z.infer<(typeof payloads)[T]>;

/** An event as stored and streamed. seq is per lane and gap-free. */
export const LaneEvent = z.discriminatedUnion(
  "type",
  EVENT_TYPES.map((type) =>
    z.object({
      lane: LaneId,
      seq: z.number().int().positive(),
      at: z.string(),
      type: z.literal(type),
      payload: payloads[type],
    }),
  ) as unknown as [z.ZodObject, ...z.ZodObject[]],
);
export type LaneEvent = { [T in EventType]: { lane: LaneId; seq: number; at: string; type: T; payload: EventPayload<T> } }[EventType];

/** An event before the store assigns seq and time. */
export type NewLaneEvent = { [T in EventType]: { type: T; payload: EventPayload<T> } }[EventType];

export const NewLaneEvent = z.discriminatedUnion("type", EVENT_TYPES.map((type) =>
  z.object({ type: z.literal(type), payload: payloads[type] }),
) as unknown as [z.ZodObject, ...z.ZodObject[]]);

/** Hosts report agent observations; only the daemon may write owner decisions and commands. */
export const HostEvent = z.object({ eventId: z.uuid(), event: NewLaneEvent }).refine(({ event }) => {
  return ["agent.plan", "agent.thought", "agent.message", "agent.session", "agent.turn", "agent.error", "agent.command.result", "tool.call", "tool.update", "permission.requested", "usage", "usage.turn", "usage.limit", "usage.compaction"].includes(String(event.type)) &&
    (event.type !== "agent.message" || (event.payload as { role: string }).role === "agent");
}, "hosts may only report agent observations");

export function parsePayload<T extends EventType>(type: T, payload: unknown): EventPayload<T> {
  return payloads[type].parse(payload) as EventPayload<T>;
}
