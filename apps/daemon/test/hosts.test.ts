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
  send({ hello: lane.id });
  await until(() => acks.some((a) => a.includes("ready")));
  send({ eventId: randomUUID(), event: { type: "agent.error", payload: { message: "429 Too Many Requests" } } });
  await until(() => store.getLane(lane.id)!.state === "failed");
  send({ eventId: randomUUID(), event: { type: "agent.turn", payload: { active: true } } });
  await until(() => store.getLane(lane.id)!.state === "working");
  expect(store.events(lane.id).filter((e) => e.type === "lane.state").map((e) => e.payload)).toContainEqual(expect.objectContaining({ from: "failed", to: "working" }));
});
