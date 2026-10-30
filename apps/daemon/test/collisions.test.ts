import { describe, expect, it } from "vitest";
import type { CodeMap, Lane, LaneOverlay } from "@contextlanes/protocol";
import { Collisions, EventBus, Store, mergeOrder, type CodeMaps, type HostLinks } from "@contextlanes/daemon";

const lane = (id: string, state: Lane["state"] = "working") => ({ id, state } as Lane);

describe("merge order", () => {
  it("puts the lane whose change the other builds on first", () => {
    const links = [{ source: "billing/fees.py", target: "models/t.py" }];
    const r = mergeOrder([{ lane: lane("s/01"), modules: ["billing/fees.py", "models/t.py"], files: 3 }, { lane: lane("s/02"), modules: ["models/t.py", "solver/x"], files: 1 }], [...links, { source: "billing/fees.py", target: "solver/x" }]);
    expect(r.order).toEqual(["s/02", "s/01"]);
    expect(r.reason).toBe("s/01 builds on code s/02 changes");
  });
  it("otherwise the lane nearer review, then the smaller change", () => {
    expect(mergeOrder([{ lane: lane("s/01"), modules: ["m"], files: 1 }, { lane: lane("s/02", "in_review"), modules: ["m"], files: 9 }], []).order).toEqual(["s/02", "s/01"]);
    const r = mergeOrder([{ lane: lane("s/01"), modules: ["m"], files: 9 }, { lane: lane("s/02"), modules: ["m"], files: 2 }], []);
    expect(r).toEqual({ order: ["s/02", "s/01"], reason: "s/02 is the smaller change" });
  });
});

describe("collision warnings", () => {
  function fixture() {
    const store = Store.open(":memory:"); const bus = new EventBus();
    store.addProject({ id: "s", name: "S", path: "/s" });
    for (const n of [1, 2]) store.insertLane({ id: `s/0${n}`, n, project: "s", goal: null, task: `Task ${n}`, agent: "codex", model: null, mode: "ask", branch: `lane/0${n}`, worktree: `/w${n}`, terminal: `t${n}`, hostUnit: null, base: "main", state: "working", colour: "lc1" });
    const map = { modules: [{ id: "models/t.py" }], links: [] } as unknown as CodeMap;
    let overlay: LaneOverlay[] = [{ lane: "s/01", modules: { "models/t.py": ["models/t.py", "x"] }, created: [] }, { lane: "s/02", modules: { "models/t.py": ["models/t.py"] }, created: [] }];
    const codemaps = { map: async () => ({ map, error: null }), overlay: async () => overlay } as unknown as CodeMaps;
    const sent: { lane: string; text: string }[] = [];
    const hosts = { command: (l: string, c: { text: string }) => { sent.push({ lane: l, text: c.text }); return { commandId: "x", delivered: true }; } } as unknown as HostLinks;
    return { store, collisions: new Collisions({ store, bus, codemaps, hosts }), sent, set: (o: LaneOverlay[]) => { overlay = o; } };
  }
  const of = (store: Store, id: string, type: string) => store.events(id).filter((e) => e.type === type);

  it("records a collision once on both lanes, asks the waiting lane's owner in the Inbox, and clears it", async () => {
    const f = fixture();
    await f.collisions.check(); await f.collisions.check();
    expect(of(f.store, "s/01", "collision.detected")).toHaveLength(1);
    expect(of(f.store, "s/02", "collision.detected")[0]!.payload).toMatchObject({ module: "models/t.py", order: ["s/02", "s/01"] });
    expect(f.store.inbox().filter((i) => i.kind === "collision")).toEqual([expect.objectContaining({ lane: "s/01", title: "models/t.py: lanes 02 and 01 are both changing it; 02 should merge first" })]);
    expect(f.collisions.active("s")).toHaveLength(1);
    f.set([{ lane: "s/01", modules: {}, created: [] }, { lane: "s/02", modules: { "models/t.py": ["models/t.py"] }, created: [] }]);
    await f.collisions.check();
    expect(of(f.store, "s/01", "collision.cleared")).toHaveLength(1);
    expect(f.store.inbox().filter((i) => i.kind === "collision")).toEqual([]);
    expect(f.sent).toEqual([]); // agents hear nothing on their own
  });

  it("tells the waiting lane to rebase only after the first lane merges, once", async () => {
    const f = fixture();
    await f.collisions.check();
    f.collisions.plan("s", "models/t.py", "s/01");
    expect(() => f.collisions.plan("s", "models/t.py", "s/01")).toThrow(/already set/);
    expect(f.collisions.active("s")[0]!.planned).toBe(true);
    await f.collisions.check();
    expect(f.sent).toEqual([]);
    f.store.setLaneState("s/02", "in_review"); f.store.setLaneState("s/02", "merged");
    await f.collisions.check(); await f.collisions.check();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ lane: "s/01", text: expect.stringContaining("Rebase this branch onto main") });
    expect(of(f.store, "s/01", "collision.cleared")).toHaveLength(1); // s/02 merged, so the overlap is over
  });
});
