import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_NOTES, type EnvironmentView, type Lane } from "@contextlanes/protocol";
import { api, ClientError, laneCommand, resolveLane, type Api, type Flags, type Io } from "@contextlanes/cli";

const lane = (id: string, worktree: string, extra: Partial<Lane> = {}): Lane => ({
  id, project: id.split("/")[0]!, goal: null, task: "T", agent: "claude-code", model: null, mode: "edits", branch: `lane/${id}`, worktree,
  terminal: "t", state: "working", colour: "lc1", createdAt: "2026-11-10T00:00:00Z", ...extra,
} as Lane);

const env = (services: Partial<EnvironmentView["services"][number]>[], error: string | null = null): EnvironmentView => ({
  lane: "shop/01", recipeHash: "a".repeat(64), setup: null, startedAt: null, error,
  services: services.map((s) => ({ name: "web", unit: "u", port: 20100, url: null, state: "healthy", detail: null, probes: [], ms: null, lastFailure: null, healthPath: "/", healthStatus: 200, ...s })),
} as EnvironmentView);

type Call = { path: string; method: string; body?: unknown; token?: string };
function harness(routes: Record<string, (call: Call) => unknown>, vars: Record<string, string> = {}, cwd = "/home/kyle") {
  const calls: Call[] = [];
  const out: string[] = []; const err: string[] = [];
  const fake: Api = async <T>(path: string, init?: { method?: string; body?: unknown; token?: string }) => {
    const call = { path, method: init?.method ?? "GET", body: init?.body, token: init?.token };
    calls.push(call);
    const key = `${call.method} ${path.split("?")[0]}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected ${key}`);
    return handler(call) as T;
  };
  const io: Io = { api: fake, env: vars, cwd, out: (t) => out.push(t), err: (t) => err.push(t) };
  const run = (argv: string[], flags: Flags = {}) => laneCommand(argv[0], argv.slice(1), flags, io);
  return { run, calls, out, err, io };
}

describe("lane resolution", () => {
  const lanes = () => [lane("shop/01", "/lanes/shop-01"), lane("shop/02", "/lanes/shop-02"), lane("shop/03", "/code/shop", { direct: true }), lane("old/01", "/lanes/old", { state: "archived" })];

  it("prefers the lane named, then CONTEXTLANES_LANE, then the checkout holding this folder", async () => {
    const h = harness({ "GET /api/lanes": lanes });
    expect(await resolveLane("shop/09", h.io)).toBe("shop/09");
    expect(await resolveLane(undefined, { ...h.io, env: { CONTEXTLANES_LANE: "shop/02" } })).toBe("shop/02");
    expect(await resolveLane(undefined, { ...h.io, cwd: "/lanes/shop-01/src/app" })).toBe("shop/01");
    expect(await resolveLane(undefined, { ...h.io, cwd: "/code/shop" })).toBe("shop/03");
  });

  it("is a usage error outside any lane, and lists the open ones", async () => {
    const h = harness({ "GET /api/lanes": lanes }, {}, "/tmp");
    const failed = await resolveLane(undefined, h.io).catch((e: ClientError) => e);
    expect(failed).toMatchObject({ exit: 2, code: "usage" });
    expect((failed as Error).message).toContain("shop/01, shop/02, shop/03");
    expect((failed as Error).message).not.toContain("old/01");
  });
});

describe("env, logs and url as the owner", () => {
  it("shows the environment as a table, or as one JSON document", async () => {
    const view = env([{ name: "web", url: "https://web-01-shop.root.example.dev" }, { name: "api", port: 20101, state: "failed", detail: "Nothing answered on /health." }]);
    const h = harness({ "GET /api/lanes/shop/01/env": () => view }, { CONTEXTLANES_LANE: "shop/01" });
    expect(await h.run(["env"])).toBe(0);
    expect(h.out[0]).toMatch(/^SERVICE\s+STATE\s+PORT\s+LINK/);
    expect(h.out[0]).toContain("● healthy");
    expect(h.out[0]).toContain("api: Nothing answered on /health.");
    expect(await h.run(["env"], { json: true })).toBe(0);
    expect(JSON.parse(h.out[1]!)).toEqual(view);
  });

  it("says how to start when there is no environment yet", async () => {
    const h = harness({ "GET /api/lanes/shop/01/env": () => null });
    expect(await h.run(["env", "shop/01"])).toBe(0);
    expect(h.out[0]).toBe("No environment yet. Start it: contextlanes env start");
  });

  it("starts the named services and exits 1 with the detail and last log lines when one fails", async () => {
    const h = harness({
      "POST /api/lanes/shop/01/env/start": () => env([{ name: "web" }, { name: "api", state: "failed", detail: "Nothing answered on /health." }]),
      "GET /api/lanes/shop/01/logs": () => [{ at: "2026-11-10T00:00:00Z", text: "Error: EADDRINUSE" }],
    });
    expect(await h.run(["env", "start", "shop/01", "api"], { json: true })).toBe(1);
    expect(h.calls[0]).toMatchObject({ path: "/api/lanes/shop/01/env/start", method: "POST", body: { services: ["api"] } });
    expect(h.calls[1]!.path).toBe("/api/lanes/shop/01/logs?service=api&lines=20");
    expect(JSON.parse(h.out[0]!).services).toHaveLength(2);
    expect(h.err.join("\n")).toBe("api is failed: Nothing answered on /health.\nlast 1 log lines of api:\n  Error: EADDRINUSE");
  });

  it("exits 0 when every service came up, and restarts only what is named", async () => {
    const h = harness({ "POST /api/lanes/shop/01/env/restart": () => env([{ name: "web" }]) }, { CONTEXTLANES_LANE: "shop/01" });
    expect(await h.run(["env", "restart", "web"])).toBe(0);
    expect(h.calls[0]).toMatchObject({ body: { services: ["web"] } });
    expect(h.err).toEqual([]);
  });

  it("prints the bare link, and log lines", async () => {
    const h = harness({
      "GET /api/lanes/shop/01/url": () => ({ service: "api", url: "https://api-01-shop.root.example.dev" }),
      "GET /api/lanes/shop/01/logs": () => [{ at: "t1", text: "ready" }],
    }, { CONTEXTLANES_LANE: "shop/01" });
    expect(await h.run(["url", "api"])).toBe(0);
    expect(h.out[0]).toBe("https://api-01-shop.root.example.dev");
    expect(h.calls[0]!.path).toBe("/api/lanes/shop/01/url?service=api");
    expect(await h.run(["url"])).toBe(0);
    expect(h.calls[1]!.path).toBe("/api/lanes/shop/01/url?service=web");
    expect(await h.run(["logs", "web"], { lines: "5" })).toBe(0);
    expect(h.calls[2]!.path).toBe("/api/lanes/shop/01/logs?service=web&lines=5");
    expect(h.out[2]).toBe("t1  ready");
  });

  it("refuses wrong usage with exit code 2", async () => {
    const h = harness({}, { CONTEXTLANES_LANE: "shop/01" });
    await expect(h.run(["logs"])).rejects.toMatchObject({ exit: 2 });
    await expect(h.run(["logs", "web"], { lines: "9000" })).rejects.toMatchObject({ exit: 2 });
    await expect(h.run(["lane", "rm"])).rejects.toMatchObject({ exit: 2 });
    expect(await h.run(["lanes"])).toBeNull();
  });
});

describe("what the owner does from the command line instead of the web app", () => {
  it("renames a lane, restarts its agent and turns Auto on or off", async () => {
    const h = harness({
      "PATCH /api/lanes/shop/01": () => ({ id: "shop/01", task: "Cart totals" }),
      "POST /api/lanes/shop/01/restart": () => ({ id: "shop/01" }),
      "POST /api/lanes/shop/01/auto": () => ({ answered: 2 }),
    });
    expect(await h.run(["lane", "rename", "shop/01", "Cart", "totals"])).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: "PATCH", body: { task: "Cart totals" } });
    expect(await h.run(["lane", "restart", "shop/01"])).toBe(0);
    expect(await h.run(["lane", "auto", "shop/01", "on"])).toBe(0);
    expect(h.calls[2]).toMatchObject({ path: "/api/lanes/shop/01/auto", body: { on: true } });
    expect(await h.run(["lane", "auto", "shop/01", "off"])).toBe(0);
    expect(h.calls[3]!.body).toEqual({ on: false });
    await expect(h.run(["lane", "auto", "shop/01", "maybe"])).rejects.toMatchObject({ exit: 2 });
    await expect(h.run(["lane", "rename", "shop/01"])).rejects.toMatchObject({ exit: 2 });
  });
});

describe("inside a lane, with only the lane token", () => {
  const vars = { CONTEXTLANES_LANE: "shop/01", CONTEXTLANES_LANE_TOKEN: "lane-secret" };

  it("uses the lane's tool routes with its token", async () => {
    const h = harness({
      "POST /api/lanes/shop/01/tools/env_status": () => env([{}]),
      "POST /api/lanes/shop/01/tools/env_start": () => env([{}]),
      "POST /api/lanes/shop/01/tools/env_stop": () => env([{ state: "stopped" }]),
      "POST /api/lanes/shop/01/tools/env_restart": () => env([{}]),
      "POST /api/lanes/shop/01/tools/preview_url": () => ({ service: "web", url: "http://web-01-shop.localhost:4601" }),
      "POST /api/lanes/shop/01/tools/get_logs": () => [],
      "POST /api/lanes/shop/01/tools/recipe_status": () => null,
    }, vars);
    for (const argv of [["env"], ["env", "start"], ["env", "stop"], ["env", "restart", "web"], ["url"], ["logs", "web"], ["recipe"]]) expect(await h.run(argv), argv.join(" ")).toBe(0);
    expect(h.calls.every((c) => c.token === "lane-secret" && c.method === "POST" && c.path.startsWith("/api/lanes/shop/01/tools/"))).toBe(true);
    expect(h.calls.find((c) => c.path.endsWith("/env_restart"))!.body).toEqual({ services: ["web"] });
    expect(h.calls.find((c) => c.path.endsWith("/get_logs"))!.body).toEqual({ service: "web", lines: 100 });
  });

  it("never approves a recipe or deletes a lane, and says the owner must (exit 4)", async () => {
    const h = harness({}, vars);
    await expect(h.run(["recipe", "approve"])).rejects.toMatchObject({ exit: 4, code: "owner_only" });
    await expect(h.run(["lane", "rm", "shop/01"])).rejects.toMatchObject({ exit: 4, code: "owner_only" });
    for (const argv of [["lane", "auto", "shop/01", "on"], ["lane", "rename", "shop/01", "Easier"], ["lane", "restart", "shop/01"]]) await expect(h.run(argv), argv.join(" ")).rejects.toMatchObject({ exit: 4, code: "owner_only" });
    expect(h.calls).toEqual([]);
  });
});

describe("recipes and lane rm as the owner", () => {
  const view = { file: ".contextlanes.json", hash: "b".repeat(64), approved: false, error: null, recipe: { services: [{ name: "web", command: ["vite"] }] } };

  it("shows a recipe and approves exactly the hash it read", async () => {
    const h = harness({ "GET /api/projects/shop/recipe": () => view, "POST /api/projects/shop/recipe/approve": (c) => ({ approved: true, hash: (c.body as { hash: string }).hash }) }, { CONTEXTLANES_LANE: "shop/01" });
    expect(await h.run(["recipe"])).toBe(0);
    expect(h.out[0]).toBe(`.contextlanes.json · sha bbbbbbb · waiting for the owner's approval\nservices:\n  web: vite`);
    expect(await h.run(["recipe", "approve", "shop"])).toBe(0);
    expect(h.calls.at(-1)).toMatchObject({ path: "/api/projects/shop/recipe/approve", body: { hash: "b".repeat(64) } });
  });

  it("keeps a lane with uncommitted changes unless forced", async () => {
    const h = harness({ "GET /api/lanes/shop/01/discard": () => ({ uncommitted: 2, commits: 1, branch: "lane/01-x", present: true }), "POST /api/lanes/shop/01/discard": (c) => ({ ...lane("shop/01", "/x"), state: "archived", body: c.body }) });
    await expect(h.run(["lane", "rm", "shop/01"])).rejects.toMatchObject({ exit: 1, code: "uncommitted" });
    expect(h.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(await h.run(["lane", "rm", "shop/01"], { force: true, "delete-branch": true })).toBe(0);
    expect(h.calls.at(-1)).toMatchObject({ method: "POST", body: { deleteBranch: true } });
  });

  it("prints the agent notes", async () => {
    const h = harness({});
    expect(await h.run(["agent-notes"])).toBe(0);
    expect(h.out[0]).toBe(AGENT_NOTES);
    expect(AGENT_NOTES.split("\n").length).toBeLessThan(25);
  });
});

describe("exit codes from the daemon's answers", () => {
  const saved = process.env.CONTEXTLANES_URL;
  afterEach(() => { process.env.CONTEXTLANES_URL = saved; });

  it("maps unreachable to 3, waiting on the owner to 4 and other refusals to 1", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/approve") { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "needs approval", code: "recipe_unapproved" })); return; }
      if (req.url === "/text") { res.writeHead(502); res.end("Bad Gateway"); return; }
      res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "no" }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    process.env.CONTEXTLANES_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await expect(api("/approve", { token: "t" })).rejects.toMatchObject({ exit: 4, code: "recipe_unapproved", message: "needs approval" });
    await expect(api("/other", { token: "t" })).rejects.toMatchObject({ exit: 1, code: "failed" });
    await expect(api("/text", { token: "t" })).rejects.toMatchObject({ exit: 1, message: "502 Bad Gateway" });
    server.close();
    process.env.CONTEXTLANES_URL = "http://127.0.0.1:1";
    await expect(api("/x", { token: "t" })).rejects.toMatchObject({ exit: 3, code: "unreachable" });
  });
});

describe("the README", () => {
  it("carries the same agent notes the CLI prints", async () => {
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(new URL("../../../README.md", import.meta.url), "utf8")).toContain(AGENT_NOTES);
  });
});
