import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, Config, EventBus, HostLinks, LaneManager, SetupManager, Store, hostCommand, sandbox, socketPath, type Runner } from "@contextlanes/daemon";

const PUBLIC = ["/api/health", "/api/setup/status", "/api/setup/local", "/api/setup/sign-in", "/api/setup/login/options", "/api/setup/login"];
const FORGED = { "tailscale-user-login": "kyle@example.com", host: "neo.test.ts.net", "x-forwarded-for": "100.64.0.1" };

async function fixture() {
  const data = await mkdtemp(join(tmpdir(), "cl-auth-"));
  await writeFile(join(data, "setup-token"), "shell-secret");
  const config = Config.parse({ paths: { data, lanes: join(data, "lanes") }, access: { owner: "kyle@example.com" } });
  const run: Runner = async () => ({ stdout: "" });
  const store = Store.open(":memory:"); const bus = new EventBus();
  const lanes = new LaneManager({ store, bus, config, run });
  const setup = new SetupManager(config, store, run, { path: join(data, "config.toml"), home: data, user: "kyle" });
  const routes: { method: string | string[]; url: string }[] = [];
  const app = buildServer({ store, bus, lanes, hosts: new HostLinks({ store, bus }), config, version: "test", run, setup, onRoute: (r) => routes.push(r) });
  await app.ready();
  store.addProject({ id: "shop", name: "Shop", path: "/code/shop" });
  for (const task of ["One", "Two"]) await lanes.start({ project: "shop", task });
  const token = (lane: string) => store.mintLaneToken(lane);
  return { app, store, routes, token, config };
}
const concrete = (url: string) => url.replace(":project", "shop").replace(":n", "01").replace(":tool", "env_status").replace(":agent", "codex").replace(":id", "c1").replace(":file", "1-after.png");

describe("who a request is from", () => {
  it("refuses every non-public route without a credential, whatever the headers claim", async () => {
    const { app, routes } = await fixture();
    const api = routes.filter((r) => r.url.startsWith("/api/") && !PUBLIC.includes(r.url));
    expect(api.length).toBeGreaterThan(40);
    for (const route of api) for (const method of [route.method].flat()) {
      for (const headers of [FORGED, { host: "127.0.0.1" }, { host: "localhost", "tailscale-user-login": "kyle@example.com" }, { ...FORGED, cookie: "cl-owner=anything" }]) {
        const res = await app.inject({ method: method as "GET", url: concrete(route.url), headers, ...(method === "GET" || method === "HEAD" ? {} : { payload: {} }) });
        expect([method, route.url, res.statusCode]).toEqual([method, route.url, 401]);
      }
    }
  });

  it("cannot be dodged by spelling the path differently", async () => {
    const { app } = await fixture();
    for (const url of ["/%61pi/inbox", "/api/%69nbox", "/api/inbox?x=/api/health", "/api/lanes/shop/01/tools/../approve"]) {
      expect([401, 404]).toContain((await app.inject({ url, headers: FORGED })).statusCode);
    }
    expect((await app.inject({ url: "/%61pi/inbox", headers: FORGED })).body).not.toContain("[]");
  });

  it("still refuses a Tailscale login that is not the owner, even with a valid session", async () => {
    const { app, store } = await fixture();
    const res = await app.inject({ url: "/api/inbox", headers: { authorization: `Bearer ${store.ownerSession()}`, "tailscale-user-login": "other@example.com" } });
    expect(res.statusCode).toBe(403);
  });

  it("accepts a session or the setup-token and nothing else", async () => {
    const { app, store } = await fixture();
    const get = (authorization: string) => app.inject({ url: "/api/inbox", headers: { authorization } });
    expect((await get(`Bearer ${store.ownerSession()}`)).statusCode).toBe(200);
    expect((await get("Bearer shell-secret")).statusCode).toBe(200);
    for (const bad of ["Bearer shell-secre", "Bearer ", "shell", "Bearer cl-lane-x"]) expect((await get(bad)).statusCode).toBe(401);
  });

  it("limits a lane token to that lane's toolbox routes", async () => {
    const { app, token } = await fixture();
    const a = { authorization: `Bearer ${token("shop/01")}` };
    expect((await app.inject({ method: "POST", url: "/api/lanes/shop/01/tools/env_status", headers: a, payload: {} })).statusCode).not.toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/lanes/shop/02/tools/env_status", headers: a, payload: {} })).statusCode).toBe(401);
    for (const [method, url] of [["GET", "/api/inbox"], ["POST", "/api/answers"], ["POST", "/api/tickets"], ["POST", "/api/lanes/shop/02/prompt"], ["POST", "/api/lanes/shop/01/prompt"], ["POST", "/api/lanes/shop/01/mode"], ["POST", "/api/lanes/shop/01/approve"], ["POST", "/api/lanes/shop/01/cleanup"], ["POST", "/api/projects/shop/recipe/approve"], ["POST", "/api/setup/settings"], ["POST", "/api/setup/agents/install"]] as const) {
      expect([url, (await app.inject({ method, url, headers: a, ...(method === "POST" ? { payload: {} } : {}) })).statusCode]).toEqual([url, 401]);
    }
  });

  it("stops accepting a lane token once the lane is cleaned", async () => {
    const { app, store, token } = await fixture();
    const a = { authorization: `Bearer ${token("shop/01")}` };
    store.db.prepare("UPDATE lane SET state = 'cleaned' WHERE id = 'shop/01'").run();
    expect((await app.inject({ method: "POST", url: "/api/lanes/shop/01/tools/env_status", headers: a, payload: {} })).statusCode).toBe(401);
  });

  it("gives tickets for one path, once, and only to the owner", async () => {
    const { app, store } = await fixture();
    const authorization = `Bearer ${store.ownerSession()}`;
    const issue = async (path: string) => (await app.inject({ method: "POST", url: "/api/tickets", headers: { authorization }, payload: { path } })).json().ticket as string;
    expect((await app.inject({ method: "POST", url: "/api/tickets", headers: { authorization }, payload: { path: "/api/inbox" } })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/inbox?ticket=${await issue("/api/stream")}` })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/stream", query: { ticket: "invented" } })).statusCode).toBe(401);
  });

  it("signs cookie sessions out once and tells the browser why", async () => {
    const { app } = await fixture();
    const first = await app.inject({ url: "/api/setup/status", headers: { cookie: "theme=dark; cl-owner=old-session" } });
    expect(first.json()).toMatchObject({ authorized: false, signedOut: true });
    expect(first.headers["set-cookie"]).toBe("cl-owner=; Path=/; Max-Age=0");
    expect((await app.inject({ url: "/api/setup/status" })).json().signedOut).toBe(false);
    expect((await app.inject({ url: "/api/inbox", headers: { cookie: "cl-owner=old-session" } })).statusCode).toBe(401);
  });
});

describe("what a lane process gets", () => {
  const config = Config.parse({ paths: { data: "/home/k/.local/share/contextlanes", lanes: "/home/k/lanes" } });
  const lane = { id: "shop/01", worktree: "/home/k/lanes/x", task: "t", agent: "claude-code", mode: "ask", model: null, hostUnit: "u" } as never;

  it("hides the data folder but keeps the release the lane host runs from", () => {
    const args = sandbox(config);
    expect(args.join(" ")).toContain(`--tmpfs ${config.paths.data} --ro-bind-try ${config.paths.data}/releases ${config.paths.data}/releases`);
    expect(args.join(" ")).toContain("--tmpfs /run");
    expect(args.at(-1)).toBe("--");
  });

  it("only opens the lane socket to the host", () => {
    expect(socketPath(config).startsWith(config.paths.data)).toBe(false);
    expect(sandbox(config).join(" ")).not.toContain("contextlanes-");
    expect(hostCommand(lane, config).join(" ")).toContain(`--socket=${socketPath(config)}`);
  });

  it("keeps the lane token out of the command line", () => {
    expect(hostCommand(lane, config)).toContain("--setenv=CONTEXTLANES_LANE_TOKEN");
    expect(hostCommand(lane, config).join(" ")).not.toContain("cl-lane-");
  });
});
