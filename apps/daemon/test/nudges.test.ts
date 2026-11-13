import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus, HostLinks, Store } from "@contextlanes/daemon";
import { Nudges } from "../src/nudges.js";

const stores: Store[] = [];
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) store.close(); });

function fixture(checkIns = false) {
  const store = Store.open(":memory:"); stores.push(store);
  const bus = new EventBus(); const hosts = new HostLinks({ store, bus });
  store.addProject({ id: "shop", name: "Shop", path: "/shop" });
  store.insertLane({ id: "shop/01", n: 1, project: "shop", goal: null, task: "T", agent: "codex", model: null, mode: "ask", branch: "b", worktree: "/w", terminal: "t", hostUnit: null, base: "main", state: "working", colour: "lc1" });
  const off = new Nudges({ store, bus, hosts, checkIns }).start();
  const add = (type: string, payload: unknown) => bus.publish(store.appendEvent("shop/01", { type, payload } as never));
  const nudges = () => store.eventsOfType(["lane.nudged"]);
  return { store, bus, hosts, add, nudges, off };
}

describe("optional status observations", () => {
  it("never demands a plan, a commit or a context restart, and is off by default", () => {
    const f = fixture();
    f.add("agent.turn", { active: true });
    for (let i = 0; i < 100; i++) f.add("tool.call", { callId: `c${i}`, kind: "read", title: "Read", files: [] });
    f.add("usage", { contextUsed: 95, contextSize: 100 });
    expect(f.nudges()).toEqual([]);
    expect(f.store.pendingCommands("shop/01")).toEqual([]);
  });

  it("optionally records a long turn without steering it, including across a daemon restart", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    const f = fixture(true);
    f.add("agent.turn", { active: true });
    vi.setSystemTime(new Date("2026-11-01T12:44:00Z"));
    f.add("tool.call", { callId: "a", kind: "read", title: "Read", files: [] });
    expect(f.nudges()).toEqual([]);
    vi.setSystemTime(new Date("2026-11-01T12:46:00Z"));
    f.add("tool.call", { callId: "b", kind: "read", title: "Read", files: [] });
    expect(f.nudges()).toHaveLength(1);
    f.off(); new Nudges({ ...f, checkIns: true }).start();
    vi.setSystemTime(new Date("2026-11-01T13:00:00Z"));
    f.add("tool.call", { callId: "c", kind: "read", title: "Read", files: [] });
    expect(f.nudges()).toHaveLength(1);
    vi.setSystemTime(new Date("2026-11-01T13:32:00Z"));
    f.add("tool.call", { callId: "d", kind: "read", title: "Read", files: [] });
    expect(f.nudges()).toHaveLength(2);
    expect(f.store.pendingCommands("shop/01")).toEqual([]);
    f.add("agent.turn", { active: false });
    vi.setSystemTime(new Date("2026-11-01T15:00:00Z"));
    f.add("tool.call", { callId: "e", kind: "read", title: "Read", files: [] });
    expect(f.nudges()).toHaveLength(2);
  });
});
