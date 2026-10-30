import { expect, it, vi } from "vitest";
import type { Lane, LaneEvent } from "@contextlanes/protocol";
import { loadHistory, mergeEvents, queuedPrompts, stepsFor, timeline } from "../src/work/model";

const base: Lane = { id: "demo/01", project: "demo", goal: "Goal", task: "Task", agent: "codex", model: null, mode: "ask", branch: "lane/task", worktree: "/tmp/task", terminal: "cl-demo-01", state: "working", colour: "lc1", createdAt: "2026-01-01T10:00:00Z" };
const event = (seq: number, type: LaneEvent["type"], payload: unknown, at = "2026-01-01T11:00:00Z") => ({ lane: base.id, seq, at, type, payload }) as LaneEvent;

it("merges reconnect history once and loads beyond the first 500 events", async () => {
  const first = Array.from({ length: 500 }, (_, i) => event(i + 1, "agent.message", { role: "agent", text: "line" }));
  const next = event(501, "agent.message", { role: "agent", text: "last" });
  const fetch = vi.fn(async (path) => Response.json(String(path).endsWith("after=0") ? first : [next]));
  const history = await loadHistory(base.id, fetch);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(history).toHaveLength(501);
  expect(mergeEvents(history, [next, first[0]!])).toHaveLength(501);
});

it("builds six families, coalesces streamed text and retains a failed-then-fixed tool with diff and test evidence", () => {
  const events = [event(1, "agent.message", { role: "agent", text: "Hello " }), event(2, "agent.message", { role: "agent", text: "world" }),
    event(3, "tool.call", { callId: "read", kind: "read", title: "Read", files: [] }),
    event(4, "tool.call", { callId: "edit", kind: "edit", title: "Edit", files: ["src/file.ts"] }),
    event(5, "tool.update", { callId: "edit", status: "failed" }),
    event(6, "tool.update", { callId: "edit", status: "completed", diff: { added: 2, removed: 1 } }),
    event(7, "check.result", { name: "checks", passed: true }), event(8, "permission.requested", { requestId: "r", title: "Run?", options: [] }),
    event(9, "helper.delegated", { kind: "read", model: "local", tokensSaved: 0 })];
  const steps = stepsFor(events);
  expect(steps[0]?.text).toBe("Hello world");
  expect(new Set(steps.map((s) => s.family))).toEqual(new Set(["mind", "look", "change", "run", "you", "team"]));
  expect(steps.find((s) => s.tool?.callId === "edit")?.tool).toMatchObject({ status: "completed", failedBefore: true, diff: { added: 2, removed: 1 } });
  expect(events[3]!.payload).not.toHaveProperty("failedBefore");
});

it("a delivered prompt remains queued until its own turn starts", () => {
  const id = "e936d487-6f41-402a-9a10-22cae36dd5b6";
  const queued = event(1, "agent.command", { commandId: id, command: { kind: "prompt", text: "Later", immediate: false } });
  const ack = event(2, "agent.command.result", { commandId: id, ok: true });
  expect(queuedPrompts([queued, ack])).toHaveLength(1);
  expect(queuedPrompts([queued, ack, event(3, "agent.turn", { commandId: id, active: true })])).toHaveLength(0);
});

it("clips the two-hour timeline and distinguishes actual idle, working and human waiting periods", () => {
  const start = Date.parse("2026-01-01T10:00:00Z"), end = Date.parse("2026-01-01T12:00:00Z");
  const events = [event(1, "lane.state", { from: "setting_up", to: "working" }, "2026-01-01T09:00:00Z"),
    event(2, "agent.turn", { active: false }, "2026-01-01T09:30:00Z"),
    event(3, "agent.turn", { active: true }, "2026-01-01T10:30:00Z"),
    event(4, "lane.state", { from: "working", to: "needs_you" }, "2026-01-01T11:00:00Z"),
    event(5, "lane.state", { from: "needs_you", to: "working" }, "2026-01-01T11:30:00Z")];
  const segments = timeline(base, events, start, end);
  expect(segments.map((s) => s.state)).toEqual(["idle", "working", "needs_you", "working"]);
  expect(segments[0]?.from).toBe(start);
  expect(segments.at(-1)?.to).toBe(end);
  expect(segments.reduce((sum, s) => sum + s.to - s.from, 0)).toBe(end - start);
});
