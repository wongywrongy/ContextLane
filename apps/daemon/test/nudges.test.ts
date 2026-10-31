import { describe, expect, it } from "vitest";
import { EventBus, HostLinks, Store } from "@contextlanes/daemon";
import { Nudges, PLAN_AFTER } from "../src/nudges.js";

function fixture() {
  const store = Store.open(":memory:"); const bus = new EventBus(); const hosts = new HostLinks({ store, bus });
  store.addProject({ id: "shop", name: "Shop", path: "/shop" });
  store.insertLane({ id: "shop/01", n: 1, project: "shop", goal: null, task: "T", agent: "codex", model: null, mode: "ask", branch: "b", worktree: "/w", terminal: "t", hostUnit: null, base: "main", state: "working", colour: "lc1" });
  new Nudges({ store, bus, hosts }).start();
  const add = (type: string, payload: unknown) => bus.publish(store.appendEvent("shop/01", { type, payload } as never));
  const nudges = () => store.events("shop/01").filter((e) => e.type === "lane.nudged").map((e) => e.payload.kind);
  return { store, add, nudges };
}

describe("nudges", () => {
  it("asks once for a plan after many steps without one, and queues it as a message", () => {
    const f = fixture();
    for (let i = 0; i < PLAN_AFTER - 1; i++) f.add("tool.call", { callId: `c${i}`, kind: "read", title: "Read", files: [] });
    expect(f.nudges()).toEqual([]);
    for (let i = 0; i < 30; i++) f.add("tool.call", { callId: `d${i}`, kind: "read", title: "Read", files: [] });
    expect(f.nudges()).toEqual(["plan"]);
    expect(f.store.pendingCommands("shop/01").map((c) => c.payload.command)).toContainEqual(expect.objectContaining({ kind: "prompt", text: expect.stringContaining("Write a short plan") }));
  });

  it("does not ask when the agent already has a plan", () => {
    const f = fixture();
    f.add("agent.plan", { entries: [{ text: "Do it", status: "pending" }] });
    for (let i = 0; i < 80; i++) f.add("tool.call", { callId: `c${i}`, kind: "read", title: "Read", files: [] });
    expect(f.nudges()).toEqual([]);
  });

  it("warns once when the context passes 70%", () => {
    const f = fixture();
    f.add("usage", { contextUsed: 50, contextSize: 100 });
    f.add("usage", { contextUsed: 72, contextSize: 100 });
    f.add("usage", { contextUsed: 90, contextSize: 100 });
    expect(f.nudges()).toEqual(["context"]);
  });

  it("asks a turn that runs on for 45 minutes for a status check, and again 45 minutes later", () => {
    const f = fixture();
    const at = (min: number) => new Date(Date.UTC(2026, 9, 30, 20, min)).toISOString();
    // Events fed with fixed times, so the 45 minutes are measured from the log, not the clock.
    const nudges = new (Nudges as unknown as new (d: unknown) => { see(e: unknown): void })({ store: f.store, bus: new EventBus(), hosts: new HostLinks({ store: f.store, bus: new EventBus() }) });
    const ev = (type: string, payload: unknown, min: number) => nudges.see({ lane: "shop/01", seq: min, at: at(min), type, payload });
    ev("agent.turn", { active: true }, 0);
    ev("tool.call", { callId: "a", kind: "read", title: "Read", files: [] }, 44);
    ev("tool.call", { callId: "b", kind: "read", title: "Read", files: [] }, 46);
    ev("tool.call", { callId: "c", kind: "read", title: "Read", files: [] }, 60);
    ev("tool.call", { callId: "d", kind: "read", title: "Read", files: [] }, 92);
    expect(f.nudges().filter((k) => k === "checkin")).toHaveLength(2);
  });
});
