import { z } from "zod";

export const TerminalSize = z.object({
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(200),
});
export type TerminalSize = z.infer<typeof TerminalSize>;

/** Browser → daemon. Daemon → browser is raw UTF-8 terminal output. */
export const TerminalInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(16_384) }),
  TerminalSize.extend({ type: z.literal("resize") }),
]);
export type TerminalInput = z.infer<typeof TerminalInput>;
