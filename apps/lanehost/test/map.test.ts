import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { NewLaneEvent } from "@contextlanes/protocol";
import { Coalescer, mapPermission, mapUpdate, resolveAgent } from "@contextlanes/lanehost";

const text = (kind: "agent_message_chunk" | "agent_thought_chunk", t: string) =>
  ({ sessionUpdate: kind, content: { type: "text", text: t } }) as SessionUpdate;

describe("ACP to ContextLanes events", () => {
  it("joins streamed chunks into one step per run", () => {
    const out: NewLaneEvent[] = [];
    const c = new Coalescer((e) => out.push(e));
    c.push(text("agent_thought_chunk", "fees are "));
    c.push(text("agent_thought_chunk", "in club time"));
    c.push(text("agent_message_chunk", "Fixing dates.py"));
    c.flush();
    expect(out).toEqual([
      { type: "agent.thought", payload: { text: "fees are in club time" } },
      { type: "agent.message", payload: { text: "Fixing dates.py", role: "agent" } },
    ]);
  });

  it("maps tool calls with their files", () => {
    const e = mapUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read fees.py", kind: "read", locations: [{ path: "fees.py" }] } as SessionUpdate);
    expect(e).toEqual({ type: "tool.call", payload: { callId: "t1", kind: "read", title: "Read fees.py", files: ["fees.py"] } });
  });

  it("turns a permission request into an inbox item with the agent's options", () => {
    const e = mapPermission("r1", {
      sessionId: "s",
      toolCall: { toolCallId: "t2", title: "npm i -D stripe-mock" },
      options: [{ optionId: "a", name: "Allow once", kind: "allow_once" }, { optionId: "d", name: "Deny", kind: "reject_once" }],
    });
    expect(e).toMatchObject({ type: "permission.requested", payload: { requestId: "r1", title: "npm i -D stripe-mock" } });
  });

  it("knows how to launch the default agents", () => {
    expect(resolveAgent("opencode")).toEqual({ command: "opencode", args: ["acp"] });
    expect(() => resolveAgent("nope")).toThrow(/unknown agent/);
  });
});

it("keeps measured ACP line diffs and individual TAP outcomes in tool updates", () => {
  const event = mapUpdate({ sessionUpdate: "tool_call_update", toolCallId: "edit", status: "completed", content: [
    { type: "diff", path: "/tmp/file.ts", oldText: "same\nold\n", newText: "same\nnew\nextra\n" },
    { type: "content", content: { type: "text", text: "TAP version 13\nok 1 - reads config\nnot ok 2 - rejects input\nok 3 - optional # SKIP no device\n" } },
  ] });
  expect(event).toMatchObject({ type: "tool.update", payload: { diff: { added: 2, removed: 1 }, tests: [{ name: "reads config", passed: true }, { name: "rejects input", passed: false }] } });
});
