import { signedIn } from "./signed-in.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Recipe, RECIPE_FILE } from "@contextlanes/protocol";
import { buildServer, Config, EventBus, HostLinks, LaneManager, Runtime, Store, type Runner } from "@contextlanes/daemon";
import { laneDatabaseName, pgEnv } from "../src/databases.js";
import { readRecipe } from "../src/recipes.js";
import { Resources } from "../src/resources.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });
const PG = { admin: "postgres://admin:s%40cret@db.local:5433/postgres", app: "postgres://shop_app:apppw@db.local:5433/postgres" };

describe("lane database names and logins", () => {
  it("names each copy after its template and lane, within Postgres's 63 characters", () => {
    expect(laneDatabaseName("shop_dev", "shop/01")).toBe("shop_dev_shop_01");
    expect(laneDatabaseName("x".repeat(40), "very-long-project-name-here/12").length).toBeLessThanOrEqual(63);
  });
  it("passes logins to psql in the environment, never as arguments", () => {
    expect(pgEnv(PG.admin)).toMatchObject({ PGHOST: "db.local", PGPORT: "5433", PGUSER: "admin", PGPASSWORD: "s@cret", PGDATABASE: "postgres" });
  });
  it("accepts only plain database names in recipes", () => {
    expect(() => Recipe.parse({ database: { kind: "postgres", template: "shop\"; DROP" } })).toThrow();
    expect(Recipe.parse({ database: { kind: "postgres", template: "shop_dev" } }).database).toEqual({ kind: "postgres", template: "shop_dev", env: "DATABASE_URL" });
    expect(() => Recipe.parse({ database: { kind: "sqlite", file: "../outside.db" } })).toThrow();
  });
});

async function setup(database: unknown, config: Record<string, unknown> = { databases: { postgres: PG } }) {
  const root = await mkdtemp(join(tmpdir(), "cl-db-"));
  roots.push(root);
  const repo = join(root, "repo"); const worktree = join(root, "lane");
  await mkdir(repo); await mkdir(worktree);
  const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
  const existing = new Set<string>();
  const run: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, ...(opts?.env ? { env: opts.env } : {}) });
    if (cmd === "psql") {
      const sql = args.at(-1)!;
      const m = /datname = '([^']+)'/.exec(sql); if (m) return { stdout: existing.has(m[1]!) ? "1\n" : "" };
      const c = /CREATE DATABASE "([^"]+)"/.exec(sql); if (c) existing.add(c[1]!);
      return { stdout: "" };
    }
    if (cmd === "systemctl" && args[1] === "show") return { stdout: "ActiveState=active\nControlGroup=/user.slice/x\n" };
    if (cmd === "du") return { stdout: "10\tx\n" };
    return { stdout: "" };
  };
  const cfg = Config.parse({ paths: { data: root, lanes: root }, ...config });
  const store = Store.open(":memory:");
  const bus = new EventBus();
  const runtime = new Runtime({ store, bus, config: cfg, run, freePort: async () => 20200, fetch: (async () => new Response("ok")) as typeof fetch });
  const app = signedIn(buildServer({ store, bus, lanes: new LaneManager({ store, bus, config: cfg, run }), hosts: new HostLinks({ store, bus }), config: cfg, version: "test", run, runtime, resources: new Resources(store, run, async () => null) }), store);
  store.addProject({ id: "shop", name: "Shop", path: repo });
  store.insertLane({ id: "shop/01", n: 1, project: "shop", goal: null, task: "Billing", agent: "codex", model: null, mode: "ask", branch: "lane/01-billing", worktree, terminal: "cl-shop-01", hostUnit: null, base: null, state: "working", colour: "lc1" });
  await writeFile(join(worktree, RECIPE_FILE), JSON.stringify({ database, setup: [{ name: "Migrate", command: ["pnpm", "migrate"] }], services: [{ name: "api", command: ["node", "api.js"] }] }));
  store.approveRecipe("shop", (await readRecipe(store, store.getProject("shop")!, worktree))!.hash);
  return { root, repo, worktree, store, runtime, app, calls };
}
const setenv = (args: string[]) => args.filter((a) => a.startsWith("--setenv=")).map((a) => a.slice(9));

describe("per-lane Postgres", () => {
  it("copies the template owned by the app login before setup, and gives setup and services only the app login", async () => {
    const { app, calls, store } = await setup({ kind: "postgres", template: "shop_dev" });
    const res = await app.inject({ method: "POST", url: "/api/lanes/shop/01/env/start", payload: {} });
    expect(res.statusCode).toBe(200);
    const psql = calls.filter((c) => c.cmd === "psql");
    expect(psql.map((c) => c.args.at(-1))).toEqual(["SELECT 1 FROM pg_database WHERE datname = 'shop_dev_shop_01'", 'CREATE DATABASE "shop_dev_shop_01" TEMPLATE "shop_dev" OWNER "shop_app"', 'REASSIGN OWNED BY CURRENT_USER TO "shop_app"']);
    expect(psql[2]!.env!.PGDATABASE).toBe("shop_dev_shop_01");
    expect(psql.every((c) => c.env?.PGUSER === "admin" && !c.args.join(" ").includes("s@cret"))).toBe(true);
    const units = calls.filter((c) => c.cmd === "systemd-run");
    const url = "postgres://shop_app:apppw@db.local:5433/shop_dev_shop_01";
    expect(setenv(units[0]!.args)).toContain(`DATABASE_URL=${url}`); // the setup step
    expect(setenv(units.at(-1)!.args)).toContain(`DATABASE_URL=${url}`); // the service
    expect(units.flatMap((u) => u.args).join(" ")).not.toContain("admin");
    expect(store.environment("shop/01")!.setup!.database).toEqual({ kind: "postgres", name: "shop_dev_shop_01", template: "shop_dev" });
  });

  it("drops the copy on clean up, and keeps the lane if it cannot", async () => {
    const { runtime, calls, store } = await setup({ kind: "postgres", template: "shop_dev" });
    await runtime.dropDatabase(store.getLane("shop/01")!); // no setup yet: the name comes from the recipe
    expect(calls.at(-1)!.args.at(-1)).toBe('DROP DATABASE IF EXISTS "shop_dev_shop_01" WITH (FORCE)');
  });

  it("asks for the logins in config instead of guessing", async () => {
    const { app } = await setup({ kind: "postgres", template: "shop_dev" }, {});
    const res = await app.inject({ method: "POST", url: "/api/lanes/shop/01/env/start", payload: {} });
    expect(res.json().error).toMatch(/Add \[databases\.postgres\]/);
  });
});

describe("per-lane SQLite", () => {
  it("copies the file from the main checkout and points setup and services at the copy", async () => {
    const { app, repo, worktree, calls } = await setup({ kind: "sqlite", file: "data/dev.db" });
    await mkdir(join(repo, "data")); await writeFile(join(repo, "data/dev.db"), "SQLite format 3");
    expect((await app.inject({ method: "POST", url: "/api/lanes/shop/01/env/start", payload: {} })).statusCode).toBe(200);
    expect(await readFile(join(worktree, "data/dev.db"), "utf8")).toBe("SQLite format 3");
    expect(setenv(calls.filter((c) => c.cmd === "systemd-run").at(-1)!.args)).toContain(`DATABASE_PATH=${join(worktree, "data/dev.db")}`);
  });
});
