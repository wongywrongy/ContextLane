import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Config, EventBus, LaneManager, Store, runCommand, type Runner } from "@contextlanes/daemon";
import { SecondReviews } from "../src/second-review.js";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

describe("second-agent review", () => {
  it("reviews in a read-only lane of its own and puts the findings in the packet", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cl-second-"))); roots.push(root);
    const repo = join(root, "shop"); await mkdir(repo);
    const git = (cwd: string, ...a: string[]) => runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...a], { cwd });
    await git(repo, "init", "-q"); await writeFile(join(repo, "a.txt"), "one\n"); await git(repo, "add", "-A"); await git(repo, "commit", "-qm", "one");
    const store = Store.open(":memory:"); const bus = new EventBus();
    store.addProject({ id: "shop", name: "Shop", path: repo });
    const calls: string[][] = [];
    const run: Runner = async (cmd, args, opts) => { if (cmd === "git") return runCommand(cmd, args, opts); calls.push([cmd, ...args]); return { stdout: "" }; };
    const lanes = new LaneManager({ store, bus, config: Config.parse({ paths: { data: join(root, "data"), lanes: join(root, "lanes") }, lanes: { launchHosts: false } }), run });
    const lane = await lanes.start({ project: "shop", task: "Billing", agent: "claude-code", base: "main" });
    await writeFile(join(lane.worktree, "a.txt"), "one\ntwo\n"); await git(lane.worktree, "commit", "-qam", "two");
    const head = (await git(lane.worktree, "rev-parse", "HEAD")).stdout.trim();
    const base = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
    const id = "11111111-2222-4333-8444-555555555555";
    store.insertCheckpoint({ id, lane: lane.id, base, head, summary: "Adds line two", checks: [], screenshots: [], files: [], plan: [], unplanned: [], process: [], signal: "strong", decision: null, prUrl: null, createdAt: new Date().toISOString() });
    const reviews = new SecondReviews({ store, bus, lanes, run });
    expect((await reviews.estimate(id)).tokens).toBe(15_000);
    await expect(reviews.start(id, "claude-code")).rejects.toThrow(/different agent/);
    const c = await reviews.start(id, "codex");
    const reviewLane = store.getLane(c.secondReview!.lane)!;
    expect(reviewLane).toMatchObject({ agent: "codex", mode: "plan", base: lane.branch, task: "Second review of 01 by codex" });
    bus.publish(store.appendEvent(reviewLane.id, { type: "agent.message", payload: { text: "should fix — a.txt:2 — no trailing context.\nVerdict: merge after fixes", role: "agent" } }));
    bus.publish(store.appendEvent(reviewLane.id, { type: "agent.turn", payload: { active: false } }));
    expect(store.checkpoint(id)!.secondReview).toMatchObject({ agent: "codex", state: "done", text: expect.stringContaining("Verdict: merge after fixes") });
    expect(store.getLane(reviewLane.id)!.state).toBe("archived");
  });
});
