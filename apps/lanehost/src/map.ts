import type { RequestPermissionRequest, SessionUpdate, ToolKind, ToolCallContent } from "@agentclientprotocol/sdk";
import { diffLines } from "diff";
import { stripVTControlCharacters } from "node:util";
import type { NewLaneEvent, StepKind } from "@contextlanes/protocol";

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
    if (mapped) this.emit(mapped);
  }

  flush(): void {
    if (!this.kind || !this.text) return;
    this.emit(this.kind === "agent.thought" ? { type: "agent.thought", payload: { text: this.text } } : { type: "agent.message", payload: { text: this.text, role: "agent" } });
    this.kind = null;
    this.text = "";
  }
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
      return { type: "usage", payload: { contextUsed: u.used, contextSize: u.size } };
    default:
      return null;
  }
}

export function toolEvidence(content: ToolCallContent[] | null | undefined): { diff?: { added: number; removed: number }; tests?: { name: string; passed: boolean }[]; summary?: string } {
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
  return { ...(hasDiff && !timedOut ? { diff: { added, removed } } : {}), ...(tests.length ? { tests } : {}), ...(text ? { summary: text.length > 12_000 ? `${text.slice(0, 12_000)}\n[Output trimmed]` : text } : {}) };
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
