import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURE_NAMES } from "@contextlanes/protocol";
import { buildServer, Config, EventBus, HostLinks, LaneManager, Store, type Runner } from "@contextlanes/daemon";
import { Judge } from "../src/judge.js";
import { Nudges } from "../src/nudges.js";
import { toolsHint } from "../src/lanes/manager.js";
import { laneTools, routeFeature } from "../src/features.js";
import { signedIn } from "./signed-in.js";
import { ALL_FEATURES } from "./features.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

async function fixture(features: Record<string, boolean> = {}) {
  const root = await mkdtemp(join(tmpdir(), "cl-features-")); roots.push(root);
  const config = Config.parse({ features, paths: { data: root, lanes: join(root, "lanes") }, lanes: { launchHosts: false } });
  const run: Runner = async (_cmd, args) => ({ stdout: args[0] === "symbolic-ref" ? "main\n" : "" });
  const store = Store.open(":memory:"); const bus = new EventBus();
  const routes: string[] = [];
  const app = signedIn(buildServer({ store, bus, lanes: new LaneManager({ store, bus, config, run }), hosts: new HostLinks({ store, bus }), config, version: "test", run, onRoute: (r) => routes.push(r.url) }), store);
  await app.ready();
  store.addProject({ id: "shop", name: "Shop", path: root });
  return { app, store, config, routes };
}

describe("features outside the core", () => {
  it("are all off by default, and the web app can ask which are on", async () => {
    const { app, config } = await fixture();
    expect(Object.values(config.features).every((on) => !on)).toBe(true);
    expect(Object.keys(config.features).sort()).toEqual([...FEATURE_NAMES].sort());
    expect((await app.inject("/api/features")).json()).toEqual(config.features);
  });

  it("refuse every route of a feature that is off, naming the setting", async () => {
    const { app, routes } = await fixture();
    const gated = [...new Set(routes)].filter((r) => routeFeature(r));
    expect(gated.length).toBeGreaterThan(25);
    for (const route of gated) {
      const url = route.replace(":project", "shop").replace(":n", "01").replace(":id", "00000000-0000-4000-8000-000000000000").replace(":file", "1-after.png");
      for (const method of ["GET", "POST"] as const) {
        const res = await app.inject({ method, url, ...(method === "POST" ? { payload: {} } : {}) });
        if (res.statusCode === 404 && res.json().code === "feature_off") expect(res.json().error).toContain(`[features] ${routeFeature(route)} = true`);
        else expect([method, route, res.statusCode]).toEqual([method, route, 404]);
      }
    }
  });

  it("keep the core routes", async () => {
    for (const route of ["/api/lanes/:project/:n/env/start", "/api/lanes/:project/:n/cleanup", "/api/lanes/:project/:n/discard", "/api/projects/:project/recipe/approve", "/api/projects/:project/notes", "/api/projects/:project/skills", "/api/inbox", "/api/answers", "/api/usage", "/api/setup/agents"]) {
      expect([route, routeFeature(route)]).toEqual([route, null]);
    }
  });

  it("refuse ACP lanes until acp is on", async () => {
    const off = await fixture();
    const res = await off.app.inject({ method: "POST", url: "/api/lanes", payload: { project: "shop", task: "x", agent: "opencode" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "feature_off" });
    const on = await fixture({ acp: true });
    expect((await on.app.inject({ method: "POST", url: "/api/lanes", payload: { project: "shop", task: "x", agent: "opencode" } })).statusCode).toBe(201);
  });

  it("offer agents only core tools, and refuse the others", async () => {
    const { app, store } = await fixture();
    const lane = (await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "shop", task: "x", kind: "shell" } })).json();
    const headers = { authorization: `Bearer ${store.mintLaneToken(lane.id)}` };
    expect((await app.inject({ url: `/api/lanes/${lane.id}/tools`, headers })).json().tools).toEqual(["ask_owner", "env_status", "env_start", "env_stop", "env_restart", "recipe_status", "get_logs", "preview_url"]);
    for (const tool of ["checkpoint", "get_brief", "split_lanes", "lanes_list", "delegate"]) {
      const res = await app.inject({ method: "POST", url: `/api/lanes/${lane.id}/tools/${tool}`, headers, payload: {} });
      expect([tool, res.statusCode, res.json().code]).toEqual([tool, 404, "feature_off"]);
    }
    expect(laneTools(Config.parse({ features: ALL_FEATURES }))).toContain("checkpoint");
  });

  it("start no judge and no nudges while their features are off", async () => {
    const judge = vi.spyOn(Judge.prototype, "start");
    const nudges = vi.spyOn(Nudges.prototype, "start");
    await fixture();
    expect(judge).not.toHaveBeenCalled();
    expect(nudges).not.toHaveBeenCalled();
    await fixture({ review: true, insights: true });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(nudges).toHaveBeenCalledTimes(1);
  });

  it("tell ACP agents only about tools that are on", () => {
    const core = toolsHint(Config.parse({}));
    expect(core).toContain("ask_owner");
    expect(core).toContain("env_start");
    for (const name of ["get_brief", "checkpoint", "split_lanes", "delegate"]) expect(core).not.toContain(name);
    const all = toolsHint(Config.parse({ features: ALL_FEATURES, localModels: [{ name: "q", provider: "ollama", url: "http://127.0.0.1:11434" }] }));
    for (const name of ["get_brief", "checkpoint", "split_lanes", "delegate"]) expect(all).toContain(name);
  });
});
