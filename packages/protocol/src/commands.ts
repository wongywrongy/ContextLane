import { z } from "zod";

export const AgentSpec = z.object({ command: z.string().min(1), args: z.array(z.string().refine((arg) => !/^--(?:dangerously|bypass|yolo|full-auto|auto(?:$|=)|auto-approve|approval-policy=never)/i.test(arg), "approval-bypassing arguments are not available")).default([]), env: z.record(z.string(), z.string()).optional() });
export type AgentSpec = z.infer<typeof AgentSpec>;
export const SafeMode = z.string().min(1).max(100).refine((mode) => !/bypass|danger|full.access|yolo|auto.?approv|auto.?review|^(agent|auto|dontask|never)$/i.test(mode), "approval-bypassing modes are not available");
const WorktreePath = z.string().min(1).max(512).refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "a path inside the lane's checkout");
const ImageType = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** What the composer sends: text, files from the worktree (@ file) and pictures (Attach image), as base64. */
export const PromptRequest = z.object({ text: z.string().min(1).max(100_000), immediate: z.boolean().default(false),
  files: z.array(WorktreePath).max(10).default([]),
  images: z.array(z.object({ mimeType: ImageType, data: z.base64().max(7_000_000) })).max(3).default([]) });
/** The same prompt as the lane host receives it: pictures are files it can read, not bytes in the event log. */
export const PromptCommand = z.object({ text: z.string().min(1).max(100_000), immediate: z.boolean().default(false),
  files: z.array(WorktreePath).max(10).default([]),
  images: z.array(z.object({ mimeType: ImageType, path: z.string().startsWith("/") })).max(3).default([]) });
export const ModeRequest = z.object({ mode: SafeMode });
export const ModelRequest = z.object({ model: z.string().min(1).max(200) });
export const LaneCommand = z.discriminatedUnion("kind", [
  PromptCommand.extend({ kind: z.literal("prompt") }),
  z.object({ kind: z.literal("cancel") }),
  ModeRequest.extend({ kind: z.literal("mode") }),
  ModelRequest.extend({ kind: z.literal("model") }),
  z.object({ kind: z.literal("answer"), requestId: z.string(), optionId: z.string().nullable() }),
]);
export type LaneCommand = z.infer<typeof LaneCommand>;
export const CommandEnvelope = z.object({ commandId: z.uuid(), command: LaneCommand });
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;

export const FileQuery = z.object({ q: z.string().max(200).default("") });
