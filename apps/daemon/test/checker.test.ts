import { signedIn } from "./signed-in.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RECIPE_FILE, type LaneEvent } from "@contextlanes/protocol";
import { buildServer, Checker, Config, EventBus, HostLinks, LaneManager, parseNumstat, processSignal, Runtime, Store, runCommand, type Runner } from "@contextlanes/daemon";
import { readRecipe } from "../src/recipes.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

type Git = { dirty?: string; ahead?: string; checkFails?: boolean; baseName?: string };
async function setup(git: Git = {}, recipe: unknown = { checks: [{ name: "Tests", command: ["pnpm", "test"] }] }) {
  const root = await mkdtemp(join(tmpdir(), "cl-checker-"));
  roots.push(root);
  const state = { head: "abc123", base: "base000", ...git };
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "status") return { stdout: state.dirty ?? "" };
    if (cmd === "git" && args[0] === "merge-base") return { stdout: "base000\n" };
    if (cmd === "git" && args[0] === "rev-list") return { stdout: `${state.ahead ?? "2"}\n` };
    if (cmd === "git" && args[0] === "rev-parse") return { stdout: `${args[1] === "HEAD" ? state.head : state.base}\n` };
    if (cmd === "git" && args[0] === "diff") return { stdout: "128\t4\tbilling/invoice.py\n3\t0\tREADME.md\n-\t-\tlogo.png\n" };
    if (cmd === "systemd-run" && args.includes("--wait") && state.checkFails) throw Object.assign(new Error("exit 1"), { stdout: "2 failed\n" });
    return { stdout: "" };
  };
  const config = Config.parse({ paths: { data: root, lanes: root } });
  const store = Store.open(":memory:");
  const bus = new EventBus();
  const runtime = new Runtime({ store, bus, config, run });
  const repair = vi.fn();
  const checker = new Checker({ store, bus, config, run, runtime, repair, shoot: async () => {} });
  const app = signedIn(buildServer({ store, bus, lanes: new LaneManager({ store, bus, config, run }), hosts: new HostLinks({ store, bus }), config, version: "test", run, runtime, checker }), store);
  store.addProject({ id: "shop", name: "Shop", path: root });
  store.insertLane({ id: "shop/01", n: 1, project: "shop", goal: null, task: "Billing", agent: "codex", model: null, mode: "ask", branch: "lane/01", worktree: root, terminal: "t", hostUnit: null, base: git.baseName ?? "trunk", state: "working", colour: "lc1" });
  await writeFile(join(root, RECIPE_FILE), JSON.stringify(recipe));
  store.approveRecipe("shop", (await readRecipe(store, store.getProject("shop")!, root))!.hash);
  const send = () => app.inject({ method: "POST", url: "/api/lanes/shop/01/tools/checkpoint", payload: { summary: "Invoices" } });
  return { root, app, store, state, send, calls, repair, checker };
}

describe("packet pieces", () => {
  it("sizes a diff, counting binary files as zero lines", () => {
    expect(parseNumstat("128\t4\tbilling/invoice.py\n-\t-\tlogo.png\n")).toEqual([{ path: "billing/invoice.py", added: 128, removed: 4 }, { path: "logo.png", added: 0, removed: 0 }]);
  });
  const event = (seq: number, type: string, payload: unknown) => ({ lane: "shop/01", seq, at: "", type, payload }) as LaneEvent;
  const edit = event(1, "tool.call", { callId: "e", kind: "edit", title: "Edit", files: [], status: "completed" });
  it("reports observed checks without judging plan wording", () => {
    const test = event(2, "tool.call", { callId: "t", kind: "execute", title: "Run pnpm test", files: [], status: "in_progress" });
    const done = event(3, "tool.update", { callId: "t", status: "completed" });
    expect(processSignal([edit, test, done], [], true, []).signal).toBe("strong");
    expect(processSignal([test, done, event(4, "tool.call", { callId: "e", kind: "edit", title: "Edit", files: [], status: "completed" })], [], true, []).process[0]).toEqual({ label: "Ran the tests after the last change", ok: false });
    expect(processSignal([edit, test, done], [], true, ["ops/deploy.yaml"]).signal).toBe("strong");
    expect(processSignal([edit], [{ name: "T", passed: false, ms: 1, detail: "" }], false, []).signal).toBe("weak");
  });
});

describe("checkpoint", () => {
  it("tests the real merged target and catches a regression introduced by the new base", async () => {
    const root = await mkdtemp(join(tmpdir(), "cl-checker-git-")); roots.push(root);
    const repo = join(root, "repo"), remote = join(root, "origin.git"), worktree = join(root, "lane");
    await mkdir(repo);
    const git = (cwd: string, ...args: string[]) => runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd });
    await git(root, "init", "--bare", remote);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "Test"); await git(repo, "config", "user.email", "test@example.invalid");
    await writeFile(join(repo, "value"), "good");
    await writeFile(join(repo, RECIPE_FILE), JSON.stringify({ checks: [{ name: "Acceptance", command: [process.execPath, "check.cjs"] }] }));
    await git(repo, "add", "."); await git(repo, "commit", "-m", "base");
    await git(repo, "remote", "add", "origin", remote); await git(repo, "push", "-u", "origin", "main");
    await git(repo, "worktree", "add", "-b", "lane/01", worktree, "main");
    await writeFile(join(worktree, "check.cjs"), "if (require('node:fs').readFileSync('value','utf8') !== 'good') process.exit(1);\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-m", "check value");
    await runCommand(process.execPath, ["check.cjs"], { cwd: worktree });
    await writeFile(join(repo, "value"), "bad"); await git(repo, "commit", "-am", "change target"); await git(repo, "push", "origin", "main");
    const target = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
    const store = Store.open(":memory:"), bus = new EventBus();
    store.addProject({ id: "shop", name: "Shop", path: repo });
    store.insertLane({ id: "shop/01", n: 1, project: "shop", goal: null, task: "Check value", agent: "codex", model: null, mode: "ask", branch: "lane/01", worktree, terminal: "t", hostUnit: null, base: "main", state: "working", colour: "lc1" });
    store.approveRecipe("shop", (await readRecipe(store, store.getProject("shop")!, worktree))!.hash);
    // Git and the acceptance command are real; only the systemd service wrapper is substituted.
    const run: Runner = async (cmd, args, options) => {
      if (cmd !== "systemd-run") return runCommand(cmd, args, options);
      const cwd = args.find(a => a.startsWith("--working-directory="))!.slice("--working-directory=".length);
      expect(cwd).not.toBe(worktree);
      // A concurrent edit that is restored afterward must never influence the checked source.
      await writeFile(join(worktree, "value"), "good");
      try { return await runCommand(process.execPath, ["check.cjs"], { cwd }); }
      finally { await writeFile(join(worktree, "value"), "bad"); }
    };
    const config = Config.parse({ paths: { data: join(root, "data"), lanes: root } });
    const runtime = new Runtime({ store, bus, config, run });
    const checker = new Checker({ store, bus, config, run, runtime });
    await checker.begin("shop/01", "Check value");
    await vi.waitFor(() => expect(store.eventsOfType(["check.result"], { lanes: ["shop/01"] })).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ name: "Acceptance", passed: false }) })])));
    await git(worktree, "merge-base", "--is-ancestor", target, "HEAD");
    expect(store.latestCheckpoint("shop/01")).toBeNull();
    expect(store.getLane("shop/01")!.state).toBe("working");
    await checker.close();
    store.close();
  });

  it("runs checks, stores the row, records the events and moves the lane to review", async () => {
    const { app, store, send } = await setup();
    store.appendEvent("shop/01", { type: "agent.plan", payload: { entries: [{ text: "Invoice table", status: "completed" }, { text: "Webhook stub", status: "pending" }] } });
    expect((await send()).statusCode).toBe(202);
    await vi.waitFor(() => expect(store.getLane("shop/01")!.state).toBe("in_review"));
    const [row] = (await app.inject({ url: "/api/projects/shop/checkpoints" })).json();
    expect(row).toMatchObject({ lane: "shop/01", base: "base000", head: "abc123", summary: "Invoices", checks: [{ name: "Tests", passed: true }], unplanned: [], decision: null });
    expect(row.files).toHaveLength(3);
    expect(row.plan).toHaveLength(2);
    const types = store.events("shop/01").map((e) => e.type);
    expect(types.filter((t) => t !== "checkpoint.judged").slice(-3)).toEqual(["check.result", "checkpoint.created", "lane.state"]);
    // Every new checkpoint goes to the judge; with no local model it says so.
    await vi.waitFor(() => expect(store.checkpoint(row.id)!.judge).toMatchObject({ state: "off" }));
    expect(store.inbox()).toMatchObject([{ kind: "review", lane: "shop/01" }]);
  });

  it("builds once when the agent's tool and the owner's button ask at the same moment", async () => {
    const { store, send } = await setup();
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409]);
    expect((a.statusCode === 409 ? a : b).json().error).toMatch(/already running/);
    await vi.waitFor(() => expect(store.getLane("shop/01")!.state).toBe("in_review"));
    expect(store.events("shop/01").filter((e) => e.type === "checkpoint.created")).toHaveLength(1);
  });

  it("frees the guard when a check before building refuses", async () => {
    const { state, send } = await setup({ dirty: " M a.py" });
    expect((await send()).statusCode).toBe(409);
    state.dirty = "";
    expect((await send()).statusCode).toBe(202);
  });

  it("keeps failed checks out of review and requests at most two repair turns", async () => {
    const { store, send, repair, app } = await setup({ checkFails: true });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await send();
      await vi.waitFor(() => expect(store.eventsOfType(["check.result"], { lanes: ["shop/01"] }).filter(e => e.payload.name === "Tests")).toHaveLength(attempt));
      await vi.waitFor(() => expect(attempt < 3 ? repair.mock.calls.length : store.getLane("shop/01")!.state).toBe(attempt < 3 ? attempt : "needs_you"));
    }
    expect(repair).toHaveBeenCalledTimes(2);
    expect(store.latestCheckpoint("shop/01")).toBeNull();
    expect(store.eventsOfType(["checkpoint.repair_requested"], { lanes: ["shop/01"] })).toHaveLength(2);
    expect(store.pendingCommands("shop/01")).toHaveLength(2);
    expect(store.inbox()).toMatchObject([{ kind: "question", lane: "shop/01" }]);
    // Owner guidance resolves the pause for ACP too, and grants a fresh bounded repair cycle.
    expect((await app.inject({ method: "POST", url: "/api/lanes/shop/01/prompt", payload: { text: "Fix the failing assertion using the recorded requirement." } })).statusCode).toBe(202);
    expect(store.getLane("shop/01")!.state).toBe("working");
    expect(store.inbox()).toEqual([]);
    await send();
    await vi.waitFor(() => expect(repair).toHaveBeenCalledTimes(3));
    expect(store.eventsOfType(["checkpoint.repair_requested"], { lanes: ["shop/01"] }).at(-1)!.payload.attempt).toBe(1);
  });

  it("refuses uncommitted work, an empty lane and a lane that is not working", async () => {
    const dirty = await setup({ dirty: " M app.py\n" });
    expect((await dirty.send()).json().error).toMatch(/Commit your changes first/);
    const empty = await setup({ ahead: "0" });
    expect((await empty.send()).json().error).toMatch(/no commits/);
    const waiting = await setup();
    waiting.store.setLaneState("shop/01", "needs_you");
    expect((await waiting.send()).statusCode).toBe(409);
  });

  it("refuses an unapproved recipe rather than skipping its checks", async () => {
    const { root, store, send } = await setup();
    await writeFile(join(root, RECIPE_FILE), JSON.stringify({ checks: [] }));
    const res = await send();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/needs the owner's approval/);
    expect(store.latestCheckpoint("shop/01")).toBeNull();
  });

  it("will not review commits it did not check", async () => {
    const { store, state, send } = await setup();
    const original = store.appendEvent.bind(store);
    vi.spyOn(store, "appendEvent").mockImplementation((lane, ev, source) => { if (ev.type === "check.result" && ev.payload.name === "Tests") state.head = "def456"; return original(lane, ev, source); });
    await send();
    await vi.waitFor(() => expect(store.events("shop/01").at(-1)).toMatchObject({ type: "check.result", payload: { name: "Checkpoint", passed: false } }));
    expect(store.getLane("shop/01")!.state).toBe("working");
    expect(store.latestCheckpoint("shop/01")).toBeNull();
  });

  it("binds evidence to the fetched target and recipe bytes", async () => {
    const { store, send, calls } = await setup();
    await send();
    await vi.waitFor(() => expect(store.latestCheckpoint("shop/01")).toBeTruthy());
    expect(store.latestCheckpoint("shop/01")).toMatchObject({ base: "base000", head: "abc123", recipeHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(calls).toContainEqual(["git", "fetch", "origin", "+refs/heads/trunk:refs/remotes/origin/trunk"]);
  });

  it("accepts a benchmark pinned commit without trying to fetch it as a branch", async () => {
    const pinned = "a".repeat(40);
    const { store, send, calls } = await setup({ baseName: pinned });
    await send();
    await vi.waitFor(() => expect(store.latestCheckpoint("shop/01")).toBeTruthy());
    expect(calls.some(c => c[0] === "git" && c[1] === "fetch")).toBe(false);
    expect(calls).toContainEqual(["git", "rev-parse", `${pinned}^{commit}`]);
  });

  it("refuses check results after the working tree changes", async () => {
    const { store, state, send } = await setup();
    const append = store.appendEvent.bind(store);
    vi.spyOn(store, "appendEvent").mockImplementation((lane, event, source) => {
      if (event.type === "check.result" && event.payload.name === "Tests") state.dirty = " M app.py";
      return append(lane, event, source);
    });
    await send();
    await vi.waitFor(() => expect(store.events("shop/01").at(-1)).toMatchObject({ type: "check.result", payload: { name: "Checkpoint", passed: false } }));
    expect(store.latestCheckpoint("shop/01")).toBeNull();
  });

  it("serves only this checkpoint's screenshots", async () => {
    const { app, store, send } = await setup();
    await send();
    await vi.waitFor(() => expect(store.latestCheckpoint("shop/01")).toBeTruthy());
    const { id } = store.latestCheckpoint("shop/01")!;
    expect((await app.inject({ url: `/api/checkpoints/${id}/shots/0-before.png` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/checkpoints/${id}/shots/..%2F..%2Fcontextlanes.sqlite` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/checkpoints/${id}/diff?file=${encodeURIComponent("/etc/passwd")}` })).statusCode).toBe(404);
  });
});
