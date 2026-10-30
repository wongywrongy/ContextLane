import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildServer, Config, EventBus, HostLinks, LaneManager, Store, type Runner } from "@contextlanes/daemon";
import { UsageSummary } from "@contextlanes/protocol";
import { signedIn } from "./signed-in.js";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

it("sums all turns by lane and UTC day, validates filters and preserves missing cost/cache data", async () => {
  const store = Store.open(":memory:"); stores.push(store);
  const bus = new EventBus(), config = Config.parse({ lanes: { launchHosts: false } });
  const run: Runner = async () => ({ stdout: "" });
  const hosts = new HostLinks({ store, bus });
  const lanes = new LaneManager({ store, bus, config, run });
  const app = signedIn(buildServer({ store, bus, hosts, lanes, config, run, version: "test" }), store);
  try {
    for (const project of ["demo", "other"]) {
      store.addProject({ id: project, name: project, path: `/code/${project}` });
      await lanes.start({ project, task: "Task" });
    }
    const payload = { turnId: randomUUID(), sessionId: "session", source: "acp" as const, inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1, costUsd: .1 };
    const first = store.appendEvent("demo/01", { type: "usage.turn", payload });
    store.db.prepare("UPDATE event SET at = ? WHERE lane = ? AND seq = ?").run("2026-10-29T23:59:59.000Z", first.lane, first.seq);
    store.appendEvent("demo/01", { type: "usage.turn", payload }); // A repeated turn never counts twice.
    const last = store.appendEvent("demo/01", { type: "usage.turn", payload: { ...payload, turnId: randomUUID(), source: "codex-log", costUsd: undefined, cacheWriteTokens: null } });
    store.db.prepare("UPDATE event SET at = ? WHERE lane = ? AND seq = ?").run("2026-10-30T00:00:00.500Z", last.lane, last.seq);
    store.appendEvent("other/01", { type: "usage.turn", payload: { ...payload, turnId: randomUUID() } });
    const limit = { window: "5h" as const, usedPct: 62, resetsAt: new Date(Date.now() + 3600_000).toISOString(), source: "acp" as const };
    store.appendEvent("demo/01", { type: "usage.limit", payload: limit });
    store.appendEvent("demo/01", { type: "usage.limit", payload: { ...limit, usedPct: 63 } });
    store.appendEvent("other/01", { type: "usage.limit", payload: { ...limit, window: "7d", resetsAt: "2026-01-01T00:00:00.000Z" } });
    // Usage aggregation must not inherit the event-history page size.
    for (let i = 0; i < 501; i++) store.appendEvent("demo/01", { type: "agent.thought", payload: { text: "step" } });
    const result = await app.inject({ url: "/api/usage?project=demo" });
    expect(result.statusCode).toBe(200);
    const summary = UsageSummary.parse(result.json());
    expect(summary.lanes).toEqual([{ lane: "demo/01", turns: 2, inputTokens: 20, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: null, costUsd: .1, costTurns: 1 }]);
    expect(summary.days.map((d) => [d.day, d.turns])).toEqual([["2026-10-29", 1], ["2026-10-30", 1]]);
    expect(summary.limits).toEqual([{ agent: "claude-code", ...limit, usedPct: 63 }]);
    const recent = (await app.inject({ url: "/api/usage?project=demo&since=2026-10-30T00:00:00Z" })).json();
    expect(recent.lanes[0]).toMatchObject({ turns: 1, costUsd: null, costTurns: 0, cacheWriteTokens: null });
    expect((await app.inject({ url: "/api/usage" })).json().lanes).toHaveLength(2);
    expect((await app.inject({ url: "/api/usage?project=missing" })).json()).toEqual({ lanes: [], days: [], limits: [] });
    for (const query of ["since=tomorrow", "project=../demo"]) expect((await app.inject({ url: `/api/usage?${query}` })).statusCode).toBe(400);
  } finally { await app.close(); await hosts.close(); }
});
