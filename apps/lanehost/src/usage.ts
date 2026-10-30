import { createReadStream } from "node:fs";
import { glob, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { TokenUsage, UsageLimit } from "@contextlanes/protocol";

const count = z.number().int().nonnegative();
const claudeUsage = z.object({ input_tokens: count, output_tokens: count, cache_read_input_tokens: count.optional(), cache_creation_input_tokens: count.optional() });
const codexUsage = z.object({ input_tokens: count, output_tokens: count, cached_input_tokens: count, cache_write_input_tokens: count.optional() });
type Tokens = z.infer<typeof TokenUsage>;
const zero = (): Tokens => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const rateWindow = z.object({ utilization: z.number().min(0).max(1), resetsAt: z.number().int().nonnegative().max(8.64e12) });

/** Claude forwards the provider's optional fields; an omitted utilization is never zero. */
export function reportedLimits(meta: Record<string, unknown> | null | undefined): z.infer<typeof UsageLimit>[] {
  const envelope = z.object({ rateLimitType: z.string().optional(), unifiedWindows: z.record(z.string(), z.unknown()).optional() }).safeParse(meta?.["_claude/rateLimit"]);
  if (!envelope.success) return [];
  const limits: z.infer<typeof UsageLimit>[] = [];
  for (const [key, window] of [["five_hour", "5h"], ["seven_day", "7d"]] as const) {
    const value = envelope.data.unifiedWindows?.[key] ?? (envelope.data.rateLimitType === key ? meta?.["_claude/rateLimit"] : undefined);
    const parsed = rateWindow.safeParse(value);
    if (parsed.success) {
      const limit = UsageLimit.safeParse({ window, usedPct: parsed.data.utilization * 100, resetsAt: new Date(parsed.data.resetsAt * 1000).toISOString(), source: "acp" });
      if (limit.success) limits.push(limit.data);
    }
  }
  return limits;
}

/** Only read the exact native session, and verify its working directory before counting anything. */
export class SessionUsage {
  private file?: string;
  constructor(private agent: string | undefined, private cwd: string, private sessionId: string, private env: NodeJS.ProcessEnv = process.env) {}

  async read(): Promise<{ source: "claude-log" | "codex-log"; tokens: Tokens } | null> {
    if (!this.agent || !/^[\w-]+$/.test(this.sessionId) || !["claude-code", "codex"].includes(this.agent)) return null;
    try {
      if (!this.file) {
        const pattern = this.agent === "claude-code"
          ? join(this.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects", "*", `${this.sessionId}.jsonl`)
          : join(this.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions", "**", `rollout-*-${this.sessionId}.jsonl`);
        const files: string[] = [];
        for await (const file of glob(pattern)) files.push(file);
        // Ambiguous matches are not evidence that either log belongs to this lane.
        if (files.length !== 1) return null;
        this.file = files[0];
      }
      // shortcut: logs above 64 MiB are omitted; add incremental reading if real lanes reach this size.
      const { size } = await stat(this.file!);
      if (!size || size > 64 * 1024 * 1024) return null;
      const lines = createInterface({ input: createReadStream(this.file!, { end: size - 1 }), crlfDelay: Infinity });
      const messages = new Map<string, Tokens>();
      let matched = false, total: Tokens | null = null;
      for await (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch { continue; } // A writer may not have finished its last line.
        if (!row || typeof row !== "object") continue;
        if (this.agent === "claude-code") {
          if (row.cwd !== this.cwd || row.sessionId !== this.sessionId || row.type !== "assistant" || typeof row.message?.id !== "string") continue;
          const parsed = claudeUsage.safeParse(row.message.usage);
          if (!parsed.success) continue;
          matched = true;
          const u = parsed.data;
          messages.set(row.message.id, { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens ?? null, cacheWriteTokens: u.cache_creation_input_tokens ?? null });
        } else {
          if (row.type === "session_meta") matched = row.payload?.id === this.sessionId && row.payload?.cwd === this.cwd;
          if (!matched || row.type !== "event_msg" || row.payload?.type !== "token_count") continue;
          const parsed = codexUsage.safeParse(row.payload.info?.total_token_usage);
          if (!parsed.success) continue;
          const u = parsed.data;
          total = { inputTokens: Math.max(0, u.input_tokens - u.cached_input_tokens - (u.cache_write_input_tokens ?? 0)), outputTokens: u.output_tokens, cacheReadTokens: u.cached_input_tokens, cacheWriteTokens: u.cache_write_input_tokens ?? null };
        }
      }
      if (!matched) return null;
      if (this.agent === "codex") return total ? { source: "codex-log", tokens: total } : null;
      const tokens: Record<keyof Tokens, number | null> = zero();
      for (const usage of messages.values()) for (const key of Object.keys(tokens) as (keyof Tokens)[]) {
        const before = tokens[key], value = usage[key];
        tokens[key] = before === null || value === null ? null : before + value;
      }
      return { source: "claude-log", tokens: TokenUsage.parse(tokens) };
    } catch (err) {
      console.error("Usage log unavailable:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }
}

export function usageDelta(after: Tokens, before?: Tokens): Tokens | null {
  const result: Record<keyof Tokens, number | null> = { ...after };
  for (const key of Object.keys(result) as (keyof Tokens)[]) {
    const value = after[key], previous = before ? before[key] : 0;
    if (value !== null && previous !== null && value < previous) return null; // A reset has no trustworthy baseline.
    result[key] = value === null || previous === null ? null : value - previous;
  }
  return TokenUsage.parse(result);
}
