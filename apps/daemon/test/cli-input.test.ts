import { cliToken } from "./signed-in.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Config, Store, EventBus, HostLinks, LaneManager, buildServer, type Runner } from "@contextlanes/daemon";
import { CliInputs } from "../src/lanes/input.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function fixture(http = true) {
  const root = await mkdtemp("/tmp/cl-cli-input-"); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = Store.open(":memory:"); cleanups.push(async () => store.close());
  const bus = new EventBus(); const calls: string[][] = []; const pasted: string[] = [];
  const run: Runner = async (cmd, args) => { calls.push([cmd, ...args]); if (cmd === "tmux" && args[0] === "load-buffer") pasted.push(await readFile(args.at(-1)!, "utf8")); return { stdout: "" }; };
  const config = Config.parse({ paths: { data: root, lanes: join(root, "lanes") } });
  store.addProject({ id: "demo", name: "Demo", path: root });
  store.insertLane({ id: "demo/01", n: 1, project: "demo", task: "Task", agent: "claude-code", kind: "cli", goal: null, model: null, mode: "ask", branch: "lane/01", worktree: root, terminal: "cl-demo-01", hostUnit: null, base: "main", state: "working", colour: "lc1" });
  const hosts = new HostLinks({ store, bus }); const lanes = new LaneManager({ store, bus, config, run });
  const app = http ? buildServer({ store, bus, config, run, hosts, lanes, version: "test" }) : null;
  if (app) cleanups.push(() => app.close());
  const turn = (active: boolean) => bus.publish(store.appendEvent("demo/01", { type: "agent.turn", payload: { active } }));
  const post = (text: string, immediate = false) => app!.inject({ method: "POST", url: "/api/lanes/demo/01/prompt", headers: { authorization: `Bearer ${cliToken(config)}` }, payload: { text, immediate } });
  return { store, bus, config, run, calls, pasted, hosts, app, turn, post };
}
describe("CLI input", () => {
  it("queues while busy, pastes one multi-line message at Stop and waits for the next native turn", async () => {
    const f = await fixture(); f.turn(true);
    expect((await f.post("First line\nSecond line ✓", true)).statusCode).toBe(202);
    await f.post("Another task"); expect(f.pasted).toEqual([]);
    f.turn(false); await vi.waitFor(() => expect(f.store.eventsOfType(["agent.input"]).filter((e) => e.payload.phase === "sent")).toHaveLength(1));
    expect(f.pasted).toEqual(["First line\nSecond line ✓"]);
    const paste = f.calls.find((c) => c[1] === "paste-buffer")!;
    expect(paste).toEqual(["tmux", "paste-buffer", "-d", "-p", "-b", expect.stringMatching(/^cl-/), "-t", "=cl-demo-01:"]);
    expect(f.calls.findIndex((c) => c[1] === "send-keys" && c.at(-1) === "Enter")).toBeGreaterThan(f.calls.indexOf(paste));
    expect((await f.app!.inject({ method: "POST", url: "/api/lanes/demo/01/hooks", headers: { authorization: `Bearer ${cliToken(f.config)}` }, payload: { eventId: randomUUID(), payload: { hook_event_name: "UserPromptSubmit", session_id: "native-session", cwd: f.config.paths.data, prompt: "First line\nSecond line ✓" } } })).statusCode).toBe(200);
    expect(f.store.eventsOfType(["agent.message"]).map((e) => e.payload.text)).toEqual(["First line\nSecond line ✓", "Another task"]);
    expect(f.store.eventsOfType(["agent.turn"]).at(-1)!.payload.commandId).toBe(f.store.eventsOfType(["agent.command"])[0]!.payload.commandId);
    expect(f.pasted).toHaveLength(1); f.turn(false);
    await vi.waitFor(() => expect(f.pasted).toEqual(["First line\nSecond line ✓", "Another task"]));
  });
  it("sends Escape while busy, without sending the queued prompt", async () => {
    const f = await fixture(); f.turn(true); await f.post("Wait for idle");
    expect((await f.app!.inject({ method: "POST", url: "/api/lanes/demo/01/cancel", headers: { authorization: `Bearer ${cliToken(f.config)}` }, payload: {} })).statusCode).toBe(202);
    await vi.waitFor(() => expect(f.calls).toContainEqual(["tmux", "send-keys", "-t", "=cl-demo-01:", "Escape"]));
    expect(f.pasted).toEqual([]);
  });
  it("passes slash commands as typed and does not wait for a model turn from a native menu", async () => {
    const f = await fixture(); f.turn(false); await f.post("/help");
    await vi.waitFor(() => expect(f.store.pendingCommands("demo/01")).toHaveLength(0));
    await f.post("A normal message"); await vi.waitFor(() => expect(f.pasted).toEqual(["/help", "A normal message"]));
  });
  it("keeps an unstarted prompt across reconstruction, and never silently replays an uncertain paste", async () => {
    const f = await fixture(false); f.turn(false);
    const commandId = randomUUID();
    f.store.appendEvent("demo/01", { type: "agent.command", payload: { commandId, command: { kind: "prompt", text: "Already being pasted", immediate: false, files: [], images: [] } } });
    f.store.appendEvent("demo/01", { type: "agent.input", payload: { commandId, phase: "sending" } });
    const input = new CliInputs(f); cleanups.push(() => input.close());
    await vi.waitFor(() => expect(f.store.pendingCommands("demo/01")).toHaveLength(0));
    expect(f.pasted).toEqual([]);
    expect(f.store.eventsOfType(["agent.command.result"])[0]!.payload).toMatchObject({ ok: false, error: expect.stringContaining("Check the terminal") });
    f.hosts.command("demo/01", { kind: "prompt", text: "Next task", immediate: false, files: [], images: [] });
    expect(f.pasted).toEqual([]); f.turn(false);
    await vi.waitFor(() => expect(f.pasted).toEqual(["Next task"]));
  });
});
