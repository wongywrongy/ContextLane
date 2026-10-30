import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BenchTask, benchTable, type Lane } from "@contextlanes/protocol";
import { Bench, Config, EventBus, Store, hostCommand, type LaneManager, type Runner } from "@contextlanes/daemon";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

describe("contextlanes bench", () => {
  it("runs each task without and with phase 3, then checks and compares tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "cl-bench-")); roots.push(root);
    const store = Store.open(":memory:"); const bus = new EventBus();
    store.addProject({ id: "shop", name: "Shop", path: "/shop" });
    let n = 0;
    const started: { baseline: boolean }[] = [];
    // A fake lane manager: the agent spends 100k tokens without phase 3's tools and 60k with them.
    const lanes = { start: async (req: { task: string; baseline: boolean }) => {
      n++;
      const lane = store.insertLane({ id: `shop/0${n}`, n, project: "shop", goal: null, task: req.task, agent: "codex", model: null, mode: "edits", branch: `b${n}`, worktree: `/w${n}`, terminal: `t${n}`, hostUnit: null, base: "main", state: "working", colour: "lc1" }) as Lane;
      started.push({ baseline: req.baseline });
      setTimeout(() => {
        store.appendEvent(lane.id, { type: "agent.turn", payload: { active: true } });
        store.appendEvent(lane.id, { type: "usage.turn", payload: { turnId: `6e0c8a8e-8a1c-4a4b-9d7f-0f2b4a6b1c1${n}`, sessionId: "s", source: "acp", inputTokens: req.baseline ? 90_000 : 50_000, outputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 } });
        store.appendEvent(lane.id, { type: "agent.turn", payload: { active: false } });
      }, 20);
      return lane;
    } } as unknown as LaneManager;
    const checks: string[] = [];
    const run: Runner = async (cmd, args) => { if (cmd === "systemd-run") checks.push(args.join(" ")); return { stdout: "1 passed in 0.1s\n" }; };
    const bench = new Bench({ config: Config.parse({ paths: { data: join(root, "data") } }), store, bus, lanes, run, poll: 10 });
    const r = await bench.start([BenchTask.parse({ project: "shop", task: "Add invoices", check: ["pytest", "-q"] })]);
    for (let i = 0; i < 200 && !(await bench.get(r.id))?.finishedAt; i++) await new Promise((x) => setTimeout(x, 20));
    const done = (await bench.get(r.id))!;
    expect(started.map((s) => s.baseline).sort()).toEqual([false, true]);
    expect(done.tasks[0]!.runs.map((x) => [x.baseline, x.tokens, x.passed, x.state]).sort()).toEqual([[false, 60_000, true, "done"], [true, 100_000, true, "done"]]);
    expect(checks).toHaveLength(2);
    expect(benchTable(done)).toContain("| Add invoices | 100000 | 60000 | 40% fewer | passed / passed |");
  });

  it("starts a baseline lane without project notes", () => {
    const args = hostCommand({ id: "shop/01", worktree: "/w", task: "Add invoices", agent: "codex", model: null, mode: "edits" } as Lane, Config.parse({}), undefined, undefined, "");
    expect(args).toContain("--task=Add invoices");
  });
});
