import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Config, EventBus, HostLinks, LaneManager, Store, buildServer, hostCommand, type Runner } from "@contextlanes/daemon";
import { HostEvent, RunFacts, ResourcesOverview } from "@contextlanes/protocol";
import { Resources, certificateDays, inside, listeningSockets, parseGpus } from "../src/resources.js";
import { signedIn } from "./signed-in.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const clean of cleanups.splice(0).reverse()) await clean(); });

it("parses IPv4/IPv6 listeners and measured GPU fields without inventing missing measurements", async () => {
  const sockets = listeningSockets('LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=101,fd=20))\nLISTEN 0 512 [::]:3000 [::]:* users:(("server (worker)",pid=102,fd=9))\nLISTEN 0 511 *:99999 *:* users:(("bad",pid=103,fd=1))\nmalformed');
  expect(sockets).toEqual([{ name: "node", pid: 101, port: 5173, address: "127.0.0.1" }, { name: "server (worker)", pid: 102, port: 3000, address: "::" }]);
  expect(inside("/code/demo", "/code/demo/src")).toBe(true); expect(inside("/code/demo", "/code/demo-other")).toBe(false);
  expect(parseGpus("NVIDIA GPU, 80, 19558, 24576\nOther GPU, N/A, N/A, 8192\ninvalid")).toEqual([{ name: "NVIDIA GPU", usePct: 80, memoryUsedMiB: 19558, memoryTotalMiB: 24576 }, { name: "Other GPU", usePct: null, memoryUsedMiB: null, memoryTotalMiB: 8192 }]);
  expect(await certificateDays("http://localhost:3000")).toBeNull();
  expect(await certificateDays("invalid")).toBeNull();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cl-resources-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = Store.open(":memory:"); cleanups.push(() => store.close());
  const config = Config.parse({ paths: { data: root, lanes: join(root, "lanes") }, lanes: { launchHosts: false } });
  const bus = new EventBus(), hosts = new HostLinks({ store, bus }); cleanups.push(() => hosts.close());
  store.addProject({ id: "demo", name: "Demo", path: join(root, "demo") });
  const calls: { command: string; args: string[] }[] = [];
  let lane: Awaited<ReturnType<LaneManager["start"]>>;
  const processStat = (pid: number) => `${pid} (server (worker)) ${["S", ...Array(18).fill("0"), "999"].join(" ")}\n`;
  const run: Runner = async (command, args) => {
    calls.push({ command, args });
    if (command === "du") return { stdout: "412000\tworktree\n" };
    if (command === "nvidia-smi") return { stdout: "NVIDIA GPU, 80, 19558, 24576\n" };
    if (command === "ss") return { stdout: [101, 102, 103, 104].map((pid) => `LISTEN 0 511 ${pid === 104 ? "[::]" : "127.0.0.1"}:${5000 + pid} *:* users:(("node",pid=${pid},fd=20))`).join("\n") };
    if (command === "cat" && args[0] === "/proc/sys/kernel/random/boot_id") return { stdout: "e936d487-6f41-402a-9a10-22cae36dd5b6" };
    const pid = Number(args.at(-1)?.match(/\/proc\/(\d+)\//)?.[1]);
    if (command === "readlink") return { stdout: pid === 102 ? lane.worktree : `${root}/demo${pid === 103 ? "-other" : ""}` };
    if (command === "cat") return { stdout: args[0]!.endsWith("/stat") ? processStat(pid) : args[0]!.endsWith("/cmdline") ? "node\0server.js\0" : pid === 102 ? `0::/app.slice/${lane.hostUnit}.service\n` : "0::/user.slice/shell.scope\n" };
    return { stdout: "" };
  };
  const lanes = new LaneManager({ store, bus, config, run });
  lane = await lanes.start({ project: "demo", task: "Task" });
  store.saveEnvironment({ lane: lane.id, recipeHash: "a".repeat(64), setup: null, startedAt: null, error: null, services: [
    { name: "web", unit: "owned-web", port: 20001, url: "https://fixture.invalid:4700", state: "healthy", detail: null, probes: [true], ms: 1, lastFailure: null, healthPath: "/", healthStatus: 200 },
    { name: "api", unit: "owned-api", port: 20002, url: null, state: "failed", detail: "failed", probes: [false], ms: null, lastFailure: null, healthPath: "/", healthStatus: 200 },
  ] });
  const certificate = vi.fn(async () => 71);
  const resources = new Resources(store, run, certificate);
  return { root, store, config, bus, hosts, lanes, lane, calls, run, resources, certificate };
}

it("caches worktree/GPU/TLS probes, refreshes after three minutes, and excludes sibling folders and lane units", async () => {
  const f = await fixture();
  const first = RunFacts.parse(await f.resources.project("demo"));
  expect(first.lanes[0]).toMatchObject({ diskBytes: 412000, certificateDays: 71 });
  expect(first.outside!.map((s) => [s.pid, s.bind])).toEqual([[101, "localhost only"], [104, "all addresses"]]);
  const overview = ResourcesOverview.parse(await f.resources.overview());
  expect(overview.projects).toEqual([{ project: "demo", up: 1, down: 1 }]);
  await f.resources.project("demo"); await f.resources.overview();
  expect(f.calls.filter((c) => c.command === "du")).toHaveLength(1);
  expect(f.calls.filter((c) => c.command === "nvidia-smi")).toHaveLength(1);
  expect(f.certificate).toHaveBeenCalledTimes(1);
  const later = Date.now() + 180001;
  vi.spyOn(Date, "now").mockReturnValue(later);
  await f.resources.project("demo");
  expect(f.calls.filter((c) => c.command === "du")).toHaveLength(2);
  expect(f.certificate).toHaveBeenCalledTimes(2);
  const env = f.store.environment(f.lane.id)!;
  f.store.saveEnvironment({ ...env, services: env.services.map((service) => service.name === "api" ? { ...service, url: "https://bad.invalid" } : service) });
  const mixed = new Resources(f.store, f.run, async (url) => url.includes("bad.invalid") ? null : 71);
  expect((await mixed.project("demo")).lanes[0]?.certificateDays).toBeNull();
});

it("records an owner's adoption proposal in a fresh lane without stopping the outside process or approving a recipe", async () => {
  const f = await fixture();
  const outside = (await f.resources.project("demo")).outside![0]!;
  const app = signedIn(buildServer({ ...f, version: "test" }), f.store); cleanups.push(() => app.close());
  const result = await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "Propose a service recipe", adoption: outside } });
  expect(result.statusCode).toBe(201);
  const lane = result.json();
  expect(hostCommand(f.store.getLane(lane.id)!, f.config, outside).find((arg) => arg.startsWith("--task="))).toContain("normal recipe approval");
  expect(f.store.getLane(lane.id)?.task).toBe("Propose a service recipe");
  expect(f.store.events(lane.id).find((e) => e.type === "service.proposed")?.payload).toMatchObject({ pid: 101, port: 5101, command: ["node", "server.js"] });
  expect((await f.resources.project("demo")).outside![0]?.adoptedLane).toBe(lane.id);
  expect(f.store.serviceAdoption("demo", 101, "999", 9999, outside.bootId)).toBeNull();
  expect(f.store.serviceAdoption("demo", 101, "1000", 5101, outside.bootId)).toBeNull();
  expect(f.store.serviceAdoption("demo", 101, "999", 5101, "new-boot")).toBeNull();
  expect(f.store.getProject("demo")?.recipeHash).toBeNull();
  expect(f.calls.some((c) => ["kill", "pkill"].includes(c.command) || (c.command === "systemctl" && c.args.includes("stop")))).toBe(false);
  expect(HostEvent.safeParse({ eventId: "e936d487-6f41-402a-9a10-22cae36dd5b6", event: { type: "service.proposed", payload: outside } }).success).toBe(false);
});

it("leaves disk, GPU and socket failures unknown", async () => {
  const f = await fixture();
  const unavailable: Runner = async () => { throw new Error("unavailable"); };
  const facts = new Resources(f.store, unavailable, async () => null);
  expect(await facts.project("demo")).toMatchObject({ outside: null, lanes: [{ diskBytes: null, certificateDays: null }] });
  expect((await facts.overview()).gpus).toBeNull();
});
