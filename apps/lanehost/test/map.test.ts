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

it("collects Codex command output from _meta chunks and reports it once, with the exit code", () => {
  const out: NewLaneEvent[] = [];
  const c = new Coalescer((e) => out.push(e));
  c.push({ sessionUpdate: "tool_call", toolCallId: "t1", title: "test -d .codegraph", kind: "execute", status: "in_progress" } as SessionUpdate);
  c.push({ sessionUpdate: "tool_call_update", toolCallId: "t1", _meta: { terminal_output_delta: { data: "fatal: not a tree\n", terminal_id: "t1" } } } as SessionUpdate);
  c.push({ sessionUpdate: "tool_call_update", toolCallId: "t1", _meta: { terminal_output_delta: { data: "\u001b[31mmore\u001b[0m\n", terminal_id: "t1" } } } as SessionUpdate);
  expect(out).toHaveLength(1);
  c.push({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed", _meta: { terminal_exit: { exit_code: 128, signal: null, terminal_id: "t1" } } } as SessionUpdate);
  expect(out.at(-1)).toMatchObject({ type: "tool.update", payload: { callId: "t1", status: "failed", exitCode: 128, summary: "fatal: not a tree\nmore\n" } });
  // A read command without a terminal reports its exit code in rawOutput.
  c.push({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "failed", rawOutput: { exit_code: 1 } } as SessionUpdate);
  expect(out.at(-1)).toMatchObject({ type: "tool.update", payload: { callId: "t2", exitCode: 1 } });
});

it("finds the parts of the main repository a worktree commit writes to", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { gitWriteRoots } = await import("../src/host.js");
  const root = await mkdtemp(join(tmpdir(), "cl-roots-"));
  try {
    const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd });
    git(root, "init", "-q", "-b", "main", "repo"); git(join(root, "repo"), "commit", "-q", "--allow-empty", "-m", "one");
    git(join(root, "repo"), "worktree", "add", "-q", "-b", "lane/01", join(root, "lane"));
    const roots = gitWriteRoots(join(root, "lane"));
    expect(roots).toEqual([join(root, "repo/.git/worktrees/lane"), join(root, "repo/.git/objects"), join(root, "repo/.git/refs"), join(root, "repo/.git/logs")]);
    expect(roots.some((r) => r.endsWith("hooks") || r.endsWith(".git"))).toBe(false);
    expect(gitWriteRoots(join(root, "repo"))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
