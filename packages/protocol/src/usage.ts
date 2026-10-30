import { z } from "zod";
import { LaneId, ProjectId } from "./ids.js";

const tokens = z.number().int().nonnegative();
export const TokenUsage = z.object({
  inputTokens: tokens.nullable(),
  outputTokens: tokens.nullable(),
  cacheReadTokens: tokens.nullable(),
  cacheWriteTokens: tokens.nullable(),
});
export const TurnUsage = TokenUsage.extend({
  turnId: z.uuid(), sessionId: z.string().min(1),
  source: z.enum(["acp", "claude-log", "codex-log"]),
  costUsd: z.number().nonnegative().optional(),
  costSource: z.literal("acp").optional(),
});
export type TurnUsage = z.infer<typeof TurnUsage>;
export const UsageQuery = z.object({ project: ProjectId.optional(), since: z.iso.datetime().transform((value) => new Date(value).toISOString()).optional() });
export const UsageLimit = z.object({
  window: z.enum(["5h", "7d"]), usedPct: z.number().min(0).max(100), resetsAt: z.iso.datetime(), source: z.literal("acp"),
});
const totals = TokenUsage.extend({ turns: tokens, costUsd: z.number().nonnegative().nullable(), costTurns: tokens });
export const UsageSummary = z.object({
  lanes: z.array(totals.extend({ lane: LaneId })),
  days: z.array(totals.extend({ day: z.string() })),
  limits: z.array(UsageLimit.extend({ agent: z.string() })),
});
export type UsageSummary = z.infer<typeof UsageSummary>;
