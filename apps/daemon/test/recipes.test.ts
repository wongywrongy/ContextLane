import { signedIn } from "./signed-in.js";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Recipe, RECIPE_FILE } from "@contextlanes/protocol";
import { buildServer, Config, EventBus, HostLinks, LaneManager, Store, type Runner } from "@contextlanes/daemon";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });
const RECIPE = JSON.stringify({ services: [{ name: "web", command: ["pnpm", "dev", "--port", "$PORT"] }], checks: [{ name: "Tests", command: ["pnpm", "test"] }] });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "cl-recipes-"));
  roots.push(root);
  const run: Runner = async () => ({ stdout: "" });
  const config = Config.parse({ paths: { data: root, lanes: join(root, "lanes") }, access: { owner: "kyle@example.com" } });
  const store = Store.open(":memory:");
  const bus = new EventBus();
  const app = signedIn(buildServer({ store, bus, lanes: new LaneManager({ store, bus, config, run }), hosts: new HostLinks({ store, bus }), config, version: "test", run }), store, config);
  store.addProject({ id: "shop", name: "Shop", path: root });
  const approve = (hash: string, headers: Record<string, string> = {}) => app.inject({ method: "POST", url: "/api/projects/shop/recipe/approve", headers, payload: { hash } });
  const view = async () => (await app.inject({ url: "/api/projects/shop/recipe" })).json();
  return { root, store, app, approve, view };
}

describe("recipe schema", () => {
  it("fills in ports, health checks and screenshots", () => {
    expect(Recipe.parse(JSON.parse(RECIPE)).services[0]).toMatchObject({ port: { env: "PORT" }, health: { path: "/", status: 200, timeoutSeconds: 60 }, env: {} });
    expect(Recipe.parse({}).screenshots).toEqual(["/"]);
  });
  it("refuses shell strings, unknown keys, duplicate services and paths outside the repository", () => {
    expect(() => Recipe.parse({ services: [{ name: "web", command: "pnpm dev" }] })).toThrow();
    expect(() => Recipe.parse({ autoApprove: true })).toThrow();
    expect(() => Recipe.parse({ services: [{ name: "web", command: ["a"] }, { name: "web", command: ["b"] }] })).toThrow();
    expect(() => Recipe.parse({ cache: ["../secrets"] })).toThrow();
    expect(() => Recipe.parse({ cache: ["/etc"] })).toThrow();
  });
});

describe("recipe approval", () => {
  it("does not read recipes outside the checkout or block on special files", async () => {
    const { root, view } = await setup();
    const other = await mkdtemp(join(tmpdir(), "cl-other-")); roots.push(other);
    await writeFile(join(other, "private"), "private-value");
    await symlink(join(other, "private"), join(root, RECIPE_FILE));
    expect(await view()).toBeNull();
    await rm(join(root, RECIPE_FILE));
    await promisify(execFile)("mkfifo", [join(root, RECIPE_FILE)]);
    expect(await view()).toBeNull();
    await rm(join(root, RECIPE_FILE));
    await symlink(other, join(root, ".superset"));
    await writeFile(join(other, "config.json"), RECIPE);
    expect(await view()).toBeNull();
  });

  it("approves exact bytes from the owner's session, and a changed recipe needs approval again", async () => {
    const { root, store, approve, view } = await setup();
    await writeFile(join(root, RECIPE_FILE), RECIPE);
    const first = await view();
    expect(first).toMatchObject({ approved: false, error: null });
    expect((await approve(first.hash)).statusCode).toBe(200);
    expect(await view()).toMatchObject({ approved: true, hash: first.hash });
    expect(store.getProject("shop")!.recipeHash).toBe(first.hash);

    await writeFile(join(root, RECIPE_FILE), `${RECIPE} `);
    const changed = await view();
    expect(changed.hash).not.toBe(first.hash);
    expect(changed.approved).toBe(false);
    expect((await approve(first.hash)).statusCode).toBe(409);
  });

  it("refuses anything that is not the owner's session, including what an agent can send from this machine", async () => {
    const { root, approve, view, store, app } = await setup();
    await writeFile(join(root, RECIPE_FILE), RECIPE);
    const { hash } = await view();
    expect((await approve(hash, { authorization: "" })).statusCode).toBe(401);
    expect((await approve(hash, { authorization: "", "tailscale-user-login": "kyle@example.com", host: "neo.tailnet.ts.net" })).statusCode).toBe(401);
    expect((await approve(hash, { authorization: "Bearer not-a-session" })).statusCode).toBe(401);
    expect(store.recipeApproved("shop", hash)).toBe(false);
    expect((await app.inject({ method: "POST", url: "/api/lanes/shop/01/tools/approve_recipe", payload: { hash } })).statusCode).toBe(501);
  });

  it("will not approve a recipe that does not parse", async () => {
    const { root, approve, view, store } = await setup();
    await writeFile(join(root, RECIPE_FILE), "{ not json");
    const { hash, error } = await view();
    expect(error).toMatch(/^Not valid JSON/);
    expect((await approve(hash)).statusCode).toBe(409);
    expect(store.recipeApproved("shop", hash)).toBe(false);
  });

  it("shows a waiting lane's recipe in the inbox until it is approved, and logs the approval", async () => {
    const { root, store, approve, view, app } = await setup();
    await writeFile(join(root, RECIPE_FILE), RECIPE);
    const { hash } = await view();
    store.insertLane({ id: "shop/01", n: 1, project: "shop", goal: null, task: "T", agent: "codex", model: null, mode: "ask", branch: "b", worktree: root, terminal: "t", hostUnit: null, base: null, state: "working", colour: "lc1" });
    store.appendEvent("shop/01", { type: "recipe.requested", payload: { hash } });
    expect((await app.inject({ url: "/api/inbox" })).json()).toMatchObject([{ lane: "shop/01", kind: "approval", options: [] }]);
    await approve(hash);
    expect((await app.inject({ url: "/api/inbox" })).json()).toEqual([]);
    expect(store.events("shop/01").at(-1)).toMatchObject({ type: "recipe.approved", payload: { hash } });
  });
});


describe("imported recipes", () => {
  it("proposes Superset commands through the same approval hash and notices changed bytes", async () => {
    const { root, view, approve } = await setup();
    await mkdir(join(root, ".superset"));
    const file = join(root, ".superset/config.json");
    await writeFile(file, JSON.stringify({ setup: ["pnpm install"], run: ["./.superset/run.sh"], teardown: ["node teardown.js"] }));
    const first = await view();
    expect(first).toMatchObject({ importedFrom: "Superset", approved: false, error: null, recipe: { setup: [{ command: ["pnpm", "install"] }], scripts: { teardown: ["node", "teardown.js"] }, services: [{ name: "web", command: ["./.superset/run.sh"] }] } });
    expect((await approve(first.hash)).statusCode).toBe(200);
    expect((await view()).approved).toBe(true);
    await writeFile(file, JSON.stringify({ run: ["node other.js"] }));
    expect((await approve(first.hash)).statusCode).toBe(409);
    await writeFile(join(root, RECIPE_FILE), "{}");
    expect((await view()).importedFrom).toBeUndefined();
  });
  it("imports Conductor TOML and refuses shell evaluation instead of silently changing it", async () => {
    const { root, view, approve } = await setup();
    await mkdir(join(root, ".conductor"));
    await writeFile(join(root, ".conductor/settings.toml"), '[scripts]\nsetup = "pnpm install"\narchive = "./cleanup.sh"\n[scripts.run.dev]\ncommand = "pnpm dev --port $PORT"\ndefault = true\n');
    expect(await view()).toMatchObject({ importedFrom: "Conductor", recipe: { services: [{ command: ["pnpm", "dev", "--port", "$PORT"] }], scripts: { teardown: ["./cleanup.sh"] } } });
    await mkdir(join(root, ".superset"));
    await writeFile(join(root, ".superset/config.json"), JSON.stringify({ setup: ["pnpm install && curl evil"] }));
    const bad = await view();
    expect(bad).toMatchObject({ recipe: null, error: expect.stringContaining("Shell syntax") });
    expect((await approve(bad.hash)).statusCode).toBe(409);
  });
});
