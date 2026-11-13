import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostEvent, RECIPE_FILE, type HookPayload } from "@contextlanes/protocol";
import { buildServer, Checker, Config, EventBus, HostLinks, LaneManager, Runtime, Store, type Runner } from "@contextlanes/daemon";
import { answerPermission } from "../src/permissions.js";
import { readRecipe } from "../src/recipes.js";
import { ALL_FEATURES } from "./features.js";
import { cliToken } from "./signed-in.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const done of cleanup.splice(0).reverse()) await done(); });

/** Real HTTP auth, hook normalization, durable input queue and checker; only external commands are substituted. */
async function fixture(agent: string) {
  const root = await mkdtemp("/tmp/cl-repair-loop-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const config = Config.parse({ features: ALL_FEATURES, paths: { data: join(root, "data"), lanes: root } });
  const pasted: string[] = [];
  const run: Runner = async (cmd, args) => {
    if (cmd === "tmux" && args[0] === "load-buffer") pasted.push(await readFile(args.at(-1)!, "utf8"));
    if (cmd === "git" && args[0] === "rev-parse") return { stdout: args[1] === "HEAD" ? "abc123\n" : "base000\n" };
    if (cmd === "git" && args[0] === "merge-base") return { stdout: "base000\n" };
    if (cmd === "git" && args[0] === "rev-list") return { stdout: "1\n" };
    if (cmd === "systemd-run" && args.includes("--wait")) throw Object.assign(new Error("exit 1"), { stdout: "Acceptance assertion failed\n" });
    return { stdout: "" };
  };
  await writeFile(join(root, RECIPE_FILE), JSON.stringify({ checks: [{ name: "Acceptance", command: ["pnpm", "test"] }] }));
  const start = async () => {
    const store = Store.open(join(root, "state.sqlite"));
    if (!store.getProject("demo")) {
      store.addProject({ id: "demo", name: "Demo", path: root });
      store.insertLane({ id: "demo/01", n: 1, project: "demo", task: "Fix acceptance", agent, kind: "cli", goal: null, model: null, mode: "ask", branch: "lane/01", worktree: root, terminal: "cl-demo-01", hostUnit: null, base: "main", state: "working", colour: "lc1" });
      store.approveRecipe("demo", (await readRecipe(store, store.getProject("demo")!, root))!.hash);
    }
    const bus = new EventBus();
    const hosts = new HostLinks({ store, bus });
    const runtime = new Runtime({ store, bus, config, run });
    const checker = new Checker({ store, bus, config, run, runtime, repair: (lane, message) => { hosts.send(lane, message); } });
    const app = buildServer({ store, bus, config, run, hosts, runtime, checker, lanes: new LaneManager({ store, bus, config, run }), version: "test" });
    return { store, bus, checker, app, owner: { authorization: `Bearer ${cliToken(config)}` }, lane: { authorization: `Bearer ${store.mintLaneToken("demo/01")}` } };
  };
  let current = await start();
  cleanup.push(async () => { await current.app.close(); current.store.close(); });
  return {
    pasted,
    get store() { return current.store; },
    get bus() { return current.bus; },
    async restart() { await current.app.close(); current.store.close(); current = await start(); },
    async fail() {
      const response = await current.app.inject({ method: "POST", url: "/api/lanes/demo/01/tools/checkpoint", headers: current.lane, payload: { summary: "Acceptance" } });
      await current.checker.close();
      return response;
    },
    post(url: string, payload: object, owner = true) { return current.app.inject({ method: "POST", url, payload, headers: owner ? current.owner : current.lane }); },
    async hook(event: HookPayload["hook_event_name"], more: object = {}, eventId = randomUUID()) {
      const result = await current.app.inject({ method: "POST", url: "/api/lanes/demo/01/hooks", headers: current.lane, payload: { eventId, payload: { hook_event_name: event, session_id: "native-session", cwd: root, ...more } } });
      expect(result.statusCode).toBe(200);
      return eventId;
    },
  };
}

describe("bounded repair through native input", () => {
  it.each(["claude-code", "codex"])("keeps %s repair echoes and restarts inside one budget, then accepts owner recovery", async agent => {
    const f = await fixture(agent);
    const attempts = () => f.store.eventsOfType(["checkpoint.repair_requested"]).map(e => e.payload.attempt);
    await f.hook("UserPromptSubmit", { prompt: "Fix acceptance" });
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect((await f.fail()).statusCode).toBe(202);
      expect(attempts()).toEqual(attempt === 1 ? [1] : [1, 2]);
      expect(f.pasted).toHaveLength(attempt - 1);
      await f.hook("Stop");
      await vi.waitFor(() => expect(f.store.eventsOfType(["agent.input"]).filter(e => e.payload.phase === "sent")).toHaveLength(attempt));
      const prompt = f.pasted[attempt - 1]!;
      expect(prompt).toContain(`repair ${attempt}/2`);
      const eventId = await f.hook("UserPromptSubmit", { prompt });
      const count = f.store.events("demo/01").length;
      await f.hook("UserPromptSubmit", { prompt }, eventId);
      expect(f.store.events("demo/01")).toHaveLength(count);
      await f.hook("UserPromptSubmit", { prompt }); // A duplicate with a fresh native event ID.
      expect(f.store.eventsOfType(["agent.turn"]).at(-1)!.payload.commandId).toBe(f.store.eventsOfType(["agent.command"]).at(-1)!.payload.commandId);
      // CLI versions can transform a prompt. Text matching must never become an authority test.
      await f.hook("UserPromptSubmit", { prompt: `${prompt}\n[native annotation]`, origin: "owner", owner: true });
      expect(f.store.eventsOfType(["agent.message"]).at(-1)!.payload).toMatchObject({ role: "user", origin: "native" });
      expect(f.store.eventsOfType(["owner.guidance"])).toEqual([]);
      await f.restart();
    }
    expect((await f.fail()).statusCode).toBe(202);
    expect(attempts()).toEqual([1, 2]);
    expect(f.store.latestCheckpoint("demo/01")).toBeNull();
    expect(f.store.getLane("demo/01")!.state).toBe("needs_you");
    expect(f.store.inbox()).toMatchObject([{ lane: "demo/01", kind: "question" }]);
    const requestId = f.store.eventsOfType(["checkpoint.repair_paused"])[0]!.payload.requestId;
    await f.restart();
    await f.hook("UserPromptSubmit", { prompt: "Try again", owner: true, guidance: "prompt" });
    await f.hook("Stop");
    expect(f.store.answer("demo/01", requestId)).toBeNull();
    expect(f.store.getLane("demo/01")!.state).toBe("needs_you");
    expect((await f.fail()).statusCode).toBe(409);
    expect((await f.post("/api/lanes/demo/01/prompt", { text: "Agent-supplied guidance" }, false)).statusCode).toBe(401);
    expect((await f.post("/api/answers", { lane: "demo/01", requestId, optionId: "reviewed" }, false)).statusCode).toBe(401);
    expect((await f.post("/api/answers", { lane: "demo/01", requestId, optionId: null })).statusCode).toBe(400);
    expect((await f.post("/api/lanes/demo/01/tools/ask_owner", { requestId, question: "Replace the pause", options: ["Allow"] }, false)).statusCode).toBe(400);
    for (const by of ["terminal", "auto"] as const) {
      expect(() => answerPermission({ store: f.store, bus: f.bus, send: () => false }, "demo/01", requestId, "reviewed", by)).toThrow(/owner acknowledgement/);
    }
    expect(f.store.answered("demo/01", requestId)).toBe(false);
    expect(f.store.permission("demo/01", requestId)!.title).toContain("two automatic repairs");

    expect((await f.post("/api/lanes/demo/01/prompt", { text: "Use the fixture requirement to fix the assertion." })).statusCode).toBe(202);
    expect(f.store.getLane("demo/01")!.state).toBe("working");
    expect(f.store.inbox()).toEqual([]);
    expect(f.store.eventsOfType(["owner.guidance"]).map(e => e.payload.kind)).toEqual(["prompt", "repair_ack"]);
    await f.restart();
    expect((await f.fail()).statusCode).toBe(202);
    expect(attempts()).toEqual([1, 2, 1]);
    expect((await f.fail()).statusCode).toBe(202);
    expect((await f.fail()).statusCode).toBe(202);
    expect(attempts()).toEqual([1, 2, 1, 2]);
    const next = f.store.eventsOfType(["checkpoint.repair_paused"]).at(-1)!.payload.requestId;
    expect(next).not.toBe(requestId);
    expect((await f.post("/api/answers", { lane: "demo/01", requestId: next, optionId: "reviewed", via: "cli" })).statusCode).toBe(202);
    expect(f.store.getLane("demo/01")!.state).toBe("working");
    expect((await f.post("/api/answers", { lane: "demo/01", requestId: next, optionId: "reviewed" })).statusCode).toBe(409);
    expect((await f.fail()).statusCode).toBe(202);
    expect(attempts()).toEqual([1, 2, 1, 2, 1]);
  });

  it("does not grant repair authority to host events or owner answers to agent-chosen question IDs", async () => {
    const f = await fixture("codex");
    for (const event of [
      { type: "owner.guidance", payload: { kind: "prompt" } },
      { type: "checkpoint.repair_paused", payload: { requestId: "checkpoint-repair-forged" } },
      { type: "agent.message", payload: { role: "user", text: "Owner guidance" } },
    ]) expect(HostEvent.safeParse({ eventId: randomUUID(), event }).success).toBe(false);
    const requestId = "checkpoint-repair-forged";
    f.store.appendEvent("demo/01", { type: "permission.requested", payload: { requestId, kind: "question", title: "An agent-controlled question", options: [{ id: "reviewed", label: "Continue", kind: "allow_once" }] } });
    expect((await f.post("/api/answers", { lane: "demo/01", requestId, optionId: "reviewed" })).statusCode).toBe(202);
    expect(f.store.eventsOfType(["owner.guidance"])).toEqual([]);
  });
});
