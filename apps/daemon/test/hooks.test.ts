import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HookPayload } from "@contextlanes/protocol";
import { Config, Store, EventBus, HostLinks, LaneManager, buildServer, type Runner } from "@contextlanes/daemon";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const done of cleanup.splice(0).reverse()) await done(); });
async function fixture(auto = false, agent = "claude-code") {
  const root = await mkdtemp("/tmp/cl-hooks-"); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const config = Config.parse({ paths: { data: join(root, "data"), lanes: join(root, "lanes") } });
  const store = Store.open(":memory:"); const bus = new EventBus(); const run: Runner = async () => ({ stdout: "" });
  store.addProject({ id: "demo", name: "Demo", path: root });
  for (const n of [1, 2]) store.insertLane({ id: `demo/0${n}`, project: "demo", n, task: "Write hi", agent, kind: "cli", goal: null, model: null, mode: "ask", auto, branch: `lane/${n}`, base: "main", worktree: "/workspace", terminal: `t${n}`, hostUnit: null, state: "working", colour: "lc1" });
  const headers = { authorization: `Bearer ${store.mintLaneToken("demo/01")}` };
  const owner = { authorization: `Bearer ${store.ownerSession()}` };
  const hosts = new HostLinks({ store, bus }); const lanes = new LaneManager({ store, bus, config, run });
  const app = buildServer({ store, bus, config, run, lanes, hosts, version: "test" }); cleanup.push(() => app.close()); cleanup.push(async () => store.close());
  const envelope = (event: HookPayload["hook_event_name"], more: Partial<HookPayload> = {}) => ({ eventId: randomUUID(), payload: { hook_event_name: event, session_id: "session-one", cwd: "/workspace", ...more } });
  const post = (body: object, lane = "demo/01", auth = headers) => app.inject({ method: "POST", url: `/api/lanes/${lane}/hooks`, headers: auth, payload: body });
  const answer = (requestId: string, optionId = "allow") => app.inject({ method: "POST", url: "/api/answers", headers: owner, payload: { lane: "demo/01", requestId, optionId, message: "Please use a local fixture." } });
  return { root, config, store, app, headers, post, envelope, answer };
}
describe("native hook bridge", () => {
  it.each(["claude", "codex"])("replays real %s lifecycle fixtures through the authenticated API", async (agent) => {
    const f = await fixture(false, agent === "claude" ? "claude-code" : "codex");
    const load = async (event: string) => JSON.parse(await readFile(new URL(`./fixtures/hooks/${agent}/${event}.json`, import.meta.url), "utf8")) as HookPayload;
    const session = await load("SessionStart");
    if (agent === "codex") {
      const dir = join(f.config.paths.data, "cli", "demo-01", "agent", "sessions"); await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `rollout-fixture-${session.session_id}.jsonl`), await readFile(new URL("./fixtures/hooks/codex/session.jsonl", import.meta.url)));
    }
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"]) {
      const result = await f.post({ eventId: randomUUID(), payload: await load(event) }); expect(result.statusCode).toBe(200);
      if (event === "PermissionRequest") {
        const requestId = result.json().requestId;
        expect(f.store.permission("demo/01", requestId)!.tool!.callId).toBe("tool-call-one");
        expect((await f.answer(requestId)).statusCode).toBe(202);
      }
    }
    expect(f.store.inbox()).toEqual([]);
    expect(f.store.eventsOfType(["agent.turn"]).at(-1)!.payload.active).toBe(false);
    expect(f.store.eventsOfType(["tool.call"])).toHaveLength(1);
    if (agent === "codex") { expect(f.store.eventsOfType(["tool.update"]).at(-1)!.payload.exitCode).toBe(0); expect(f.store.eventsOfType(["usage.turn"])).toHaveLength(1); }
    else { expect((await f.post({ eventId: randomUUID(), payload: await load("Notification") })).statusCode).toBe(200); expect(f.store.eventsOfType(["agent.notice"])).toHaveLength(1); }
  });
  it("accepts only this lane's token and validates payloads", async () => {
    const f = await fixture(); const b = f.envelope("SessionStart");
    expect((await f.post(b, "demo/02")).statusCode).toBe(401);
    expect((await f.post({}, "demo/01", { authorization: "" })).statusCode).toBe(401);
    expect((await f.post({ eventId: b.eventId, payload: { ...b.payload, session_id: 12 } })).statusCode).toBe(400);
    expect((await f.post(b)).statusCode).toBe(200);
    expect((await f.app.inject({ method: "POST", url: "/api/answers", headers: f.headers, payload: { lane: "demo/01", requestId: "x", optionId: "allow" } })).statusCode).toBe(401);
  });
  it("adds project notes at session start and marks actual turns busy and idle", async () => {
    const f = await fixture(); await mkdir(join(f.config.paths.data, "notes"), { recursive: true }); await writeFile(join(f.config.paths.data, "notes", "demo.md"), "Use the fixture database.");
    const b = f.envelope("SessionStart", { transcript_path: "/workspace/transcript.jsonl" });
    expect((await f.post(b)).json()).toMatchObject({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: expect.stringContaining("fixture database") } });
    await f.post(b); expect(f.store.eventsOfType(["agent.session"])).toHaveLength(1);
    await f.post(f.envelope("UserPromptSubmit", { prompt: "Write hi" }));
    await f.post(f.envelope("Stop", { last_assistant_message: "Done" }));
    expect(f.store.eventsOfType(["agent.turn"]).map((e) => e.payload.active)).toEqual([true, false]);
    expect(f.store.eventsOfType(["agent.message"]).map((e) => e.payload.text)).toEqual(["Write hi", "Done"]);
  });
  it("denies dire pre-tools even in Auto, including when an HTTP response is retried", async () => {
    const f = await fixture(true);
    const b = f.envelope("PreToolUse", { tool_name: "Bash", tool_use_id: "call", tool_input: { command: "git push --force origin main" } });
    const result = (await f.post(b)).json();
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("force") } });
    expect((await f.post(b)).json()).toEqual(result);
    expect(f.store.eventsOfType(["tool.call"])).toHaveLength(1);
    expect(f.store.eventsOfType(["permission.answered"])).toHaveLength(0);
  });
  it("waits for the owner's single-use answer and returns a native decision", async () => {
    const f = await fixture();
    await f.post(f.envelope("PreToolUse", { tool_name: "Bash", tool_use_id: "call", tool_input: { command: "pwd" } }));
    const b = f.envelope("PermissionRequest", { tool_name: "Bash", tool_input: { command: "pwd" } });
    const pending = (await f.post(b)).json(); expect(pending.pending).toBe(true);
    expect(f.store.getLane("demo/01")!.state).toBe("needs_you");
    expect((await f.answer(pending.requestId, "deny")).statusCode).toBe(202);
    expect((await f.answer(pending.requestId)).statusCode).toBe(409);
    expect((await f.post(b)).json()).toMatchObject({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Please use a local fixture." } } });
    expect(f.store.getLane("demo/01")!.state).toBe("working");
    expect(f.store.pendingCommands("demo/01")).toEqual([]);
  });
  it("clears a permission observed as answered in the terminal, without granting the waiting hook", async () => {
    const f = await fixture(); const tool = { tool_name: "Bash", tool_input: { command: "pwd" } };
    await f.post(f.envelope("PreToolUse", { ...tool, tool_use_id: "call" }));
    const b = f.envelope("PermissionRequest", tool); await f.post(b);
    await f.post(f.envelope("PostToolUse", { ...tool, tool_use_id: "call", tool_response: { stdout: "x".repeat(13_000), exit_code: 0 } }));
    expect(f.store.inbox()).toEqual([]);
    expect((await f.post(b)).json()).toEqual({});
    expect(f.store.eventsOfType(["permission.answered"])[0]!.payload).toMatchObject({ by: "terminal", optionId: null });
    const update = f.store.eventsOfType(["tool.update"])[0]!.payload;
    expect(update.summary!.length).toBe(12_000); expect(update.exitCode).toBe(0);
  });
  it("Auto uses the same answer path for safe tools and holds dire permission requests", async () => {
    const f = await fixture(true);
    const safe = (await f.post(f.envelope("PermissionRequest", { tool_name: "Bash", tool_input: { command: "pwd" } }))).json();
    expect(safe).toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow" } } });
    expect(f.store.eventsOfType(["permission.answered"])[0]!.payload.by).toBe("auto");
    expect((await f.post(f.envelope("PermissionRequest", { tool_name: "Bash", tool_input: { command: "git push --force" } }))).json()).toMatchObject({ pending: true });
    expect(f.store.eventsOfType(["permission.requested"]).at(-1)!.payload.held).toContain("force");
  });
  it("a new native turn clears a hook request whose completion was missed while the daemon was down", async () => {
    const f = await fixture();
    await f.post(f.envelope("PermissionRequest", { tool_name: "Bash", tool_input: { command: "pwd" } }));
    f.store.appendEvent("demo/01", { type: "permission.requested", payload: { requestId: "question", title: "Owner question", kind: "question", options: [] } });
    await f.post(f.envelope("UserPromptSubmit", { prompt: "Carry on" }));
    expect(f.store.inbox().map((i) => i.id)).toEqual(["demo/01#question"]);
    expect(f.store.eventsOfType(["permission.answered"])[0]!.payload.by).toBe("terminal");
  });
  it("reuses native JSONL usage and preserves the cumulative snapshot across daemon reconstruction", async () => {
    const f = await fixture(); const session = "11111111-1111-4111-8111-111111111111";
    const dir = join(f.config.paths.data, "cli", "demo-01", "agent", "projects", "fixture"); await mkdir(dir, { recursive: true });
    const log = (tokens: number) => JSON.stringify({ cwd: "/workspace", sessionId: session, type: "assistant", message: { id: "m", usage: { input_tokens: tokens, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + "\n";
    await writeFile(join(dir, `${session}.jsonl`), log(10)); await f.post(f.envelope("Stop", { session_id: session }));
    await writeFile(join(dir, `${session}.jsonl`), log(15)); await f.post(f.envelope("Stop", { session_id: session }));
    expect(f.store.eventsOfType(["usage.turn"]).map((e) => e.payload.inputTokens)).toEqual([10, 5]);
    expect(f.store.eventsOfType(["usage.snapshot"])).toHaveLength(2);
  });
});
