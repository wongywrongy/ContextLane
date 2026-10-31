import type { RequestPermissionRequest, SessionUpdate, ToolKind, ToolCallContent } from "@agentclientprotocol/sdk/unstable";
import { diffLines } from "diff";
import { stripVTControlCharacters } from "node:util";
import { testSummary, type NewLaneEvent, type StepKind, type TestCounts } from "@contextlanes/protocol";

const KIND: Record<ToolKind, StepKind> = {
  read: "read", search: "search", fetch: "fetch",
  edit: "edit", delete: "delete", move: "move",
  execute: "execute", think: "think",
  switch_mode: "other", other: "other",
};

/**
 * ACP sends message and thought text in small chunks. We keep one event per contiguous run
 * of the same kind, so the step trail reads like steps rather than tokens.
 */
export class Coalescer {
  private kind: "agent.message" | "agent.thought" | null = null;
  private text = "";
  /**
   * Command output that arrives as chunks in `_meta` (Codex sends it there to clients without a terminal),
   * kept per tool call until the command ends, then sent once with its exit code.
   */
  private readonly output = new Map<string, string>();

  constructor(private readonly emit: (e: NewLaneEvent) => void) {}

  push(update: SessionUpdate): void {
    const chunk = textChunk(update);
    if (chunk) {
      if (this.kind && this.kind !== chunk.kind) this.flush();
      this.kind = chunk.kind;
      this.text += chunk.text;
      return;
    }
    this.flush();
    const mapped = mapUpdate(update);
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const id = update.toolCallId;
      const delta = outputChunk(update._meta);
      if (delta) this.output.set(id, ((this.output.get(id) ?? "") + delta).slice(-MAX_OUTPUT));
      const finished = update.status === "completed" || update.status === "failed";
      const shown = mapped && (mapped.type === "tool.call" || mapped.type === "tool.update") ? mapped.payload.summary : undefined;
      const fromRaw = finished && !shown ? rawText(update.rawOutput) : null;
      const exitCode = exitOf(update._meta, update.rawOutput, finished ? shown ?? fromRaw ?? undefined : undefined);
      const ended = finished || exitCode !== undefined;
      // A chunk alone is held; the end of the command carries all of it.
      if (mapped && (mapped.type === "tool.call" || mapped.type === "tool.update")) {
        const held = ended ? this.output.get(id) : undefined;
        if (ended) this.output.delete(id);
        const only = mapped.type === "tool.update" && Object.keys(mapped.payload).length === 1 && !held && exitCode === undefined;
        if (only) return;
        const summary = mapped.payload.summary ?? (held ? clip(stripVTControlCharacters(held)) : fromRaw ? clip(stripVTControlCharacters(fromRaw)) : undefined);
        this.emit({ ...mapped, payload: { ...mapped.payload, ...(summary ? { summary } : {}), ...(exitCode !== undefined ? { exitCode } : {}) } } as NewLaneEvent);
        return;
      }
    }
    if (mapped) this.emit(mapped);
  }

  flush(): void {
    if (!this.kind || !this.text) return;
    this.emit(this.kind === "agent.thought" ? { type: "agent.thought", payload: { text: this.text } } : { type: "agent.message", payload: { text: this.text, role: "agent" } });
    this.kind = null;
    this.text = "";
  }
}

const MAX_OUTPUT = 48_000;
const clip = (text: string) => text.length > 12_000 ? `[Earlier output trimmed]\n${text.slice(-12_000)}` : text;

/** Output chunks in `_meta`: `terminal_output_delta` (appended) or Zed's `terminal_output`. */
function outputChunk(meta: unknown): string | null {
  const m = meta as Record<string, { data?: unknown } | undefined> | null | undefined;
  const data = m?.terminal_output_delta?.data ?? m?.terminal_output?.data;
  return typeof data === "string" && data ? data : null;
}

/**
 * The exit code of a command, wherever the agent puts it: `_meta.terminal_exit` (Claude, Codex, Droid),
 * `rawOutput.exit_code` (Codex reads, goose), `rawOutput.metadata.exit` (OpenCode), or only in its text:
 * "Exit Code: 1" (Qwen), "Command exited with code: 1" (Gemini), "exit code: 1" (Kimi), <return-code> (Auggie).
 */
export function exitOf(meta: unknown, raw: unknown, text?: string): number | null | undefined {
  const exit = (meta as { terminal_exit?: { exit_code?: unknown } } | null | undefined)?.terminal_exit;
  if (exit && "exit_code" in exit) return typeof exit.exit_code === "number" ? exit.exit_code : null;
  const r = raw as { exit_code?: unknown; exitCode?: unknown; exit?: unknown; metadata?: { exit?: unknown } } | null | undefined;
  for (const code of [r?.exit_code, r?.exitCode, r?.metadata?.exit, r?.exit]) if (typeof code === "number") return code;
  const said = text?.match(/(?:exit(?:ed)? (?:with )?code|exit status)[:\s]+(-?\d+)|<return-code>(-?\d+)<\/return-code>/i);
  return said ? Number(said[1] ?? said[2]) : undefined;
}

/** Output an agent left only in `rawOutput` (Cline, Auggie, goose): its text, or stdout and stderr. */
export function rawText(raw: unknown): string | null {
  if (typeof raw === "string") return raw || null;
  const r = raw as { output?: unknown; stdout?: unknown; stderr?: unknown } | null | undefined;
  if (typeof r?.output === "string" && r.output) return r.output;
  const parts = [r?.stdout, r?.stderr].filter((p): p is string => typeof p === "string" && !!p);
  return parts.length ? parts.join("\n") : null;
}

function textChunk(u: SessionUpdate): { kind: "agent.message" | "agent.thought"; text: string } | null {
  if (u.sessionUpdate !== "agent_message_chunk" && u.sessionUpdate !== "agent_thought_chunk") return null;
  if (u.content.type !== "text") return null;
  return { kind: u.sessionUpdate === "agent_thought_chunk" ? "agent.thought" : "agent.message", text: u.content.text };
}

/** Non-text updates map one to one. Updates we do not show yet return null. */
export function mapUpdate(u: SessionUpdate): NewLaneEvent | null {
  switch (u.sessionUpdate) {
    case "plan":
      return { type: "agent.plan", payload: { entries: u.entries.map((e) => ({ text: e.content, status: e.status })) } };
    case "tool_call":
      return {
        type: "tool.call",
        payload: { callId: u.toolCallId, kind: ["Agent", "Task"].includes(u.name ?? "") ? "subagent" : u.name === "delegate" ? "helper" : KIND[u.kind ?? "other"], title: u.title, files: (u.locations ?? []).map((l) => l.path), ...(u.status ? { status: u.status } : {}), ...toolEvidence(u.content) },
      };
    case "tool_call_update":
      return { type: "tool.update", payload: { callId: u.toolCallId, ...(u.status ? { status: u.status } : {}), ...(u.title ? { title: u.title } : {}), ...(u.kind ? { kind: KIND[u.kind] } : {}), ...(u.locations ? { files: u.locations.map((l) => l.path) } : {}), ...toolEvidence(u.content) } };
    case "usage_update":
      return { type: "usage", payload: { contextUsed: u.used, contextSize: u.size, source: "acp", ...(u.cost?.currency === "USD" ? { costUsd: u.cost.amount } : {}) } };
    default:
      return null;
  }
}

export function toolEvidence(content: ToolCallContent[] | null | undefined): { diff?: { added: number; removed: number }; tests?: { name: string; passed: boolean }[]; counts?: TestCounts; summary?: string } {
  let added = 0, removed = 0, hasDiff = false, timedOut = false;
  const output: string[] = [];
  for (const item of content ?? []) {
    if (item.type === "diff") {
      // shortcut: large ACP diffs may omit counts after 100ms; phase 2 uses git's checkpoint diff.
      const changes = diffLines(item.oldText ?? "", item.newText, { timeout: 100 });
      if (!changes) { timedOut = true; continue; }
      hasDiff = true;
      for (const change of changes) { if (change.added) added += change.count; if (change.removed) removed += change.count; }
    } else if (item.type === "content" && item.content.type === "text") output.push(stripVTControlCharacters(item.content.text));
  }
  const text = output.join("\n");
  const tests = [...text.matchAll(/^(not ok|ok)\s+\d+\s*(?:-\s*)?([^\n#]*)(?:#\s*(SKIP|TODO).*)?$/gm)].filter((m) => !m[3]).map((m) => ({ name: m[2]!.trim(), passed: m[1] === "ok" }));
  const counts = !tests.length && text ? testSummary(text) : null;
  return { ...(hasDiff && !timedOut ? { diff: { added, removed } } : {}), ...(tests.length ? { tests } : {}), ...(counts?.total ? { counts } : {}), ...(text ? { summary: text.length > 12_000 ? `${text.slice(0, 12_000)}\n[Output trimmed]` : text } : {}) };
}

/** A permission request becomes an inbox item with the agent's own options. */
export function mapPermission(requestId: string, req: RequestPermissionRequest): NewLaneEvent {
  return {
    type: "permission.requested",
    payload: {
      requestId,
      title: req.toolCall.title ?? "The agent wants to continue",
      options: req.options.map((o) => ({ id: o.optionId, label: o.name, kind: o.kind })),
    },
  };
}
