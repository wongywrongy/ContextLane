import type { RequestPermissionRequest, SessionUpdate, ToolKind } from "@agentclientprotocol/sdk";
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
        payload: { callId: u.toolCallId, kind: KIND[u.kind ?? "other"], title: u.title, files: (u.locations ?? []).map((l) => l.path) },
      };
    case "tool_call_update":
      return u.status ? { type: "tool.update", payload: { callId: u.toolCallId, status: u.status } } : null;
    case "usage_update":
      return { type: "usage", payload: { contextUsed: u.used, contextSize: u.size } };
    default:
      return null;
  }
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
