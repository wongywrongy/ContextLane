import { signedIn } from "./signed-in.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Recipe, RECIPE_FILE } from "@contextlanes/protocol";
import { buildServer, Config, EventBus, HostLinks, LaneManager, Runtime, Store, runCommand, type Runner } from "@contextlanes/daemon";
import { createLaneDatabase, laneDatabaseName, pgEnv } from "../src/databases.js";
import { readRecipe } from "../src/recipes.js";
import { Resources } from "../src/resources.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });
const PG = { admin: "postgres://admin:s%40cret@db.local:5433/postgres", app: "postgres://shop_app:apppw@db.local:5433/postgres" };

describe("lane database names and logins", () => {
  it("names each copy after its template and lane, within Postgres's 63 characters", () => {
    expect(laneDatabaseName("shop_dev", "shop/01")).toBe("shop_dev_shop_01");
    expect(laneDatabaseName("x".repeat(40), "very-long-project-name-here/12").length).toBeLessThanOrEqual(63);
    const long = `${"p".repeat(63)}/01_before_${"f".repeat(24)}`;
    const name = laneDatabaseName("x".repeat(40), long);
    expect(name).toMatch(/^[a-z_][a-z0-9_]{0,62}$/);
    expect(laneDatabaseName("x".repeat(40), long.replace(/f$/, "e"))).not.toBe(name);
    expect(laneDatabaseName("x".repeat(39) + "y", long)).not.toBe(name);
    expect(laneDatabaseName("shop_dev", "bad/'\"; DROP")).toMatch(/^[a-z_][a-z0-9_]{0,62}$/);
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
  const failures = { setup: false, launch: false, ownership: false, drop: false };
  const run: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, ...(opts?.env ? { env: opts.env } : {}) });
    if (cmd === "psql") {
      const sql = args.at(-1)!;
      const m = /datname = '([^']+)'/.exec(sql); if (m) return { stdout: existing.has(m[1]!) ? "1\n" : "" };
      const c = /CREATE DATABASE "([^"]+)"/.exec(sql); if (c) existing.add(c[1]!);
      if (sql.startsWith("REASSIGN") && failures.ownership) throw new Error("ownership denied");
      const d = /DROP DATABASE IF EXISTS "([^"]+)"/.exec(sql);
      if (d) { if (failures.drop) throw new Error("drop denied"); existing.delete(d[1]!); }
      return { stdout: "" };
    }
    if (cmd === "git" && args[0] === "worktree" && args[1] === "add") await mkdir(args[3]!, { recursive: true });
    if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") await rm(args[3]!, { recursive: true, force: true });
    if (cmd === "systemd-run" && args.includes("--wait") && failures.setup) throw new Error("migration failed");
    if (cmd === "systemd-run" && args.some((a) => a.startsWith("--unit=contextlanes-env-before-")) && failures.launch) throw new Error("service launch failed");
    if (cmd === "systemctl" && args[1] === "show") return { stdout: "ActiveState=active\nControlGroup=/user.slice/x\n" };
    if (cmd === "du") return { stdout: "10\tx\n" };
    return { stdout: "" };
  };
  const cfg = Config.parse({ paths: { data: root, lanes: root }, ...config });
  const store = Store.open(":memory:");
  const bus = new EventBus();
  const runtime = new Runtime({ store, bus, config: cfg, run, freePort: async () => 20200, fetch: (async () => new Response("ok")) as typeof fetch });
  const app = signedIn(buildServer({ store, bus, lanes: new LaneManager({ store, bus, config: cfg, run }), hosts: new HostLinks({ store, bus }), config: cfg, version: "test", run, runtime, resources: new Resources(store, run, async () => null) }), store, cfg);
  store.addProject({ id: "shop", name: "Shop", path: repo });
  store.insertLane({ id: "shop/01", n: 1, project: "shop", goal: null, task: "Billing", agent: "codex", model: null, mode: "ask", branch: "lane/01-billing", worktree, terminal: "cl-shop-01", hostUnit: null, base: null, state: "working", colour: "lc1" });
  await writeFile(join(worktree, RECIPE_FILE), JSON.stringify({ database, setup: [{ name: "Migrate", command: ["pnpm", "migrate"] }], services: [{ name: "api", command: ["node", "api.js"] }] }));
  store.approveRecipe("shop", (await readRecipe(store, store.getProject("shop")!, worktree))!.hash);
  return { root, repo, worktree, store, runtime, app, calls, existing, failures, run, config: cfg };
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

  it("gives checks the prepared lane database and ports without repeating migration", async () => {
    const { runtime, store, calls } = await setup({ kind: "postgres", template: "shop_dev" });
    const lane = store.getLane("shop/01")!;
    const recipe = await runtime.recipeFor(lane);
    const env = await runtime.checkEnvironment(lane, recipe);
    expect(env).toMatchObject({ HOST: "127.0.0.1", CONTEXTLANES_LANE: lane.id, PORT: "20200", PORT_API: "20200", DATABASE_URL: "postgres://shop_app:apppw@db.local:5433/shop_dev_shop_01" });
    await runtime.start(lane.id);
    expect(await runtime.checkEnvironment(lane, recipe)).toEqual(env);
    expect(calls.filter((c) => c.cmd === "systemd-run" && c.args.includes("--wait"))).toHaveLength(1);
    expect(setenv(calls.filter((c) => c.cmd === "systemd-run").at(-1)!.args)).toContain(`DATABASE_URL=${env.DATABASE_URL}`);
  });

  it("does not give checks an environment from an edited, unapproved recipe", async () => {
    const { runtime, store, worktree } = await setup({ kind: "postgres", template: "shop_dev" });
    const lane = store.getLane("shop/01")!;
    const recipe = await runtime.recipeFor(lane);
    await writeFile(join(worktree, RECIPE_FILE), JSON.stringify({ database: { kind: "postgres", template: "other_dev" } }));
    await expect(runtime.checkEnvironment(lane, recipe)).rejects.toThrow(/approval/);
  });

  it("rolls back only a newly created database when assigning table ownership fails", async () => {
    const { run, config, store, repo, existing, failures } = await setup({ kind: "postgres", template: "shop_dev" });
    const db = Recipe.parse({ database: { kind: "postgres", template: "shop_dev" } }).database!;
    const lane = store.getLane("shop/01")!;
    failures.ownership = true;
    await expect(createLaneDatabase(run, config, db, lane, repo)).rejects.toThrow("ownership denied");
    expect(existing.size).toBe(0);
    existing.add("shop_dev_shop_01");
    await expect(createLaneDatabase(run, config, db, lane, repo, { reuse: false })).rejects.toThrow(/already exists/);
    expect(existing.has("shop_dev_shop_01")).toBe(true);
  });
});

describe("disposable screenshot baseline", () => {
  it("uses a unique database for migration and services and removes only baseline resources", async () => {
    const { runtime, store, calls, existing } = await setup({ kind: "postgres", template: "shop_dev" });
    const lane = store.getLane("shop/01")!;
    const active = await runtime.start(lane.id);
    const recipe = (await runtime.recipeFor(lane))!;
    const before = calls.length;
    expect(await runtime.fromCommit(lane, recipe, "abc1234", async () => "captured")).toBe("captured");
    await runtime.fromCommit(lane, recipe, "abc1234", async () => "second");
    const baseline = calls.slice(before);
    const names = baseline.filter((c) => c.cmd === "psql" && c.args.at(-1)?.startsWith("CREATE DATABASE")).map((c) => /CREATE DATABASE "([^"]+)"/.exec(c.args.at(-1)!)![1]!);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name).not.toBe("shop_dev_shop_01");
      expect(name).toMatch(/^[a-z_][a-z0-9_]{0,62}$/);
      const env = `DATABASE_URL=postgres://shop_app:apppw@db.local:5433/${name}`;
      expect(baseline.filter((c) => c.cmd === "systemd-run" && setenv(c.args).includes(env))).toHaveLength(2);
      expect(baseline.some((c) => c.cmd === "psql" && c.args.at(-1) === `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)).toBe(true);
    }
    const started = baseline.filter((c) => c.cmd === "systemd-run" && !c.args.includes("--wait")).map((c) => c.args.find((a) => a.startsWith("--unit="))!.slice(7));
    expect(baseline.filter((c) => c.cmd === "systemctl" && c.args[1] === "stop").map((c) => c.args[2])).toEqual(started);
    expect(baseline.filter((c) => c.cmd === "git" && c.args[1] === "remove")).toHaveLength(2);
    expect([...existing]).toEqual(["shop_dev_shop_01"]);
    expect(store.environment(lane.id)).toEqual(active);
  });

  it.each(["setup", "launch", "capture"] as const)("cleans up after %s fails without touching the active lane", async (point) => {
    const { runtime, store, calls, existing, failures } = await setup({ kind: "postgres", template: "shop_dev" });
    const lane = store.getLane("shop/01")!;
    const active = await runtime.start(lane.id);
    const recipe = (await runtime.recipeFor(lane))!;
    if (point !== "capture") failures[point] = true;
    const before = calls.length;
    await expect(runtime.fromCommit(lane, recipe, "abc1234", async () => { throw new Error("capture failed"); })).rejects.toThrow(/failed/);
    const baseline = calls.slice(before);
    expect([...existing]).toEqual(["shop_dev_shop_01"]);
    expect(store.environment(lane.id)).toEqual(active);
    expect(baseline.some((c) => c.cmd === "git" && c.args[1] === "remove")).toBe(true);
    const starts = baseline.filter((c) => c.cmd === "systemd-run" && !c.args.includes("--wait"));
    expect(starts).toHaveLength(point === "setup" ? 0 : 1);
    for (const start of starts) expect(baseline).toContainEqual({ cmd: "systemctl", args: ["--user", "stop", start.args.find((a) => a.startsWith("--unit="))!.slice(7)] });
  });

  it("reports failed cleanup and still attempts to remove the worktree", async () => {
    const { runtime, store, calls, failures } = await setup({ kind: "postgres", template: "shop_dev" });
    const lane = store.getLane("shop/01")!;
    failures.drop = true;
    await expect(runtime.fromCommit(lane, (await runtime.recipeFor(lane))!, "abc1234", async () => "captured")).rejects.toThrow(/Baseline cleanup failed/);
    expect(calls.some((c) => c.cmd === "git" && c.args[1] === "remove")).toBe(true);
  });
});

describe("disposable check snapshot", () => {
  it("uses real Git's recorded commit while the agent edits its original checkout", async () => {
    const { store, repo, worktree, config, run: fakeRun } = await setup(undefined);
    const git = (...args: string[]) => runCommand("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo });
    await git("init");
    await writeFile(join(repo, "source.txt"), "committed");
    await git("add", "source.txt"); await git("commit", "-m", "fixture");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(repo, "source.txt"), "uncommitted main change");
    await writeFile(join(worktree, "source.txt"), "agent edit");
    const run: Runner = (cmd, args, opts) => cmd === "git" ? runCommand(cmd, ["-c", "core.hooksPath=/dev/null", ...args], opts) : fakeRun(cmd, args, opts);
    const runtime = new Runtime({ store, bus: new EventBus(), config, run });
    const lane = store.getLane("shop/01")!;
    let snapshotPath = "";
    await runtime.withCheckSnapshot(lane, Recipe.parse({ copy: [] }), head, async (snapshot) => {
      snapshotPath = snapshot.worktree;
      expect(await readFile(join(snapshot.worktree, "source.txt"), "utf8")).toBe("committed");
      await writeFile(join(lane.worktree, "source.txt"), "edit during checks");
      expect(await readFile(join(snapshot.worktree, "source.txt"), "utf8")).toBe("committed");
      expect((await runCommand("git", ["rev-parse", "HEAD"], { cwd: snapshot.worktree })).stdout.trim()).toBe(head);
    });
    await expect(readFile(join(snapshotPath, "source.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await git("worktree", "list", "--porcelain")).stdout).not.toContain(snapshotPath);
    expect(await readFile(join(repo, "source.txt"), "utf8")).toBe("uncommitted main change");
    expect(await readFile(join(worktree, "source.txt"), "utf8")).toBe("edit during checks");
  });

  it("prepares the requested commit with an isolated database even when there are no services", async () => {
    const { runtime, store, worktree, calls, existing } = await setup({ kind: "postgres", template: "shop_dev" });
    await writeFile(join(worktree, RECIPE_FILE), JSON.stringify({ copy: [], database: { kind: "postgres", template: "shop_dev" }, setup: [{ name: "Migrate", command: ["pnpm", "migrate"] }] }));
    store.approveRecipe("shop", (await readRecipe(store, store.getProject("shop")!, worktree))!.hash);
    const lane = store.getLane("shop/01")!;
    const recipe = (await runtime.recipeFor(lane))!;
    let path = "";
    expect(await runtime.withCheckSnapshot(lane, recipe, "exact-commit", async (snapshot, env) => {
      path = snapshot.worktree;
      expect(snapshot.id).not.toBe(lane.id);
      expect(snapshot.worktree).not.toBe(lane.worktree);
      expect(env).toMatchObject({ HOST: "127.0.0.1", CONTEXTLANES_LANE: snapshot.id });
      expect(env).not.toHaveProperty("PORT");
      const name = new URL(env.DATABASE_URL!).pathname.slice(1);
      expect(name).not.toBe("shop_dev_shop_01");
      expect(existing.has(name)).toBe(true);
      expect(setenv(calls.find((c) => c.cmd === "systemd-run")!.args)).toContain(`DATABASE_URL=${env.DATABASE_URL}`);
      expect(calls).toContainEqual({ cmd: "git", args: ["worktree", "add", "--detach", snapshot.worktree, "exact-commit"] });
      return "checked";
    })).toBe("checked");
    expect(calls.filter((c) => c.cmd === "systemd-run" && !c.args.includes("--wait"))).toEqual([]);
    expect(calls).toContainEqual({ cmd: "git", args: ["worktree", "remove", "--force", path] });
    expect(existing.size).toBe(0);
    expect(store.environment(lane.id)).toBeNull();
  });

  it.each(["setup", "checks"] as const)("removes check resources after %s fails and preserves the active lane", async (point) => {
    const { runtime, store, calls, existing, failures } = await setup({ kind: "postgres", template: "shop_dev" });
    const lane = store.getLane("shop/01")!;
    const active = await runtime.start(lane.id);
    failures.setup = point === "setup";
    const before = calls.length;
    await expect(runtime.withCheckSnapshot(lane, (await runtime.recipeFor(lane))!, "exact-commit", async () => { throw new Error("checks failed"); })).rejects.toThrow(/failed/);
    expect([...existing]).toEqual(["shop_dev_shop_01"]);
    expect(store.environment(lane.id)).toEqual(active);
    expect(calls.slice(before).some((c) => c.cmd === "git" && c.args[1] === "remove")).toBe(true);
    expect(calls.slice(before).filter((c) => c.cmd === "systemd-run" && !c.args.includes("--wait"))).toEqual([]);
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

  it("keeps baseline file changes separate from the active lane and removes the temporary copy", async () => {
    const { runtime, store, repo, worktree, calls } = await setup({ kind: "sqlite", file: "data/dev.db" });
    await mkdir(join(repo, "data")); await writeFile(join(repo, "data/dev.db"), "template");
    const lane = store.getLane("shop/01")!;
    await runtime.start(lane.id);
    await writeFile(join(worktree, "data/dev.db"), "active lane");
    let baseline = "";
    await runtime.fromCommit(lane, (await runtime.recipeFor(lane))!, "abc1234", async () => {
      baseline = setenv(calls.filter((c) => c.cmd === "systemd-run").at(-1)!.args).find((e) => e.startsWith("DATABASE_PATH="))!.slice("DATABASE_PATH=".length);
      expect(baseline).not.toBe(join(worktree, "data/dev.db"));
      expect(await readFile(baseline, "utf8")).toBe("template");
      await writeFile(baseline, "baseline migration");
    });
    expect(await readFile(join(worktree, "data/dev.db"), "utf8")).toBe("active lane");
    expect(await readFile(join(repo, "data/dev.db"), "utf8")).toBe("template");
    await expect(readFile(baseline)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
