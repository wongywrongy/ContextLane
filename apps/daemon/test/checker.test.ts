import { signedIn } from "./signed-in.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RECIPE_FILE, type LaneEvent } from "@contextlanes/protocol";
import { buildServer, Checker, Config, EventBus, HostLinks, LaneManager, parseNumstat, processSignal, Runtime, Store, unplannedFiles, type Runner } from "@contextlanes/daemon";
import { readRecipe } from "../src/recipes.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

type Git = { dirty?: string; ahead?: string; checkFails?: boolean };
async function setup(git: Git = {}, recipe: unknown = { checks: [{ name: "Tests", command: ["pnpm", "test"] }] }) {
  const root = await mkdtemp(join(tmpdir(), "cl-checker-"));
  roots.push(root);
  const state = { head: "abc123", ...git };
  const run: Runner = async (cmd, args) => {
    if (cmd === "git" && args[0] === "status") return { stdout: state.dirty ?? "" };
    if (cmd === "git" && args[0] === "merge-base") return { stdout: "base000\n" };
    if (cmd === "git" && args[0] === "rev-list") return { stdout: `${state.ahead ?? "2"}\n` };
    if (cmd === "git" && args[0] === "rev-parse") return { stdout: `${state.head}\n` };
    if (cmd === "git" && args[0] === "diff") return { stdout: "128\t4\tbilling/invoice.py\n3\t0\tREADME.md\n-\t-\tlogo.png\n" };
    if (cmd === "systemd-run" && args.includes("--wait") && state.checkFails) throw Object.assign(new Error("exit 1"), { stdout: "2 failed\n" });
    return { stdout: "" };
  };
  const config = Config.parse({ paths: { data: root, lanes: root } });
  const store = Store.open(":memory:");
  const bus = new EventBus();
  const runtime = new Runtime({ store, bus, config, run });
  const checker = new Checker({ store, bus, config, run, runtime, shoot: async () => {} });
  const app = signedIn(buildServer({ store, bus, lanes: new LaneManager({ store, bus, config, run }), hosts: new HostLinks({ store, bus }), config, version: "test", run, runtime, checker }), store);
  store.addProject({ id: "shop", name: "Shop", path: root });
  store.insertLane({ id: "shop/01", n: 1, project: "shop", goal: null, task: "Billing", agent: "codex", model: null, mode: "ask", branch: "lane/01", worktree: root, terminal: "t", hostUnit: null, base: "trunk", state: "working", colour: "lc1" });
  await writeFile(join(root, RECIPE_FILE), JSON.stringify(recipe));
  store.approveRecipe("shop", (await readRecipe(store, store.getProject("shop")!, root))!.hash);
  const send = () => app.inject({ method: "POST", url: "/api/lanes/shop/01/tools/checkpoint", payload: { summary: "Invoices" } });
  return { root, app, store, state, send };
}

describe("packet pieces", () => {
  it("sizes a diff, counting binary files as zero lines", () => {
    expect(parseNumstat("128\t4\tbilling/invoice.py\n-\t-\tlogo.png\n")).toEqual([{ path: "billing/invoice.py", added: 128, removed: 4 }, { path: "logo.png", added: 0, removed: 0 }]);
  });
  it("flags changed files the plan never mentions", () => {
    expect(unplannedFiles(["billing/invoice.py", "db/fees.sql", "ops/deploy.yaml"], ["Invoice table with a draft status", "Generate from club fees"])).toEqual(["ops/deploy.yaml"]);
  });
  const event = (seq: number, type: string, payload: unknown) => ({ lane: "shop/01", seq, at: "", type, payload }) as LaneEvent;
  const edit = event(1, "tool.call", { callId: "e", kind: "edit", title: "Edit", files: [], status: "completed" });
  it("is strong only when the log shows tests after the last edit and the plan held", () => {
    const test = event(2, "tool.call", { callId: "t", kind: "execute", title: "Run pnpm test", files: [], status: "in_progress" });
    const done = event(3, "tool.update", { callId: "t", status: "completed" });
    expect(processSignal([edit, test, done], [], true, []).signal).toBe("strong");
    expect(processSignal([test, done, event(4, "tool.call", { callId: "e", kind: "edit", title: "Edit", files: [], status: "completed" })], [], true, []).process[0]).toEqual({ label: "Ran the tests after the last change", ok: false });
    expect(processSignal([edit, test, done], [], true, ["ops/deploy.yaml"]).signal).toBe("mixed");
    expect(processSignal([edit], [{ name: "T", passed: false, ms: 1, detail: "" }], false, []).signal).toBe("weak");
  });
});

describe("checkpoint", () => {
  it("runs checks, stores the row, records the events and moves the lane to review", async () => {
    const { app, store, send } = await setup();
    store.appendEvent("shop/01", { type: "agent.plan", payload: { entries: [{ text: "Invoice table", status: "completed" }, { text: "Webhook stub", status: "pending" }] } });
    expect((await send()).statusCode).toBe(202);
    await vi.waitFor(() => expect(store.getLane("shop/01")!.state).toBe("in_review"));
    const [row] = (await app.inject({ url: "/api/projects/shop/checkpoints" })).json();
    expect(row).toMatchObject({ lane: "shop/01", base: "base000", head: "abc123", summary: "Invoices", checks: [{ name: "Tests", passed: true }], unplanned: ["README.md", "logo.png"], decision: null });
    expect(row.files).toHaveLength(3);
    expect(row.plan).toHaveLength(2);
    const types = store.events("shop/01").map((e) => e.type);
    expect(types.slice(-3)).toEqual(["check.result", "checkpoint.created", "lane.state"]);
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

  it("still stores a checkpoint whose checks failed, for the owner to see", async () => {
    const { store, send } = await setup({ checkFails: true });
    await send();
    await vi.waitFor(() => expect(store.getLane("shop/01")!.state).toBe("in_review"));
    expect(store.latestCheckpoint("shop/01")!.checks).toMatchObject([{ name: "Tests", passed: false, detail: "2 failed" }]);
    expect(store.latestCheckpoint("shop/01")!.signal).not.toBe("strong");
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
