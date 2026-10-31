import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, EventBus, HostLinks, LaneManager, Store } from "@contextlanes/daemon";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

it("a lane failed by one agent error is working again when the agent takes a new turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "cl-hosts-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = Store.open(":memory:"); cleanups.push(() => store.close());
  const bus = new EventBus(); const hosts = new HostLinks({ store, bus });
  await hosts.listen(join(root, "lanes.sock")); cleanups.push(() => hosts.close());
  const config = Config.parse({ paths: { data: root, lanes: join(root, "lanes") }, lanes: { launchHosts: false } });
  store.addProject({ id: "shop", name: "shop", path: "/code/shop" });
  const lane = await new LaneManager({ store, bus, config, run: async () => ({ stdout: "" }) }).start({ project: "shop", task: "Cart" });
  const sock = createConnection(join(root, "lanes.sock")); cleanups.push(() => sock.destroy());
  const send = (msg: unknown) => sock.write(`${JSON.stringify(msg)}\n`);
  const acks: string[] = [];
  sock.on("data", (d) => acks.push(...String(d).split("\n").filter(Boolean)));
  const until = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); expect(fn()).toBe(true); };
  send({ hello: lane.id, token: store.mintLaneToken(lane.id) });
  await until(() => acks.some((a) => a.includes("ready")));
  send({ eventId: randomUUID(), event: { type: "agent.error", payload: { message: "429 Too Many Requests" } } });
  await until(() => store.getLane(lane.id)!.state === "failed");
  send({ eventId: randomUUID(), event: { type: "agent.turn", payload: { active: true } } });
  await until(() => store.getLane(lane.id)!.state === "working");
  expect(store.events(lane.id).filter((e) => e.type === "lane.state").map((e) => e.payload)).toContainEqual(expect.objectContaining({ from: "failed", to: "working" }));
});

it("closes a connection that sends an endless line, before it is buffered whole", async () => {
  const root = await mkdtemp(join(tmpdir(), "cl-hosts-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = Store.open(":memory:"); cleanups.push(() => store.close());
  const hosts = new HostLinks({ store, bus: new EventBus() });
  await hosts.listen(join(root, "lanes.sock")); cleanups.push(() => hosts.close());
  const sock = createConnection(join(root, "lanes.sock")); cleanups.push(() => sock.destroy());
  const closed = new Promise<void>((resolve) => sock.on("close", () => resolve()));
  sock.on("error", () => {});
  const chunk = "x".repeat(256 * 1024);
  for (let i = 0; i < 10 && !sock.destroyed; i++) { sock.write(chunk); await new Promise((r) => setTimeout(r, 5)); }
  await closed;
  expect(sock.destroyed).toBe(true);
});

it("in Auto, approves what the guard passes (once, by ContextLanes) and leaves dire requests for you with the reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "cl-hosts-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = Store.open(":memory:"); cleanups.push(() => store.close());
  const bus = new EventBus(); const hosts = new HostLinks({ store, bus });
  await hosts.listen(join(root, "lanes.sock")); cleanups.push(() => hosts.close());
  const config = Config.parse({ paths: { data: root, lanes: join(root, "lanes") }, lanes: { launchHosts: false } });
  store.addProject({ id: "shop", name: "shop", path: "/code/shop" });
  const lane = await new LaneManager({ store, bus, config, run: async () => ({ stdout: "" }) }).start({ project: "shop", task: "Cart", auto: true, base: "main" });
  expect(lane.auto).toBe(true);
  expect(store.events(lane.id).some((e) => e.type === "lane.auto" && e.payload.on)).toBe(true);
  const sock = createConnection(join(root, "lanes.sock")); cleanups.push(() => sock.destroy());
  const send = (msg: unknown) => sock.write(`${JSON.stringify(msg)}\n`);
  const lines: string[] = [];
  sock.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean)));
  const until = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); expect(fn()).toBe(true); };
  send({ hello: lane.id, token: store.mintLaneToken(lane.id) });
  await until(() => lines.some((a) => a.includes("ready")));
  const options = [{ id: "always", label: "Always allow", kind: "allow_always" }, { id: "once", label: "Allow once", kind: "allow_once" }, { id: "no", label: "Deny", kind: "reject_once" }];
  const ask = (requestId: string, tool: unknown, title = "Run command") => send({ eventId: randomUUID(), event: { type: "permission.requested", payload: { requestId, title, options, tool } } });
  // Codex style: the command is the earlier tool call's title, the request carries only its id.
  send({ eventId: randomUUID(), event: { type: "tool.call", payload: { callId: "c1", kind: "execute", title: "pnpm test && git push -u origin lane/01-cart", files: [] } } });
  ask("r1", { kind: null, command: null, paths: [], callId: "c1" });
  await until(() => store.answered(lane.id, "r1"));
  expect(store.events(lane.id).find((e) => e.type === "permission.answered" && e.payload.requestId === "r1")!.payload).toMatchObject({ optionId: "once", by: "auto" });
  await until(() => lines.some((l) => l.includes('"requestId":"r1"') && l.includes('"optionId":"once"')));
  expect(store.getLane(lane.id)!.state).toBe("working");
  // Dire: waits for the owner, with why.
  ask("r2", { kind: "execute", command: "git push --force origin main", paths: [] });
  await until(() => store.getLane(lane.id)!.state === "needs_you");
  expect(store.answered(lane.id, "r2")).toBe(false);
  expect(store.permission(lane.id, "r2")).toMatchObject({ held: expect.stringMatching(/force-pushes/) });
  // Unseen: a command it cannot read is not approved.
  ask("r3", { kind: "execute", command: null, paths: [] });
  await new Promise((r) => setTimeout(r, 100));
  expect(store.permission(lane.id, "r3")).toMatchObject({ held: "ContextLanes could not see the command" });
  // Off: everything waits again.
  bus.publish(store.setLaneAuto(lane.id, false));
  ask("r4", { kind: "execute", command: "pnpm test", paths: [] });
  await new Promise((r) => setTimeout(r, 100));
  expect(store.answered(lane.id, "r4")).toBe(false);
  expect(store.permission(lane.id, "r4")!.held).toBeUndefined();
});
