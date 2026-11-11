import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildServer, Config, EventBus, HostLinks, LaneManager, Previews, Runtime, Store, confineGit, type Runner } from "@contextlanes/daemon";
import { api, laneCommand, type Io } from "@contextlanes/cli";
import { DockerFolders } from "../src/docker/folders.js";
import { DockerLanes } from "../src/docker/lanes.js";
import { COPY_JS, copyIgnoredArgv, parseFound, READ_SH, readProjectArgv } from "../src/docker/app.js";
import { appChecks, proxyCheck, type HostGet } from "../src/docker/app-doctor.js";
import { MAX_BYTES, RECIPE_FILES } from "../src/recipes.js";
import { fixedPorts } from "../src/runtime.js";
import { PreviewRouter } from "../src/preview-router.js";
import { loopbackOnly, procListening } from "../src/supervisor/docker.js";
import { UNIT_SH } from "../src/supervisor/index.js";
import { SetupManager } from "../src/setup.js";
import { RecipeService } from "@contextlanes/protocol";
import { CONTROL, laneDocker, type DockerCall } from "./docker-fakes.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const clean of cleanups.splice(0).reverse()) await clean(); });
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "cl-dapps-")); cleanups.push(() => rm(dir, { recursive: true, force: true })); return dir; };

const P = "/home/kyle/code/shop";
const WT = `${P}.lanes/01-fix-login`;
const LANE_PATH = "/opt/contextlanes/bin:/usr/local/bin:/usr/bin:/bin";
const PASSWD = "root:x:0:0:root:/root:/bin/bash\nnode:x:1000:1000::/home/node:/bin/bash\n";

const RECIPE = JSON.stringify({ copy: [], services: [{ name: "web", command: ["node", "server.js"], health: { path: "/health", timeoutSeconds: 2 } }] }, null, 2);
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** A /proc/net/tcp line listening on the address, for the socket inode. */
const tcp = (hex: string, inode: number) => `   0: ${hex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;

type Files = Record<string, string | Buffer | "link">;
/** READ_SH's answer for files on a fake disk. */
function readAnswer(files: Files, asked: string[]): string {
  for (const f of asked) {
    const v = files[f];
    if (v === undefined) continue;
    if (v === "link") return `link ${f}\n`;
    return `file ${f}\n${Buffer.from(v).subarray(0, MAX_BYTES + 1).toString("base64").replace(/(.{76})/g, "$1\n")}\n`;
  }
  return "";
}

/**
 * The phase 3 lane fake, plus what a lane's app needs: the recipe read inside the lane and by the project
 * helper, the unit helper's actions, the copy helper and du. Each is recorded with its argv.
 */
function appDocker(state: { lane: Files; project: Files; status?: string; listeners?: string; oneshot?: { fail?: boolean }; copied?: string[] }) {
  const base = laneDocker();
  const calls = base.calls;
  const units: { action: string; args: string[]; argv: string[] }[] = [];
  const run: Runner = async (cmd, args, o) => {
    if (cmd === "docker" && args[0] === "exec") {
      const at = args.findIndex((a) => a.startsWith("cl-shop-"));
      const argv = args.slice(at + 1);
      if (argv[0] === "sh" && argv[2] === READ_SH) { calls.push({ args }); return { stdout: readAnswer(state.lane, argv.slice(4)) }; }
      if (argv[0] === "sh" && argv[2] === UNIT_SH) {
        calls.push({ args });
        const action = argv[4]!;
        units.push({ action, args: argv.slice(5), argv: args });
        if (action === "status") return { stdout: state.status ?? "active\n41\n" };
        if (action === "listeners") return { stdout: state.listeners ?? "" };
        if (action === "logs") return { stdout: "1700000000\nlistening on 3000\nGET /health\n" };
        if (action === "oneshot" && state.oneshot?.fail) throw Object.assign(new Error("sh oneshot failed (exit 1)"), { stdout: "npm ERR! missing script" });
        return { stdout: "" };
      }
      if (argv[0] === "du") { calls.push({ args }); return { stdout: "4096\t.\n" }; }
    }
    if (cmd === "docker" && args[0] === "run" && args.includes(READ_SH)) { calls.push({ args }); return { stdout: readAnswer(state.project, args.slice(args.indexOf(READ_SH) + 2)) }; }
    if (cmd === "docker" && args[0] === "run" && args.includes(COPY_JS)) { calls.push({ args }); return { stdout: JSON.stringify(state.copied ?? []) }; }
    return base.run(cmd, args, o);
  };
  return { run, calls, units };
}

async function setup(state: Parameters<typeof appDocker>[0], settings: Record<string, unknown> = {}, before?: (store: Store) => void) {
  const root = await temp();
  const config = Config.parse({ runtime: { mode: "docker" }, paths: { data: join(root, "data"), lanes: join(root, "lanes") }, ...settings });
  const store = Store.open(":memory:"); cleanups.push(() => store.close());
  const { run: docker, calls, units } = appDocker(state);
  const folders = new DockerFolders({ run: docker, control: CONTROL, store });
  const git = confineGit(folders.runner(), config);
  const bus = new EventBus();
  const dockerLanes = new DockerLanes({ docker, git, folders, store, bus, config, control: () => CONTROL, socketGid: async () => 999, passwd: async () => PASSWD, dataFile: async () => null });
  const lanes = new LaneManager({ store, bus, config, run: git, docker: dockerLanes });
  store.addProject({ id: "shop", name: "shop", path: P, owner: { uid: 1000, gid: 1000 } });
  before?.(store);
  const fetched: string[] = [];
  const health = { ok: true };
  const fakeFetch = (async (url: string) => { fetched.push(String(url)); if (!health.ok) throw new TypeError("fetch failed"); return new Response("ok"); }) as unknown as typeof fetch;
  const previews = new Previews({ config, run: git });
  cleanups.push(() => previews.close());
  const runtime = new Runtime({ store, bus, config, run: git, docker: dockerLanes, fetch: fakeFetch, previews });
  cleanups.push(() => runtime.close());
  const lane = await lanes.start({ project: "shop", task: "Fix login", kind: "shell" });
  expect(lane.state).toBe("working");
  const created = { calls: calls.splice(0), units: units.splice(0) };
  const hosts = new HostLinks({ store, bus });
  const setupManager = new SetupManager(config, store, git, { path: join(root, "config.toml"), folders, home: "/root", find: async () => null });
  await setupManager.initialize();
  const app = buildServer({ config, store, bus, hosts, lanes, setup: setupManager, run: git, runtime, version: "test", docker: { control: () => CONTROL, lanes: dockerLanes, config } });
  cleanups.push(() => app.close());
  const token = (await readFile(setupManager.controlFile, "utf8")).trim();
  const as = (method: "GET" | "POST", url: string, payload?: unknown, bearer = token) => app.inject({ method, url, headers: { authorization: `Bearer ${bearer}` }, ...(payload !== undefined ? { payload } : {}) });
  return { config, store, bus, calls, units, docker, dockerLanes, lanes, runtime, previews, app, as, token, fetched, health, state, lane, created };
}

const execOf = (c: DockerCall) => c.args.slice(c.args.findIndex((a) => a.startsWith("cl-shop-")) + 1);

describe("the recipe in the Docker runtime", () => {
  it("is read inside the lane, as its user, in its checkout; then from the main checkout by a read-only helper", async () => {
    const s = await setup({ lane: {}, project: { ".contextlanes.json": RECIPE } });
    const view = await s.runtime.recipes.lane(s.store.getProject("shop")!, s.lane);
    expect(view).toMatchObject({ file: ".contextlanes.json", hash: sha(RECIPE), approved: false, error: null, recipe: { services: [{ name: "web" }] } });
    const [inLane, helper] = s.calls;
    expect(inLane!.args.slice(0, 5)).toEqual(["exec", "-u", "vscode", "-w", WT]);
    expect(inLane!.args).toContain(`PATH=${LANE_PATH}`);
    expect(execOf(inLane!)).toEqual(["sh", "-c", READ_SH, "sh", ...RECIPE_FILES]);
    expect(helper!.args).toEqual(readProjectArgv("sha256:image", P, { uid: 1000, gid: 1000 }, RECIPE_FILES, helper!.args[helper!.args.indexOf("--name") + 1]));
    expect(helper!.args).toEqual(expect.arrayContaining(["--network", "none", "--cap-drop", "ALL", "--read-only", "--user", "1000:1000", "--mount", `type=bind,source=${P},target=${P},readonly`, "-w", P]));
    expect(helper!.args.join(" ")).not.toMatch(/docker\.sock|privileged/);
    // The lane's own checkout wins, and nothing else runs.
    s.calls.length = 0;
    s.state.lane[".contextlanes.json"] = RECIPE.replace("server.js", "lane.js");
    expect((await s.runtime.recipes.lane(s.store.getProject("shop")!, s.lane))!.recipe!.services[0]!.command).toEqual(["node", "lane.js"]);
    expect(s.calls).toHaveLength(1);
  });

  it("refuses an oversized, malformed or linked recipe, and never follows the link", async () => {
    const s = await setup({ lane: {}, project: {} });
    const project = s.store.getProject("shop")!;
    s.state.lane[".contextlanes.json"] = Buffer.alloc(MAX_BYTES + 10, 0x20);
    expect(await s.runtime.recipes.lane(project, s.lane)).toMatchObject({ recipe: null, error: "The recipe is larger than 64 KB." });
    s.state.lane[".contextlanes.json"] = "{ not json";
    expect(await s.runtime.recipes.lane(project, s.lane)).toMatchObject({ recipe: null, error: expect.stringContaining("Not valid JSON") });
    s.state.lane[".contextlanes.json"] = JSON.stringify({ services: [{ name: "web", command: ["x"], extra: 1 }] });
    expect(await s.runtime.recipes.lane(project, s.lane)).toMatchObject({ recipe: null, error: expect.stringContaining("schema") });
    s.state.lane[".contextlanes.json"] = JSON.stringify({ services: [{ name: "a", command: ["x"], port: { number: 3000 } }, { name: "b", command: ["y"], port: { number: 3000 } }] });
    expect(await s.runtime.recipes.lane(project, s.lane)).toMatchObject({ recipe: null });
    s.state.lane[".contextlanes.json"] = "link";
    expect(await s.runtime.recipes.lane(project, s.lane)).toMatchObject({ recipe: null, text: "", error: expect.stringContaining("symbolic link") });
    // The answer itself is checked at the edge.
    expect(() => parseFound("file /etc/passwd\nAAAA\n", RECIPE_FILES)).toThrow(/not one/);
    expect(() => parseFound("file .contextlanes.json\nnot base64!\n", RECIPE_FILES)).toThrow(/base64/);
    expect(parseFound("", RECIPE_FILES)).toBeNull();
    expect(parseFound("file .contextlanes.json\naGk=\n", RECIPE_FILES)).toEqual({ file: ".contextlanes.json", kind: "file", data: Buffer.from("hi") });
  });

  it("waits for the owner: start is refused until approved, a changed recipe is refused again, a lane's token cannot approve", async () => {
    const s = await setup({ lane: { ".contextlanes.json": RECIPE }, project: {} });
    const start = await s.as("POST", "/api/lanes/shop/01/env/start", {});
    expect(start.statusCode).toBe(409);
    expect(start.json()).toMatchObject({ code: "recipe_unapproved" });
    expect(s.store.eventsOfType(["recipe.requested"], { lanes: ["shop/01"] }).at(-1)!.payload.hash).toBe(sha(RECIPE));
    // The owner reads it (contextlanes recipe shop/01 reads /environments), then approves those bytes.
    const env = await s.as("GET", "/api/projects/shop/environments");
    expect(env.json().lanes[0].recipe).toMatchObject({ hash: sha(RECIPE), approved: false });
    // A lane's own token never reaches approval.
    const laneToken = s.store.mintLaneToken("shop/01");
    expect((await s.as("POST", "/api/projects/shop/recipe/approve", { hash: sha(RECIPE) }, laneToken)).statusCode).toBe(401);
    expect(s.store.recipeApproved("shop", sha(RECIPE))).toBe(false);
    expect((await s.as("POST", "/api/projects/shop/recipe/approve", { hash: "b".repeat(64) })).statusCode).toBe(409);
    expect((await s.as("POST", "/api/projects/shop/recipe/approve", { hash: sha(RECIPE) })).json()).toEqual({ approved: true, hash: sha(RECIPE) });
    expect((await s.as("POST", "/api/lanes/shop/01/env/start", {})).json()).toMatchObject({ services: [{ name: "web", state: "healthy", port: 3000 }] });
    // One byte changed in the lane's checkout: refused until approved again.
    s.state.lane[".contextlanes.json"] = `${RECIPE} `;
    const again = await s.as("POST", "/api/lanes/shop/01/env/restart", {});
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "recipe_unapproved" });
  });
});

describe("a lane's services in the Docker runtime", () => {
  async function approved(state: Partial<Parameters<typeof appDocker>[0]> = {}, recipe = RECIPE) {
    const s = await setup({ lane: { ".contextlanes.json": recipe }, project: {}, ...state });
    s.store.approveRecipe("shop", sha(recipe));
    return s;
  }

  it("start inside the lane through its driver: real port, HOST=0.0.0.0, the lane's PATH, no sandbox; health and the route by container name", async () => {
    const s = await approved();
    const env = await s.runtime.start("shop/01");
    expect(env.services).toMatchObject([{ name: "web", state: "healthy", port: 3000, url: "http://web-01-shop.localhost:4601" }]);
    const start = s.units.find((u) => u.action === "start")!;
    expect(start.argv.slice(0, 6)).toEqual(["exec", "-d", "-u", "vscode", "-w", WT]);
    expect(start.argv).toEqual(expect.arrayContaining(["-e", "HOST=0.0.0.0", "-e", "PORT=3000", "-e", "PORT_WEB=3000", "-e", `PATH=${LANE_PATH}`, "-e", "CL_UNITS=/var/lib/contextlanes-lane/units", "-e", "CONTEXTLANES_LANE=shop/01"]));
    expect(start.args).toEqual([env.services[0]!.unit, "1", "node", "server.js"]);
    expect(start.argv.join(" ")).not.toMatch(/bwrap|privileged|docker\.sock/);
    expect(s.fetched).toContain("http://cl-shop-01:3000/health");
    expect(s.runtime.routeOf(s.lane, "web")).toBe("cl-shop-01:3000");
    expect((await s.as("GET", "/api/lanes/shop/01/url?service=web")).json()).toEqual({ service: "web", url: "http://web-01-shop.localhost:4601" });
    // Logs come from the unit's state in the lane, bounded by the number asked for.
    const logs = await s.as("GET", "/api/lanes/shop/01/logs?service=web&lines=1");
    expect(logs.json()).toEqual([{ at: "2023-11-14T22:13:20.000Z", text: "GET /health" }]);
    expect(s.units.find((u) => u.action === "logs")!.args).toEqual([env.services[0]!.unit, "1"]);
    // Stop ends the unit inside the lane and takes the link away.
    const stopped = await s.runtime.stop("shop/01");
    expect(stopped!.services[0]).toMatchObject({ state: "stopped", url: null });
    expect(s.units.find((u) => u.action === "stop")!.args).toEqual([env.services[0]!.unit]);
    expect(s.runtime.routeOf(s.lane, "web")).toBeNull();
    // Nothing was run on the control side but docker.
    expect(s.calls.every((c) => c.args[0] === "exec" || c.args[0] === "run")).toBe(true);
  });

  it("gives every service one port in every lane: the recipe's number, else 3000, 3001… skipping taken ones", () => {
    const svc = (name: string, number?: number) => RecipeService.parse({ name, command: ["x"], ...(number ? { port: { number } } : {}) });
    expect(fixedPorts([svc("web"), svc("api"), svc("db", 3001), svc("docs")])).toEqual({ web: 3000, api: 3002, db: 3001, docs: 3003 });
    expect(fixedPorts([svc("web", 5173)])).toEqual({ web: 5173 });
  });

  it("says plainly when a service listens only on 127.0.0.1 inside the lane, and does not stop one that listens on every address", async () => {
    const s = await approved({ listeners: `socket:[111]\n---\n${tcp("0100007F:0BB8", 111)}\n` });
    s.health.ok = false;
    const env = await s.runtime.start("shop/01");
    expect(env.services[0]).toMatchObject({ state: "failed", detail: expect.stringContaining("listens only on 127.0.0.1:3000 inside the lane") });
    expect(env.services[0]!.detail).toContain("0.0.0.0");
    expect(await s.runtime.listening("shop/01", "web")).toEqual({ addresses: ["127.0.0.1:3000"], loopbackOnly: true });
    // The driver clears the unit before it starts it; after that nothing stops it.
    const stoppedAfterStart = () => s.units.slice(s.units.findIndex((u) => u.action === "start")).some((u) => u.action === "stop");
    expect(stoppedAfterStart()).toBe(false);
    // On every address: healthy, never stopped for it (on the host that would be stopped).
    s.state.listeners = `socket:[111]\n---\n${tcp("00000000:0BB8", 111)}\n`;
    s.health.ok = true;
    await s.runtime.poll();
    expect(s.store.environment("shop/01")!.services[0]).toMatchObject({ state: "healthy", detail: null });
    expect(stoppedAfterStart()).toBe(false);
    expect(procListening(`socket:[1]\n---\n${tcp("0100007F:0BB8", 1)}\n${tcp("00000000:0050", 2)}`)).toEqual(["127.0.0.1:3000"]);
    expect(loopbackOnly(["127.0.0.1:3000", "[::1]:3000"])).toBe(true);
    expect(loopbackOnly(["0.0.0.0:3000"])).toBe(false);
    expect(loopbackOnly([])).toBe(false);
  });

  it("runs setup inside the lane and copies ignored files by a helper that writes only the checkout", async () => {
    const recipe = JSON.stringify({ setup: [{ name: "Install", command: ["npm", "ci"] }], services: [{ name: "web", command: ["npm", "run", "dev"] }] });
    const s = await approved({ copied: [".env"] }, recipe);
    const env = await s.runtime.start("shop/01");
    expect(env.setup).toMatchObject({ ignored: [".env"], cache: "none", steps: 1, disk: 4096, database: null });
    const copy = s.calls.find((c) => c.args.includes(COPY_JS))!;
    expect(copy.args).toEqual(copyIgnoredArgv("sha256:image", P, WT, { uid: 1000, gid: 1000 }, ["**/.env*"], copy.args[copy.args.indexOf("--name") + 1]));
    expect(copy.args).toEqual(expect.arrayContaining(["--network", "none", "--read-only", "--user", "1000:1000", "--mount", `type=bind,source=${P},target=${P},readonly`, "--mount", `type=bind,source=${WT},target=${WT}`]));
    expect(copy.args.filter((a) => a.startsWith("type=bind"))).toHaveLength(2);
    const step = s.units.find((u) => u.action === "oneshot")!;
    expect(step.args).toEqual(["600", "npm", "ci"]);
    expect(step.argv).toEqual(expect.arrayContaining(["-w", WT, "-e", "HOST=0.0.0.0"]));
    expect(s.units.findIndex((u) => u.action === "oneshot")).toBeLessThan(s.units.findIndex((u) => u.action === "start"));
  });

  it("runs an approved recipe's setup inside the lane when the lane is made, before its token and agent", async () => {
    const recipe = JSON.stringify({ setup: [{ name: "Install", command: ["npm", "ci"] }], services: [{ name: "web", command: ["npm", "run", "dev"] }] });
    const s = await setup({ lane: { ".contextlanes.json": recipe }, project: {} }, {}, (store) => store.approveRecipe("shop", sha(recipe)));
    const steps = s.created.calls.map((c) => c.args.includes(UNIT_SH) ? `unit ${execOf(c)[4]}` : c.args.some((a) => a.includes("cat >")) ? "write" : null).filter(Boolean);
    expect(steps).toEqual(["unit oneshot", "write"]);
    expect(s.store.environment("shop/01")).toMatchObject({ recipeHash: sha(recipe), setup: { steps: 1 }, services: [{ name: "web", port: 3000, state: "stopped" }] });
    // A setup that fails is recorded on the app; the lane still starts.
    const f = await setup({ lane: { ".contextlanes.json": recipe }, project: {}, oneshot: { fail: true } }, {}, (store) => store.approveRecipe("shop", sha(recipe)));
    expect(f.lane.state).toBe("working");
    expect(f.store.eventsOfType(["env.status"], { lanes: ["shop/01"] }).at(-1)!.payload).toMatchObject({ service: "setup", state: "failed", detail: expect.stringContaining("Install failed") });
  });

  it("refuses cache and database in a lane, and says what to do instead", async () => {
    for (const [extra, word] of [[{ cache: ["node_modules"] }, "cache"], [{ database: { kind: "sqlite", file: "db.sqlite" } }, "database"]] as const) {
      const recipe = JSON.stringify({ ...extra, services: [{ name: "web", command: ["x"] }] });
      const s = await approved({}, recipe);
      const res = await s.as("POST", "/api/lanes/shop/01/env/start", {});
      expect(res.json(), word).toMatchObject({ error: expect.stringContaining(`"${word}"`) });
      expect(s.units.some((u) => u.action === "start"), word).toBe(false);
    }
  });

  it("refuses a lane whose container is not running, and the app of a lane with no container", async () => {
    const s = await approved();
    s.store.appendEvent("shop/01", { type: "lane.container", payload: { state: "stopped", name: "cl-shop-01" } });
    expect((await s.as("POST", "/api/lanes/shop/01/env/start", {})).json()).toMatchObject({ code: "container_not_running" });
  });
});

describe("router targets", () => {
  it("send a label to a host by name and port, Host passed through, websockets too", async () => {
    const upstream = createServer((req, res) => res.end(`${req.headers.host}`));
    upstream.on("upgrade", (req, socket) => { socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"); socket.on("data", (d) => socket.end(d)); });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    cleanups.push(() => { upstream.close(); upstream.closeAllConnections(); });
    const router = new PreviewRouter(0, "127.0.0.1", () => ["localhost"]);
    cleanups.push(() => router.close());
    const port = await router.listen();
    router.set("web-01-shop", (upstream.address() as AddressInfo).port, "localhost");
    expect(router.targetOf("web-01-shop")).toBe(`localhost:${(upstream.address() as AddressInfo).port}`);
    const body = await new Promise<string>((resolve, reject) => {
      request({ host: "127.0.0.1", port, headers: { host: "web-01-shop.localhost" } }, (res) => { let t = ""; res.on("data", (d) => t += d); res.on("end", () => resolve(t)); }).on("error", reject).end();
    });
    expect(body).toBe("web-01-shop.localhost");
    const echoed = await new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, headers: { host: "web-01-shop.localhost", Connection: "Upgrade", Upgrade: "websocket" } });
      req.on("upgrade", (_res, socket) => { socket.once("data", (d) => { resolve(d.toString()); socket.destroy(); }); socket.write("ping"); });
      req.on("error", reject); req.end();
    });
    expect(echoed).toBe("ping");
    expect(() => router.set("x", 1, "cl-shop-01:80")).toThrow(/route target/);
    expect(() => router.set("x", 1, "evil host")).toThrow(/route target/);
  });
});

describe("doctor for lane apps", () => {
  it("reaches a healthy service by name and through the router, names loopback-only services and recipes waiting", async () => {
    const s = await setup({ lane: { ".contextlanes.json": RECIPE }, project: {} });
    s.store.approveRecipe("shop", sha(RECIPE));
    await s.runtime.start("shop/01");
    const asked: { url: string; host?: string }[] = [];
    const get: HostGet = async (url, host) => { asked.push({ url, ...(host ? { host } : {}) }); return { status: 200, body: "ok" }; };
    let checks = await appChecks({ config: s.config, store: s.store, runtime: s.runtime, lanes: s.dockerLanes, get });
    expect(checks.find((c) => c.id === "app-links")).toMatchObject({ state: "ok", found: expect.stringContaining("shop/01 web at cl-shop-01:3000") });
    expect(asked).toEqual([{ url: "http://cl-shop-01:3000/health" }, { url: "http://127.0.0.1:4601/health", host: "web-01-shop.localhost" }]);
    expect(checks.find((c) => c.id === "loopback")).toMatchObject({ state: "ok" });
    expect(checks.find((c) => c.id === "recipes")).toMatchObject({ state: "ok" });
    // The router does not know the name; a service on loopback only; a recipe changed and waiting.
    s.state.listeners = `socket:[7]\n---\n${tcp("0100007F:0BB8", 7)}\n`;
    s.store.appendEvent("shop/01", { type: "recipe.requested", payload: { hash: "c".repeat(64) } });
    checks = await appChecks({ config: s.config, store: s.store, runtime: s.runtime, lanes: s.dockerLanes, get: async (_url, host) => host ? { status: 404, body: "ContextLanes: no running preview for this name." } : { status: 200, body: "ok" } });
    expect(checks.find((c) => c.id === "app-links")).toMatchObject({ state: "fail", found: expect.stringContaining("no route for web-01-shop") });
    expect(checks.find((c) => c.id === "loopback")).toMatchObject({ state: "warn", found: expect.stringContaining("127.0.0.1:3000") });
    expect(checks.find((c) => c.id === "recipes")).toMatchObject({ state: "warn", found: expect.stringContaining("shop/01 (recipe ccccccc)"), fix: expect.stringContaining("contextlanes approve") });
  });

  it("says which of the two proxy setups this machine allows", async () => {
    const config = Config.parse({ runtime: { mode: "docker" }, previews: { domain: "lanes.example.dev" } });
    const ps = (stdout: string): Runner => async (_c, args) => { expect(args).toEqual(["ps", "--filter", "network=contextlanes", "--format", '{{.Names}}\t{{.Label "contextlanes.lane"}}\t{{.Label "contextlanes.control"}}']); return { stdout }; };
    const alone = await proxyCheck(ps("contextlanes\t\t1\ncl-shop-01\tshop/01\t\n"), CONTROL, config);
    expect(alone).toMatchObject({ state: "warn", found: expect.stringContaining("(a) no other container is on the contextlanes network") });
    expect(alone.found).toContain("(b) the router is published on 127.0.0.1:4601 only");
    expect(alone.fix).toContain("docker network connect contextlanes <proxy container>");
    expect(alone.fix).toContain('"4601:4601"');
    const npm = await proxyCheck(ps("contextlanes\t\t1\nnginx-proxy-manager-app-1\t\t\n"), CONTROL, config);
    expect(npm).toMatchObject({ state: "ok", found: expect.stringContaining("(a) on the contextlanes network: nginx-proxy-manager-app-1") });
    const open = await proxyCheck(ps("contextlanes\t\t1\n"), { ...CONTROL, published: [{ port: "4601/tcp", host: "0.0.0.0:4601" }] }, config);
    expect(open).toMatchObject({ state: "ok", found: expect.stringContaining("(b) the router is published on 0.0.0.0:4601") });
    // Without a domain, links are for this machine only: nothing to warn about.
    expect((await proxyCheck(ps(""), CONTROL, Config.parse({ runtime: { mode: "docker" } }))).state).toBe("ok");
  });
});

describe("the contextlanes command against the Docker runtime", () => {
  it("app start exits 4 until approved, then --json prints one document; logs and url work", async () => {
    const s = await setup({ lane: { ".contextlanes.json": RECIPE }, project: {} });
    await s.app.listen({ port: 0, host: "127.0.0.1" });
    vi.stubEnv("CONTEXTLANES_URL", `http://127.0.0.1:${(s.app.server.address() as AddressInfo).port}`);
    const out: string[] = [], err: string[] = [];
    const io: Io = { api: (path, init) => api(path, { ...init, token: init?.token ?? s.token }), env: {}, cwd: "/root", out: (t) => out.push(t), err: (t) => err.push(t) };
    await expect(laneCommand("app", ["start", "shop/01"], { json: true }, io)).rejects.toMatchObject({ exit: 4, code: "recipe_unapproved" });
    expect(await laneCommand("approve", ["shop/01"], { json: true }, io)).toBe(0);
    expect(JSON.parse(out.pop()!)).toEqual({ approved: true, hash: sha(RECIPE) });
    expect(await laneCommand("app", ["start", "shop/01"], { json: true }, io)).toBe(0);
    expect(JSON.parse(out.pop()!)).toMatchObject({ services: [{ name: "web", state: "healthy", port: 3000 }] });
    expect(await laneCommand("url", ["web", "shop/01"], { json: true }, io)).toBe(0);
    expect(JSON.parse(out.pop()!)).toEqual({ service: "web", url: "http://web-01-shop.localhost:4601" });
    expect(await laneCommand("logs", ["web", "shop/01"], { json: true, lines: "2" }, io)).toBe(0);
    expect(JSON.parse(out.pop()!)).toHaveLength(2);
    // Inside the lane: approving is the owner's (exit 4), and the app's tools answer with the lane's token.
    const laneIo: Io = { ...io, api: (path, init) => api(path, init), env: { CONTEXTLANES_LANE: "shop/01", CONTEXTLANES_LANE_TOKEN: s.store.mintLaneToken("shop/01") } };
    await expect(laneCommand("approve", [], { json: true }, laneIo)).rejects.toMatchObject({ exit: 4, code: "owner_only" });
    expect(await laneCommand("app", ["status"], { json: true }, laneIo)).toBe(0);
    expect(JSON.parse(out.pop()!)).toMatchObject({ services: [{ name: "web", state: "healthy" }] });
    expect(err).toEqual([]);
  });
});
