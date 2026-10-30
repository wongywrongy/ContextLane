import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openAgentSession } from "@contextlanes/lanehost";
import { NewLaneEvent, type TurnUsage } from "@contextlanes/protocol";
import { SessionUsage, usageDelta, reportedLimits } from "../src/usage.js";
import { fakeAgent } from "./fake-agent.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(join(tmpdir(), "cl-usage-")); roots.push(dir); return dir; }

it("records ACP prompt totals, USD increments and one completed compaction, preferring ACP over a matching log", async () => {
  const dir = await root();
  await mkdir(join(dir, "projects", "demo"), { recursive: true });
  await writeFile(join(dir, "projects", "demo", "fake-session.jsonl"), JSON.stringify({ type: "assistant", cwd: "/tmp", sessionId: "fake-session", message: { id: "m", usage: { input_tokens: 999, output_tokens: 999 } } }) + "\n");
  const events: NewLaneEvent[] = [];
  const fake = fakeAgent();
  const session = await openAgentSession({ lane: "demo/01", cwd: "/tmp", task: "usage", agentId: "claude-code", agent: { command: "unused", args: [], env: { CLAUDE_CONFIG_DIR: dir } }, token: "test", connect: (client) => client.connect(fake.app) }, (e) => events.push(NewLaneEvent.parse(e) as NewLaneEvent));
  try {
    await vi.waitFor(() => expect(events.filter((e) => e.type === "usage.turn")).toHaveLength(1));
    await session.command({ commandId: randomUUID(), command: { kind: "prompt", text: "usage", immediate: false } });
    await vi.waitFor(() => expect(events.filter((e) => e.type === "usage.turn")).toHaveLength(2));
    const turns = events.filter((e) => e.type === "usage.turn").map((e) => e.payload as TurnUsage);
    for (const turn of turns) expect(turn).toMatchObject({ source: "acp", sessionId: "fake-session", inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10, costUsd: .25 });
    expect(turns[0]!.turnId).not.toBe(turns[1]!.turnId);
    expect(events.filter((e) => e.type === "usage.compaction")).toHaveLength(1);
    expect(events.filter((e) => e.type === "usage.limit").slice(0, 2).map((e) => e.payload)).toMatchObject([{ window: "5h", usedPct: 62 }, { window: "7d", usedPct: 31 }]);
  } finally { session.close(); }
});

it("ignores absent and invalid limit percentages, and accepts a reported top-level window", () => {
  expect(reportedLimits(undefined)).toEqual([]);
  expect(reportedLimits({ "_claude/rateLimit": { rateLimitType: "five_hour", resetsAt: 1000 } })).toEqual([]);
  expect(reportedLimits({ "_claude/rateLimit": { unifiedWindows: { five_hour: { utilization: 62, resetsAt: 1000 } } } })).toEqual([]);
  expect(reportedLimits({ "_claude/rateLimit": { rateLimitType: "five_hour", utilization: .5, resetsAt: 8.64e12 } })).toEqual([]);
  expect(reportedLimits({ "_claude/rateLimit": { rateLimitType: "five_hour", utilization: 0, resetsAt: 1000 } })).toMatchObject([{ window: "5h", usedPct: 0 }]);
});

it("counts Claude final message usage once and excludes another path, session, malformed records and previous turns", async () => {
  const dir = await root(), folder = join(dir, "projects", "demo");
  await mkdir(folder, { recursive: true });
  const file = join(folder, "session.jsonl");
  const message = (id: string, output: number) => ({ type: "assistant", cwd: "/code/demo", sessionId: "session", message: { id, usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } });
  await writeFile(file, JSON.stringify(message("old", 5)) + "\n");
  const logs = new SessionUsage("claude-code", "/code/demo", "session", { CLAUDE_CONFIG_DIR: dir });
  const before = await logs.read();
  await appendFile(file, [message("next", 1), message("next", 9), { ...message("outside", 999), cwd: "/other" }, { ...message("other", 999), sessionId: "other" }, { ...message("invalid", -1) }].map(JSON.stringify).join("\n") + "\n{unfinished");
  const after = await logs.read();
  expect(after?.source).toBe("claude-log");
  expect(usageDelta(after!.tokens, before!.tokens)).toEqual({ inputTokens: 10, outputTokens: 9, cacheReadTokens: 3, cacheWriteTokens: 2 });
});

it("keeps a reported USD cost with unknown tokens and never converts another currency", async () => {
  const events: NewLaneEvent[] = [], fake = fakeAgent();
  const session = await openAgentSession({ lane: "demo/01", cwd: "/tmp", task: "cost", agent: { command: "unused", args: [] }, token: "test", connect: (client) => client.connect(fake.app) }, (e) => events.push(e));
  try {
    await vi.waitFor(() => expect(events.find((e) => e.type === "usage.turn")?.payload).toMatchObject({ source: "acp", costUsd: .25, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }));
    const commandId = randomUUID();
    await session.command({ commandId, command: { kind: "prompt", text: "foreign-cost", immediate: false } });
    await vi.waitFor(() => expect(events.some((e) => e.type === "agent.turn" && e.payload.commandId === commandId && !e.payload.active)).toBe(true));
    expect(events.filter((e) => e.type === "usage.turn")).toHaveLength(1);
  } finally { session.close(); }
});

it("emits only the current turn from a matching Claude log when ACP omits token totals", async () => {
  const dir = await root(), folder = join(dir, "projects", "demo");
  await mkdir(folder, { recursive: true });
  const file = join(folder, "fake-session.jsonl");
  const entry = (id: string) => JSON.stringify({ type: "assistant", cwd: "/tmp", sessionId: "fake-session", message: { id, usage: { input_tokens: 11, output_tokens: 7 } } }) + "\n";
  await writeFile(file, entry("old"));
  const fake = fakeAgent(() => appendFile(file, entry(randomUUID())));
  const events: NewLaneEvent[] = [];
  const session = await openAgentSession({ lane: "demo/01", cwd: "/tmp", task: "fallback", agentId: "claude-code", agent: { command: "unused", args: [], env: { CLAUDE_CONFIG_DIR: dir } }, token: "test", connect: (client) => client.connect(fake.app) }, (e) => events.push(e));
  try {
    await vi.waitFor(() => expect(events.filter((e) => e.type === "usage.turn")).toHaveLength(1));
    expect(events.find((e) => e.type === "usage.turn")?.payload).toMatchObject({ source: "claude-log", inputTokens: 11, outputTokens: 7, cacheReadTokens: null, cacheWriteTokens: null });
  } finally { session.close(); }
});

it("reads Codex cumulative totals once, excludes cached input, rejects mismatched sessions and does not invent cache writes", async () => {
  const dir = await root(), folder = join(dir, "sessions", "2026", "10", "30");
  await mkdir(folder, { recursive: true });
  const file = join(folder, "rollout-2026-10-30-session.jsonl");
  const meta = { type: "session_meta", payload: { id: "session", cwd: "/code/demo" } };
  const count = (input: number, output: number) => ({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: 30, output_tokens: output } } } });
  await writeFile(file, [meta, count(100, 5)].map(JSON.stringify).join("\n") + "\n");
  const logs = new SessionUsage("codex", "/code/demo", "session", { CODEX_HOME: dir });
  const before = await logs.read();
  await appendFile(file, [count(140, 15), count(140, 15), { type: "event_msg", payload: { type: "token_count", info: null } }].map(JSON.stringify).join("\n") + "\n");
  const after = await logs.read();
  expect(after?.source).toBe("codex-log");
  expect(usageDelta(after!.tokens, before!.tokens)).toEqual({ inputTokens: 40, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: null });
  expect(await new SessionUsage("codex", "/other", "session", { CODEX_HOME: dir }).read()).toBeNull();
  expect(await new SessionUsage("codex", "/code/demo", "../session", { CODEX_HOME: dir }).read()).toBeNull();
  expect(usageDelta(before!.tokens, after!.tokens)).toBeNull();
});
