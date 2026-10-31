import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openAgentSession, runLaneHost } from "@contextlanes/lanehost";
import { buildServer, Config, EventBus, HostLinks, LaneManager, Store, type Runner } from "@contextlanes/daemon";
import type { LaneCommand, NewLaneEvent } from "@contextlanes/protocol";
import { fakeAgent } from "./fake-agent.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const command = (value: LaneCommand) => ({ commandId: randomUUID(), command: value });

it("uses the SDK agent app for streaming, indefinite permissions, MCP, queued prompts, cancel, modes and models", async () => {
  const fake = fakeAgent();
  const events: NewLaneEvent[] = [];
  const session = await openAgentSession({ lane: "demo/01", cwd: "/tmp", task: "permission", agent: { command: "unused", args: [] },
    connect: (client) => client.connect(fake.app), mcpServers: [{ name: "contextlanes", command: "toolbox", args: [], env: [{ name: "CONTEXTLANES_LANE", value: "demo/01" }] }] }, (e) => events.push(e));
  cleanup.push(async () => session.close());
  await vi.waitFor(() => expect(events.some((e) => e.type === "permission.requested")).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(fake.choices).toEqual([]);
  expect(events.some((e) => e.type === "agent.message" && e.payload.text.includes("Started permission"))).toBe(true);
  expect(fake.sessions[0]).toMatchObject({ mcpServers: [{ name: "contextlanes", env: [{ name: "CONTEXTLANES_LANE", value: "demo/01" }] }] });
  const ask = events.find((e) => e.type === "permission.requested")!;
  if (ask.type !== "permission.requested") throw new Error("missing permission");
  await session.command(command({ kind: "answer", requestId: ask.payload.requestId, optionId: "yes" }));
  await vi.waitFor(() => expect(fake.choices).toEqual([{ outcome: "selected", optionId: "yes" }]));
  await session.command(command({ kind: "mode", mode: "plan" }));
  await session.command(command({ kind: "model", model: "large" }));
  expect(fake.modes).toEqual(["default", "plan"]);
  expect(events.some((e) => e.type === "agent.session" && e.payload.currentModel === "large")).toBe(true);
  const hold = command({ kind: "prompt", text: "hold", immediate: false });
  await session.command(hold);
  await session.command(hold);
  await vi.waitFor(() => expect(fake.turns).toContain("hold"));
  await session.command(command({ kind: "prompt", text: "queued", immediate: false }));
  expect(fake.turns).not.toContain("queued");
  await session.command(command({ kind: "prompt", text: "now", immediate: true }));
  await vi.waitFor(() => expect(fake.turns).toEqual(["permission", "hold", "now", "queued"]));
  await session.command(command({ kind: "mode", mode: "bypassPermissions" }));
  expect(events.at(-1)).toMatchObject({ type: "agent.command.result", payload: { ok: false } });
  await session.command(command({ kind: "mode", mode: "agent" }));
  expect(events.at(-1)).toMatchObject({ type: "agent.command.result", payload: { ok: false } });
});

it("retains an ACP permission and replays commands after the daemon socket restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cl-host-test-"));
  const store = Store.open(join(root, "test.sqlite"));
  const bus = new EventBus();
  let hosts = new HostLinks({ store, bus });
  let app: ReturnType<typeof buildServer>;
  const run: Runner = async () => ({ stdout: "" });
  const config = Config.parse({ paths: { data: root, lanes: join(root, "lanes") }, lanes: { launchHosts: false } });
  const lanes = new LaneManager({ store, bus, config, run });
  const session = `Bearer ${store.ownerSession()}`;
  const makeServer = () => buildServer({ store, bus, lanes, config, hosts, run, version: "test" });
  app = makeServer();
  await app.inject({ method: "POST", url: "/api/projects", headers: { authorization: session }, payload: { path: "/code/demo" } });
  await app.inject({ method: "POST", url: "/api/lanes", headers: { authorization: session }, payload: { project: "demo", task: "permission" } });
  const fake = fakeAgent();
  const stop = new AbortController();
  const host = runLaneHost({ lane: "demo/01", cwd: root, task: "permission", agent: { command: "unused", args: [] }, socketPath: join(root, "lanes.sock"), token: store.mintLaneToken("demo/01"), signal: stop.signal, connect: (client) => client.connect(fake.app) });
  cleanup.push(async () => { stop.abort(); await host; await hosts.close(); await app.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  // Start the daemon after the host to also cover initial socket unavailability.
  await hosts.listen(join(root, "lanes.sock"));
  await vi.waitFor(() => expect(store.inbox()).toHaveLength(1));
  expect(store.getLane("demo/01")?.state).toBe("needs_you");
  const requestId = store.inbox()[0]!.id.split("#")[1]!;
  await hosts.close();
  await app.close();
  expect(fake.choices).toEqual([]);
  hosts = new HostLinks({ store, bus });
  app = makeServer();
  const answer = await app.inject({ method: "POST", url: "/api/answers", headers: { authorization: session }, payload: { lane: "demo/01", requestId, optionId: "yes", via: "phone" } });
  expect(answer.json()).toMatchObject({ delivered: false });
  expect(store.pendingCommands("demo/01")).toHaveLength(1);
  await hosts.listen(join(root, "lanes.sock"));
  await vi.waitFor(() => expect(fake.choices).toEqual([{ outcome: "selected", optionId: "yes" }]));
  await vi.waitFor(() => expect(store.pendingCommands("demo/01")).toHaveLength(0));
  expect(store.getLane("demo/01")?.state).toBe("working");
  expect(fake.sessions).toHaveLength(1);
  const result = await app.inject({ method: "POST", url: "/api/lanes/demo/01/prompt", headers: { authorization: session }, payload: { text: "after restart" } });
  expect(result.statusCode).toBe(202);
  await vi.waitFor(() => expect(fake.turns).toContain("after restart"));
  const events = store.events("demo/01");
  expect(events.filter((e) => e.type === "permission.requested")).toHaveLength(1);
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
});

it("starts in the edit mode and nearest effort the owner chose, and changes effort later", async () => {
  const fake = fakeAgent();
  const events: NewLaneEvent[] = [];
  const session = await openAgentSession({ lane: "demo/02", cwd: "/tmp", task: "", agent: { command: "unused", args: [] }, mode: "edits", effort: "high",
    connect: (client) => client.connect(fake.app) }, (e) => events.push(e));
  cleanup.push(async () => session.close());
  expect(fake.modes).toEqual(["acceptEdits"]);
  const last = () => events.findLast((e) => e.type === "agent.session");
  expect(last()).toMatchObject({ payload: { currentEffort: "xhigh", efforts: [{ id: "minimal" }, { id: "medium" }, { id: "xhigh" }] } });
  await session.command(command({ kind: "effort", effort: "low" }));
  expect(last()).toMatchObject({ payload: { currentEffort: "minimal" } });
});
