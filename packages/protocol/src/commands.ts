import { z } from "zod";

export const AgentSpec = z.object({ command: z.string().min(1), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).optional() });
export type AgentSpec = z.infer<typeof AgentSpec>;
export const SafeMode = z.string().min(1).max(100).refine((mode) => !/bypass|danger|full.access|yolo|auto.?approv|auto.?review|^(agent|auto|dontask|never)$/i.test(mode), "approval-bypassing modes are not available");
export const PromptRequest = z.object({ text: z.string().min(1).max(100_000), immediate: z.boolean().default(false) });
export const ModeRequest = z.object({ mode: SafeMode });
export const ModelRequest = z.object({ model: z.string().min(1).max(200) });
export const LaneCommand = z.discriminatedUnion("kind", [
  PromptRequest.extend({ kind: z.literal("prompt") }),
  z.object({ kind: z.literal("cancel") }),
  ModeRequest.extend({ kind: z.literal("mode") }),
  ModelRequest.extend({ kind: z.literal("model") }),
  z.object({ kind: z.literal("answer"), requestId: z.string(), optionId: z.string().nullable() }),
]);
export type LaneCommand = z.infer<typeof LaneCommand>;
export const CommandEnvelope = z.object({ commandId: z.uuid(), command: LaneCommand });
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;
