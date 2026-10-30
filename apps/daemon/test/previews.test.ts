import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RECIPE_FILE } from "@contextlanes/protocol";
import { Config, EventBus, previewLabel, Previews, Runtime, Store, type Runner } from "@contextlanes/daemon";
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
const previews = (run: Runner, previews: unknown = {}, fetcher?: typeof fetch) => new Previews({ config: Config.parse({ previews }), run, fetch: fetcher });

describe("previews", () => {
  it("names a label from the lane and service", () => {
    expect(previewLabel(LANE, "web")).toBe("web-shop-01");
    expect(previewLabel({ id: `${"x".repeat(62)}/01` }, "web").length).toBeLessThanOrEqual(63);
  });

  it("serves each service on its own HTTPS port and leaves other routes alone", async () => {
    const { run, calls } = fake({ TCP: { 4700: { HTTPS: true } } });
    expect(await previews(run).publish(LANE, "web", 20100)).toBe("https://neo.tail1.ts.net:4701");
    expect(calls).toContain("tailscale serve --bg --https=4701 --yes http://127.0.0.1:20100");
    expect(calls.join("\n")).not.toMatch(/funnel|reset/);
  });

  it("reuses a route that already points at the service", async () => {
    const { run, calls } = fake({ TCP: { 4705: {} }, Web: { "neo.tail1.ts.net:4705": { Handlers: { "/": { Proxy: "http://127.0.0.1:20100" } } } } });
    expect(await previews(run).publish(LANE, "web", 20100)).toBe("https://neo.tail1.ts.net:4705");
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
    const p = previews(run);
    expect(await Promise.all([p.publish(LANE, "api", 1), p.publish(LANE, "web", 2)])).toEqual(["https://neo.tail1.ts.net:4700", "https://neo.tail1.ts.net:4701"]);
  });

  it("says when the port range is full, and removes only its own port", async () => {
    await expect(previews(fake({ TCP: { 4700: {} } }).run, { ports: { from: 4700, to: 4700 } }).publish(LANE, "web", 1)).rejects.toThrow(/preview port from 4700 to 4700/);
    const { run, calls } = fake();
    await previews(run).unpublish("https://neo.tail1.ts.net:4701");
    expect(calls).toEqual(["tailscale serve --https=4701 off"]);
  });

  it("publishes a named Tailscale Service behind config", async () => {
    const { run, calls } = fake();
    const p = previews(run, { mode: "services" });
    const url = await p.publish(LANE, "web", 20100);
    expect(url).toBe("https://web-shop-01.tail1.ts.net");
    expect(calls).toContain("tailscale serve --service=svc:web-shop-01 --https=443 --yes http://127.0.0.1:20100");
    await p.unpublish(url);
    expect(calls.at(-1)).toBe("tailscale serve clear svc:web-shop-01");
  });

  it("adds a subdomain route through Caddy's loopback admin API, never a path", async () => {
    const requests: { url: string; method?: string; body?: string }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => { requests.push({ url, method: init?.method, body: init?.body as string }); return new Response("{}"); }) as typeof fetch;
    const p = previews(fake().run, { mode: "caddy", caddy: { domain: "root.example.dev" } }, fetcher);
    const url = await p.publish(LANE, "web", 20100);
    expect(url).toBe("https://web-shop-01.root.example.dev");
    const route = JSON.parse(requests[1]!.body!);
    expect(route.match).toEqual([{ host: ["web-shop-01.root.example.dev"] }]);
    expect(route.handle[0].upstreams).toEqual([{ dial: "127.0.0.1:20100" }]);
    await p.unpublish(url);
    expect(requests.at(-1)).toMatchObject({ url: "http://127.0.0.1:2019/id/cl-web-shop-01", method: "DELETE" });
  });

  it("refuses a Caddy admin API off loopback and caddy mode without settings", () => {
    expect(() => Config.parse({ previews: { mode: "caddy", caddy: { domain: "x.dev", admin: "http://10.0.0.1:2019" } } })).toThrow();
    expect(() => Config.parse({ previews: { mode: "caddy" } })).toThrow();
  });
});

describe("previews in the runtime", () => {
  async function setup(fail = false) {
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
    const runtime = new Runtime({ store, bus: new EventBus(), config: Config.parse({ paths: { data: root, lanes: root } }), run, freePort: async () => 20100, fetch: (async () => new Response("ok")) as typeof fetch });
    store.addProject({ id: "shop", name: "Shop", path: root });
    store.insertLane({ id: "shop/01", n: 1, project: "shop", goal: null, task: "T", agent: "codex", model: null, mode: "ask", branch: "b", worktree: root, terminal: "t", hostUnit: null, state: "working", colour: "lc1" });
    await writeFile(join(root, RECIPE_FILE), JSON.stringify({ services: [{ name: "web", command: ["node"] }] }));
    store.approveRecipe("shop", (await readRecipe(store, store.getProject("shop")!, root))!.hash);
    return { root, store, runtime, inner };
  }

  it("gives a healthy service its link, tells preview_url, and removes the link on stop", async () => {
    const { root, store, runtime, inner } = await setup();
    const env = await runtime.start("shop/01");
    expect(env.services[0]).toMatchObject({ state: "healthy", url: "https://neo.tail1.ts.net:4700" });
    expect(runtime.previewUrl("shop/01", "web").url).toBe("https://neo.tail1.ts.net:4700");
    expect(store.events("shop/01").findLast((e) => e.type === "env.status")).toMatchObject({ payload: { url: "https://neo.tail1.ts.net:4700" } });
    await runtime.stop("shop/01");
    expect(inner.calls).toContain("tailscale serve --https=4700 off");
    expect(store.environment("shop/01")!.services[0]!.url).toBeNull();
    expect(() => runtime.previewUrl("shop/01", "web")).toThrow(/no link yet/);
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the app running and says why when the link fails", async () => {
    const { root, runtime } = await setup(true);
    const env = await runtime.start("shop/01");
    expect(env.services[0]).toMatchObject({ state: "healthy", url: null });
    expect(env.error).toMatch(/^Preview link for web failed/);
    await rm(root, { recursive: true, force: true });
  });
});
