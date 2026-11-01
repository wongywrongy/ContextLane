import { z } from "zod";

export const HookEvent = z.enum(["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "Interrupt", "Notification"]);
export const HookPayload = z.object({
  hook_event_name: HookEvent, session_id: z.string().min(1).max(200), cwd: z.string().min(1).max(2048),
  transcript_path: z.string().max(4096).optional(), turn_id: z.string().max(200).optional(),
  tool_name: z.string().max(300).optional(), tool_use_id: z.string().max(300).optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(), tool_response: z.unknown().optional(),
  prompt: z.string().max(100_000).optional(), last_assistant_message: z.string().max(100_000).nullable().optional(),
  message: z.string().max(12_000).optional(), error: z.string().max(12_000).optional(),
}).passthrough();
export type HookPayload = z.infer<typeof HookPayload>;
export const HookRequest = z.object({ eventId: z.uuid(), payload: HookPayload });
export const HookAnswerQuery = z.object({ request: z.string().min(1).max(200) });
