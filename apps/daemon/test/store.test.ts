import { describe, expect, it } from "vitest";
import { Store } from "@contextlanes/daemon";

function seeded() {
  const store = Store.open(":memory:");
  store.addProject({ id: "shuttleworks", name: "ShuttleWorks", path: "/code/shuttleworks" });
  store.insertLane({
    id: "shuttleworks/01", n: 1, project: "shuttleworks", goal: null, task: "Billing phase 0", agent: "claude-code", model: null,
    mode: "edits", branch: "lane/01-billing-phase-0", worktree: "/lanes/shuttleworks/01-billing-phase-0", terminal: "cl-shuttleworks-01",
    state: "draft", colour: "lc1",
  });
  return store;
}

describe("store", () => {
  it("migrates an empty database", () => {
    const store = Store.open(":memory:");
    expect(store.schemaVersion()).toBe(9);
    expect(store.listProjects()).toEqual([]);
  });

  it("numbers events per lane without gaps", () => {
    const store = seeded();
    const a = store.appendEvent("shuttleworks/01", { type: "agent.thought", payload: { text: "one" } });
    const b = store.appendEvent("shuttleworks/01", { type: "agent.thought", payload: { text: "two" } });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(store.events("shuttleworks/01", 1).map((e) => e.seq)).toEqual([2]);
  });

  it("deduplicates replayed host observations without gaps", () => {
    const store = seeded();
    const event = { type: "agent.message" as const, payload: { text: "stream", role: "agent" as const } };
    const first = store.appendEvent("shuttleworks/01", event, "stable-id");
    expect(store.appendEvent("shuttleworks/01", event, "stable-id")).toEqual(first);
    expect(store.appendEvent("shuttleworks/01", event, "next-id").seq).toBe(2);
    expect(store.events("shuttleworks/01")).toHaveLength(2);
  });

  it("refuses payloads that do not match the event type", () => {
    const store = seeded();
    expect(() => store.appendEvent("shuttleworks/01", { type: "tool.call", payload: { callId: "x" } } as never)).toThrow();
  });

  it("follows the lane lifecycle and records each move", () => {
    const store = seeded();
    store.setLaneState("shuttleworks/01", "setting_up");
    store.setLaneState("shuttleworks/01", "working");
    expect(() => store.setLaneState("shuttleworks/01", "merged")).toThrow(/cannot go/);
    expect(store.getLane("shuttleworks/01")?.state).toBe("working");
    expect(store.events("shuttleworks/01").filter((e) => e.type === "lane.state")).toHaveLength(2);
  });

  it("derives the inbox from unanswered permission requests", () => {
    const store = seeded();
    store.appendEvent("shuttleworks/01", {
      type: "permission.requested",
      payload: { requestId: "r1", title: "Run npm i -D stripe-mock", options: [{ id: "allow", label: "Allow once", kind: "allow_once" }] },
    });
    expect(store.inbox()).toEqual([expect.objectContaining({ id: "shuttleworks/01#r1", kind: "permission" })]);
    store.appendEvent("shuttleworks/01", { type: "permission.answered", payload: { requestId: "r1", optionId: "allow", by: "phone" } });
    expect(store.inbox()).toEqual([]);
  });
  it("asks for each lane's latest recipe only, since an edit replaces the earlier one", () => {
    const store = seeded();
    store.appendEvent("shuttleworks/01", { type: "recipe.requested", payload: { hash: "aaaaaaa1" } });
    store.appendEvent("shuttleworks/01", { type: "recipe.requested", payload: { hash: "bbbbbbb2" } });
    expect(store.inbox().map((i) => i.id)).toEqual(["shuttleworks/01#recipe-bbbbbbb2"]);
    store.approveRecipe("shuttleworks", "bbbbbbb2");
    expect(store.inbox()).toEqual([]);
  });
});
