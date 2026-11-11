import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { buildServer, Config, EventBus, HostLinks, LaneManager, Previews, Store, confineGit, type Runner } from "@contextlanes/daemon";
import { DOCKER_CONFIG_TEMPLATE, defaultRuntime, ensureConfigFile, listenHost, loadConfig } from "../src/config.js";
import { doctor } from "../src/doctor.js";
import { DockerFolders } from "../src/docker/folders.js";
import { SetupManager } from "../src/setup.js";
import { CONTROL, fakeDocker } from "./docker-fakes.js";
import type { ControlInfo } from "../src/docker/control.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function freePort(): Promise<number> {
  const s = createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const port = (s.address() as { port: number }).port; s.close(); return port;
}
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "cl-docker-")); cleanups.push(() => rm(dir, { recursive: true, force: true })); return dir; };

describe("the runtime switch", () => {
  it("is the host runtime unless the image says docker; config.toml overrides either way", () => {
    expect(defaultRuntime({})).toBe("host");
    expect(defaultRuntime({ CONTEXTLANES_RUNTIME: "docker" })).toBe("docker");
    expect(defaultRuntime({ CONTEXTLANES_RUNTIME: "1" })).toBe("host");
    expect(Config.parse({}).runtime.mode).toBe("host");
    vi.stubEnv("CONTEXTLANES_RUNTIME", "docker");
    expect(Config.parse({}).runtime.mode).toBe("docker");
    expect(Config.parse({ runtime: { mode: "host" } }).runtime.mode).toBe("host");
  });

  it("listens on loopback on the host and on the private network in Docker, and puts data beside config.toml", () => {
    vi.stubEnv("CONTEXTLANES_CONFIG", "/data/config.toml");
    const host = Config.parse({});
    expect(listenHost(host)).toBe("127.0.0.1");
    expect(host.previews.bind).toBe("127.0.0.1");
    const docker = Config.parse({ runtime: { mode: "docker" } });
    expect(listenHost(docker)).toBe("0.0.0.0");
    expect(docker.previews.bind).toBe("0.0.0.0");
    expect(docker.paths.data).toBe("/data");
    // Written values win over the Docker defaults.
    expect(Config.parse({ runtime: { mode: "docker" }, previews: { bind: "127.0.0.1" }, paths: { data: "/data/state" } })).toMatchObject({ previews: { bind: "127.0.0.1" }, paths: { data: "/data/state" } });
  });

  it("writes config.toml with the defaults on first start only, and the file loads as the Docker runtime", async () => {
    const dir = await temp();
    const path = join(dir, "config.toml");
    expect(await ensureConfigFile(path)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(DOCKER_CONFIG_TEMPLATE);
    expect(parse(DOCKER_CONFIG_TEMPLATE)).toEqual({ runtime: { mode: "docker" }, lanes: {}, previews: {} });
    vi.stubEnv("CONTEXTLANES_CONFIG", path);
    expect(loadConfig(path)).toMatchObject({ runtime: { mode: "docker" }, paths: { data: dir }, previews: { bind: "0.0.0.0", localPort: 4601 } });
    await writeFile(path, "[runtime]\nmode = \"docker\"\n[previews]\ndomain = \"lanes.example.dev\"\n");
    expect(await ensureConfigFile(path)).toBe(false);
    expect(await readFile(path, "utf8")).toContain("lanes.example.dev");
  });

  it("gives the daemon's git the guards without bubblewrap in Docker", async () => {
    const calls: string[][] = [];
    const run = confineGit(async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: "" }; }, Config.parse({ runtime: { mode: "docker" } }), async () => { throw new Error("never checked"); });
    await run("git", ["status"], { cwd: "/srv/shop" });
    expect(calls[0]![0]).toBe("git");
    expect(calls[0]).toContain("core.hooksPath=/dev/null");
  });
});

describe("doctor in the Docker runtime", () => {
  async function setup(control: ControlInfo | null, opts: { have?: string; want?: string; fail?: RegExp } = {}) {
    const root = await temp();
    const mount = join(root, "volume"), image = join(root, "image");
    await mkdir(mount); await mkdir(image);
    if (opts.want !== "") await writeFile(join(image, ".version"), `${opts.want ?? "tmux=3.6a node=v24 layout=1"}\n`);
    if (opts.have !== "") await writeFile(join(mount, ".version"), `${opts.have ?? opts.want ?? "tmux=3.6a node=v24 layout=1"}\n`);
    const calls: string[][] = [];
    const run: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd !== "docker") throw new Error(`${cmd} is not installed`);
      if (opts.fail?.test(args.join(" "))) throw new Error("docker failed: boom");
      if (args[0] === "version") return { stdout: "29.9.3\n" };
      if (args[0] === "network") return { stdout: "contextlanes\n" };
      return { stdout: "" };
    };
    const config = Config.parse({ runtime: { mode: "docker" }, previews: { localPort: await freePort() }, paths: { data: root, lanes: root } });
    const links = new Previews({ config, run });
    await links.start();
    cleanups.push(() => links.close());
    const r = await doctor({ config, run, version: "test", previews: links, find: async () => null, docker: { control: () => control, toolsMount: mount, toolsInImage: image } });
    return { r, calls, check: (id: string) => r.checks.find((c) => c.id === id) };
  }

  it("checks Docker, the network, the tools volume, ports and mounts, and skips host-only checks", async () => {
    const { r, calls, check } = await setup(CONTROL);
    expect(r).toMatchObject({ runtime: "docker", sandbox: "containers" });
    for (const id of ["docker", "network", "tools", "api", "published", "mounts", "helpers", "socket"]) expect(check(id), id).toMatchObject({ state: "ok" });
    expect(check("docker")!.found).toContain("29.9.3");
    expect(check("socket")!.found).toContain("root-equivalent");
    expect(check("mounts")!.found).toContain("none of your folders");
    for (const id of ["git", "tmux", "python3", "agents", "supervisor", "sandbox"]) expect(check(id), id).toBeUndefined();
    expect(r.checks.filter((c) => c.state === "fail")).toEqual([]);
    expect(check("router")).toMatchObject({ state: "ok" });
    // The trial helper: labelled, no network, removed, the control's own image.
    const helper = calls.find((c) => c.includes("--entrypoint"))!;
    expect(helper).toEqual(expect.arrayContaining(["run", "--rm", "--label", "contextlanes.helper=1", "--network", "none", "--entrypoint", "true", "sha256:image"]));
    expect(calls.every((c) => c[0] === "docker")).toBe(true);
  });

  it("fails a published API, a stale or empty tools volume, a missing network and an unreachable Docker", async () => {
    const published = await setup({ ...CONTROL, published: [...CONTROL.published, { port: "4600/tcp", host: "0.0.0.0:4600" }] });
    expect(published.check("api")).toMatchObject({ state: "fail", found: expect.stringContaining("0.0.0.0:4600") });
    expect((await setup(CONTROL, { have: "tmux=3.5", want: "tmux=3.6a" })).check("tools")).toMatchObject({ state: "fail", found: expect.stringContaining("tmux=3.5") });
    expect((await setup(CONTROL, { have: "" })).check("tools")).toMatchObject({ state: "fail", found: expect.stringContaining("empty") });
    expect((await setup(CONTROL, { fail: /^network/ })).check("network")).toMatchObject({ state: "fail" });
    const down = await setup(null, { fail: /./ });
    expect(down.check("docker")).toMatchObject({ state: "fail" });
    expect(down.check("control")).toMatchObject({ state: "fail" });
    const extra = await setup({ ...CONTROL, mounts: [...CONTROL.mounts, { type: "bind", source: "/home/kyle/code", destination: "/home/kyle/code" }] });
    expect(extra.check("mounts")).toMatchObject({ state: "warn", found: expect.stringContaining("/home/kyle/code") });
  });
});

describe("projects through the API in the Docker runtime", () => {
  async function setup(owner = "1001:1002") {
    const root = await temp();
    const config = Config.parse({ runtime: { mode: "docker" }, paths: { data: join(root, "data"), lanes: join(root, "lanes") } });
    const store = Store.open(":memory:"); cleanups.push(() => store.close());
    const { run: docker, calls } = fakeDocker({ owner });
    const folders = new DockerFolders({ run: docker, control: CONTROL, store });
    const run = confineGit(folders.runner(), config);
    const bus = new EventBus(); const hosts = new HostLinks({ store, bus }); const lanes = new LaneManager({ store, bus, config, run });
    const setupManager = new SetupManager(config, store, run, { path: join(root, "config.toml"), folders, home: "/root", find: async () => null });
    await setupManager.initialize();
    const app = buildServer({ config, store, bus, hosts, lanes, setup: setupManager, run, version: "test" }); cleanups.push(() => app.close());
    const token = (await readFile(setupManager.controlFile, "utf8")).trim();
    const as = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
    return { as, calls, store, root };
  }

  it("adds a folder it cannot see: owner by a helper stat, repository by a helper git as that owner, stored with an event", async () => {
    const { as, calls, store } = await setup();
    const res = await as("POST", "/api/projects", { path: "/home/kyle/code/shop" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: "shop", path: "/home/kyle/code/shop", owner: { uid: 1001, gid: 1002 } });
    expect(calls.map((c) => c.args[c.args.indexOf("--entrypoint") + 1])).toEqual(["stat", "git"]);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["--user", "0:0", "--mount", "type=bind,source=/home/kyle/code/shop,target=/home/kyle/code/shop,readonly"]));
    expect(calls[1]!.args).toEqual(expect.arrayContaining(["--user", "1001:1002", "rev-parse", "--show-toplevel", "--absolute-git-dir"]));
    expect(store.projectEvents("shop")).toMatchObject([{ type: "project.owner", payload: { uid: 1001, gid: 1002 } }]);
    // Adding it again changes nothing and records nothing new.
    expect((await as("POST", "/api/projects", { path: "/home/kyle/code/shop" })).statusCode).toBe(201);
    expect(store.projectEvents("shop")).toHaveLength(1);
    expect((await as("GET", "/api/projects")).json()).toMatchObject([{ id: "shop", owner: { uid: 1001, gid: 1002 } }]);
  });

  it("lists branches through helpers, removes a project, and never runs anything but docker", async () => {
    const { as, calls } = await setup();
    await as("POST", "/api/projects", { path: "/srv/shop" });
    const branches = await as("GET", "/api/projects/shop/branches");
    expect(branches.json()).toEqual({ branches: ["main", "feature"], defaultBranch: "main", current: "main" });
    expect(calls.slice(2).every((c) => c.args.includes("--user") && c.args[c.args.indexOf("--user") + 1] === "1001:1002" && c.args.includes("-w") && c.args[c.args.indexOf("-w") + 1] === "/srv/shop")).toBe(true);
    expect((await as("DELETE", "/api/projects/shop")).statusCode).toBe(204);
    expect((await as("GET", "/api/projects")).json()).toEqual([]);
    expect(calls.every((c) => c.cmd === "docker")).toBe(true);
  });

  it("refuses bad paths, the stack's own folder and lanes, clearly", async () => {
    const { as, calls } = await setup();
    for (const path of ["~/code/shop", "code/shop", "/", "/opt/stacks/contextlanes", "/home/kyle/../shop"]) {
      const res = await as("POST", "/api/projects", { path });
      expect(res.statusCode, path).toBe(400);
      expect(res.json(), path).toMatchObject({ code: "bad_path" });
    }
    expect(calls).toEqual([]);
    await as("POST", "/api/projects", { path: "/srv/shop" });
    // This server was built without lane containers (docker-lanes.test.ts has them): it says so.
    const lane = await as("POST", "/api/lanes", { project: "shop", task: "Fix it", kind: "shell" });
    expect(lane.statusCode).toBe(503);
    expect(lane.json()).toMatchObject({ code: "docker_unreachable" });
    // What phase 4 and later bring answers not_yet.
    for (const url of ["/api/setup/projects/scan", "/api/projects/shop/recipe", "/api/lanes/shop/1/env", "/api/lanes/shop/1/diff"]) expect((await as("GET", url)).json(), url).toMatchObject({ code: "not_yet" });
    // Reading lanes still works: there are none.
    expect((await as("GET", "/api/lanes")).json()).toEqual([]);
    expect((await as("GET", "/api/health")).json()).toMatchObject({ ok: true, runtime: "docker" });
  });
});
