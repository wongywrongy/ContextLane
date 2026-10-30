import { signedIn } from "./signed-in.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const app = signedIn(buildServer({ store, bus, lanes: new LaneManager({ store, bus, config, run }), hosts: new HostLinks({ store, bus }), config, version: "test", run }), store);
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
