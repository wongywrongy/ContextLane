import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RECIPE_FILE } from "@contextlanes/protocol";
import { Config, EventBus, previewLabel, Previews, Runtime, Store, type Runner } from "@contextlanes/daemon";
import { appHostnames, appOrigin, routerUrl } from "../src/previews.js";
import { readRecipe } from "../src/recipes.js";

const LANE = { id: "shop/01" };
const STATUS = JSON.stringify({ BackendState: "Running", MagicDNSSuffix: "tail1.ts.net.", Self: { DNSName: "neo.tail1.ts.net." } });

function fake(serving: unknown = {}, fail = false) {
  const calls: string[] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (args[0] === "status") return { stdout: STATUS };
    if (args[1] === "status") return { stdout: JSON.stringify(serving) };
    if (fail) throw new Error("serve refused");
    return { stdout: "" };
  };
  return { run, calls };
}
const serve = (run: Runner, previews: unknown = {}) => new Previews({ config: Config.parse({ previews: { mode: "serve", ...(previews as object) } }), run });

describe("preview labels", () => {
  it("puts the lane number before the project", () => {
    expect(previewLabel(LANE, "web")).toBe("web-01-shop");
    expect(previewLabel({ id: "My_Shop/12" }, "API")).toBe("api-12-my-shop");
  });

  it("never loses the lane number to truncation, and stays a valid DNS label", () => {
    const project = "p".repeat(70);
    const a = previewLabel({ id: `${project}/01` }, "web");
    const b = previewLabel({ id: `${project}/02` }, "web");
    expect(a).not.toBe(b);
    for (const label of [a, b]) {
      expect(label.length).toBeLessThanOrEqual(63);
      expect(label).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    }
    expect(a.startsWith("web-01-")).toBe(true);
  });

  it("differs for long projects that share a prefix", () => {
    const a = previewLabel({ id: `${"x".repeat(60)}aaa/01` }, "web");
    const b = previewLabel({ id: `${"x".repeat(60)}bbb/01` }, "web");
    expect(a).not.toBe(b);
  });
});

describe("router addresses", () => {
  it("uses <label>.localhost on the router port without a domain", () => {
    const config = Config.parse({});
    expect(config.previews).toMatchObject({ mode: "router", localPort: 4601, bind: "127.0.0.1", appLabel: "lanes" });
    expect(routerUrl(config, "web-01-shop")).toBe("http://web-01-shop.localhost:4601");
    expect(appOrigin(config)).toBeNull();
    expect(appHostnames(config)).toEqual(["lanes.localhost"]);
    expect(new Previews({ config, run: fake().run }).urlFor(LANE, "web")).toBe("http://web-01-shop.localhost:4601");
  });

  it("uses https://<label>.<domain> with a domain, and names the app", () => {
    const config = Config.parse({ previews: { domain: "root.example.dev" } });
    expect(new Previews({ config, run: fake().run }).urlFor(LANE, "web")).toBe("https://web-01-shop.root.example.dev");
    expect(appOrigin(config)).toBe("https://lanes.root.example.dev");
    expect(appHostnames(config)).toEqual(["lanes.root.example.dev", "lanes.localhost"]);
    expect(routerUrl(Config.parse({ previews: { domain: "lan.test", scheme: "http" } }), "x")).toBe("http://x.lan.test");
  });

  it("refuses bad domains and bind addresses", () => {
    for (const domain of ["Root.example.dev", "*.example.dev", "example", "https://x.dev", "a..b"]) expect(() => Config.parse({ previews: { domain } })).toThrow();
    expect(() => Config.parse({ previews: { bind: "all" } })).toThrow();
    expect(Config.parse({ previews: { bind: "172.17.0.1" } }).previews.bind).toBe("172.17.0.1");
  });

  it("reads configs from earlier releases", () => {
    expect(Config.parse({ previews: { mode: "local", localPort: 4700 } }).previews).toMatchObject({ mode: "router", localPort: 4700 });
    expect(Config.parse({ previews: { mode: "caddy", caddy: { domain: "root.example.dev", server: "srv0" } } }).previews).toMatchObject({ mode: "router", domain: "root.example.dev" });
    expect(Config.parse({ previews: { mode: "services" } }).previews.mode).toBe("router");
    expect(Config.parse({ previews: { mode: "serve" } }).previews.mode).toBe("serve");
  });
});

describe("serve mode", () => {
  it("serves each service on its own HTTPS port and leaves other routes alone", async () => {
    const { run, calls } = fake({ TCP: { 4700: { HTTPS: true } } });
    const p = serve(run);
    expect(p.urlFor(LANE, "web")).toBeNull();
    expect(await p.publish(LANE, "web", 20100)).toBe("https://neo.tail1.ts.net:4701");
    expect(calls).toContain("tailscale serve --bg --https=4701 --yes http://127.0.0.1:20100");
    expect(calls.join("\n")).not.toMatch(/funnel|reset/);
  });

  it("reuses a route that already points at the service", async () => {
    const { run, calls } = fake({ TCP: { 4705: {} }, Web: { "neo.tail1.ts.net:4705": { Handlers: { "/": { Proxy: "http://127.0.0.1:20100" } } } } });
    expect(await serve(run).publish(LANE, "web", 20100)).toBe("https://neo.tail1.ts.net:4705");
    expect(calls.filter((c) => c.includes("--bg"))).toEqual([]);
  });

  it("takes ports one at a time so two services cannot race for the same one", async () => {
    const taken: Record<string, unknown> = {};
    const run: Runner = async (_cmd, args) => {
      if (args[0] === "status") return { stdout: STATUS };
      if (args[1] === "status") return { stdout: JSON.stringify({ TCP: taken }) };
      taken[args[2]!.slice("--https=".length)] = {};
      return { stdout: "" };
    };
    const p = serve(run);
    expect(await Promise.all([p.publish(LANE, "api", 1), p.publish(LANE, "web", 2)])).toEqual(["https://neo.tail1.ts.net:4700", "https://neo.tail1.ts.net:4701"]);
  });

  it("says when the port range is full, and removes only its own port", async () => {
    await expect(serve(fake({ TCP: { 4700: {} } }).run, { ports: { from: 4700, to: 4700 } }).publish(LANE, "web", 1)).rejects.toThrow(/preview port from 4700 to 4700/);
    const { run, calls } = fake();
    await serve(run).unpublish("https://neo.tail1.ts.net:4701");
    expect(calls).toEqual(["tailscale serve --https=4701 off"]);
  });
});

describe("previews in the runtime", () => {
  async function setup(previews: Record<string, unknown>, fail = false) {
    const root = await mkdtemp(join(tmpdir(), "cl-previews-"));
    const calls: string[] = [];
    const inner = fake({}, fail);
    const run: Runner = async (cmd, args, opts) => {
      if (cmd === "tailscale") return inner.run(cmd, args, opts);
      calls.push([cmd, ...args].join(" "));
      if (cmd === "git") return { stdout: "" };
      if (cmd === "systemctl" && args[1] === "show") return { stdout: "ActiveState=active\nControlGroup=/x\n" };
      return { stdout: "" };
    };
    const store = Store.open(":memory:");
    const config = Config.parse({ previews: { localPort: 0, ...previews }, paths: { data: root, lanes: root } });
    const runtime = new Runtime({ store, bus: new EventBus(), config, run, freePort: async () => 20100, fetch: (async () => new Response("ok")) as typeof fetch });
    store.addProject({ id: "shop", name: "Shop", path: root });
    store.insertLane({ id: "shop/01", n: 1, project: "shop", goal: null, task: "T", agent: "codex", model: null, mode: "ask", branch: "b", worktree: root, terminal: "t", hostUnit: null, base: null, state: "working", colour: "lc1" });
    await writeFile(join(root, RECIPE_FILE), JSON.stringify({ services: [{ name: "web", command: ["node"] }] }));
    store.approveRecipe("shop", (await readRecipe(store, store.getProject("shop")!, root))!.hash);
    const done = async () => { runtime.close(); await rm(root, { recursive: true, force: true }); };
    return { store, runtime, inner, config, done };
  }

  it("knows a router link before the service is healthy, and routes it once it is", async () => {
    const { store, runtime, done } = await setup({ domain: "root.example.dev" });
    const env = await runtime.start("shop/01");
    expect(env.services[0]).toMatchObject({ state: "healthy", url: "https://web-01-shop.root.example.dev" });
    expect(runtime.links.routed({ id: "shop/01" }, "web")).toBe(true);
    expect(runtime.previewUrl("shop/01", "web").url).toBe("https://web-01-shop.root.example.dev");
    const starting = store.events("shop/01").find((e) => e.type === "env.status" && (e.payload as { state?: string }).state === "starting");
    expect(starting).toBeDefined();
    await runtime.stop("shop/01");
    expect(runtime.links.routed({ id: "shop/01" }, "web")).toBe(false);
    expect(store.environment("shop/01")!.services[0]!.url).toBeNull();
    expect(() => runtime.previewUrl("shop/01", "web")).toThrow(/no working link yet \(it is stopped\)/);
    await done();
  });

  it("rebuilds routes for healthy services after a restart, before any probe", async () => {
    const first = await setup({});
    await first.runtime.start("shop/01");
    first.runtime.close();
    const again = new Runtime({ store: first.store, bus: new EventBus(), config: first.config, run: async () => ({ stdout: "" }) });
    expect(again.links.routed({ id: "shop/01" }, "web")).toBe(false);
    expect(await again.restoreLinks()).toBe(1);
    expect(again.links.routed({ id: "shop/01" }, "web")).toBe(true);
    again.close();
    await first.done();
  });

  it("gives a healthy service a Serve link and removes it on stop", async () => {
    const { store, runtime, inner, done } = await setup({ mode: "serve" });
    const env = await runtime.start("shop/01");
    expect(env.services[0]).toMatchObject({ state: "healthy", url: "https://neo.tail1.ts.net:4700" });
    expect(runtime.previewUrl("shop/01", "web").url).toBe("https://neo.tail1.ts.net:4700");
    expect(store.events("shop/01").findLast((e) => e.type === "env.status")).toMatchObject({ payload: { url: "https://neo.tail1.ts.net:4700" } });
    await runtime.stop("shop/01");
    expect(inner.calls).toContain("tailscale serve --https=4700 off");
    expect(() => runtime.previewUrl("shop/01", "web")).toThrow(/no working link yet/);
    await done();
  });

  it("keeps the app running and says why when a Serve link fails", async () => {
    const { runtime, done } = await setup({ mode: "serve" }, true);
    const env = await runtime.start("shop/01");
    expect(env.services[0]).toMatchObject({ state: "healthy", url: null });
    expect(env.error).toMatch(/^Preview link for web failed/);
    await done();
  });
});
