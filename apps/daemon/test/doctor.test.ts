import { describe, expect, it } from "vitest";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, Previews, type Runner } from "@contextlanes/daemon";
import { doctor, WS_HANDSHAKE, type Net } from "../src/doctor.js";
import { signedIn } from "./signed-in.js";

const run: Runner = async (cmd) => ({ stdout: cmd === "loginctl" ? "yes\n" : "" });
const find = async (name: string) => (name === "codex" ? null : `/usr/bin/${name}`);

async function freePort(): Promise<number> {
  const s = createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const port = (s.address() as { port: number }).port; s.close(); return port;
}

/** A proxy that does its job: the request reaches the router with the browser's Host header. */
function throughRouter(port: number): Pick<Net, "get" | "upgrade"> {
  const hop = (url: string, headers: Record<string, string> = {}) => { const u = new URL(url); return request({ host: "127.0.0.1", port, path: u.pathname, headers: { host: u.hostname, ...headers } }); };
  return {
    get: (url) => new Promise((resolve, reject) => { const r = hop(url); r.on("response", (res) => { let body = ""; res.on("data", (d) => body += d); res.on("end", () => resolve({ status: res.statusCode!, body })); }); r.on("error", reject); r.end(); }),
    upgrade: (url) => new Promise((resolve, reject) => {
      const r = hop(url, WS_HANDSHAKE);
      r.on("upgrade", (res, socket) => { socket.once("data", (d) => { resolve({ status: res.statusCode!, echoed: d.toString() === "ping" }); socket.destroy(); }); socket.write("ping"); });
      r.on("response", (res) => resolve({ status: res.statusCode!, echoed: false })); r.on("error", reject); r.end();
    }),
  };
}

async function setup(previews: Record<string, unknown> = {}, sandbox: "bwrap" | "off" = "bwrap") {
  const root = await mkdtemp(join(tmpdir(), "cl-doctor-"));
  const port = await freePort();
  const config = Config.parse({ previews: { localPort: port, ...previews }, sandbox: { mode: sandbox }, paths: { data: root, lanes: root } });
  const links = new Previews({ config, run });
  await links.start();
  const done = async () => { links.close(); await rm(root, { recursive: true, force: true }); };
  return { config, links, port, done };
}
const check = (r: Awaited<ReturnType<typeof doctor>>, id: string) => r.checks.find((c) => c.id === id);

describe("contextlanes doctor", () => {
  it("reports tools, agents, sandbox and the router, and says what to do without a domain", async () => {
    const { config, links, done } = await setup({}, "off");
    const r = await doctor({ config, run, version: "test", previews: links, find });
    expect(r).toMatchObject({ version: "test", supervisor: "systemd", sandbox: "off", previews: { mode: "router", domain: null } });
    expect(check(r, "git")).toMatchObject({ state: "ok" });
    expect(check(r, "agents")).toMatchObject({ state: "ok", found: "claude" });
    expect(check(r, "sandbox")).toMatchObject({ state: "warn" });
    expect(check(r, "router")).toMatchObject({ state: "ok" });
    expect(check(r, "domain")).toMatchObject({ state: "warn", fix: expect.stringContaining("docs/PROXY.md") });
    expect(JSON.stringify(r)).not.toMatch(/token|secret/i);
    await done();
  });

  it("says when nothing answers on the router port", async () => {
    const { config, links, done } = await setup();
    links.close();
    const r = await doctor({ config, run, version: "test", previews: links, find: async () => null });
    expect(check(r, "router")).toMatchObject({ state: "fail" });
    expect(check(r, "git")).toMatchObject({ state: "fail", fix: expect.stringContaining("Install git") });
    expect(check(r, "agents")).toMatchObject({ state: "warn" });
    await done();
  });

  it("follows the whole path through the proxy, and checks WebSockets", async () => {
    const { config, links, port, done } = await setup({ domain: "root.example.dev" });
    const r = await doctor({ config, run, version: "test", previews: links, find, net: { resolve: async () => ["192.0.2.7"], ...throughRouter(port) } });
    expect(check(r, "chain")).toMatchObject({ state: "ok", found: expect.stringContaining("192.0.2.7") });
    expect(check(r, "websocket")).toMatchObject({ state: "ok" });
    // The temporary route is gone afterwards.
    expect(links.routed({ id: "x/1" }, "x")).toBe(false);
    await done();
  });

  it("names the hop that fails", async () => {
    const { config, links, port, done } = await setup({ domain: "root.example.dev" });
    const base = { resolve: async () => ["192.0.2.7"], ...throughRouter(port) };
    const chain = async (net: Partial<Net>) => check(await doctor({ config, run, version: "test", previews: links, find, net: { ...base, ...net } }), "chain")!;
    expect(await chain({ resolve: async () => [] })).toMatchObject({ state: "fail", found: expect.stringContaining("does not resolve"), fix: expect.stringContaining("*.root.example.dev") });
    expect(await chain({ get: async () => { throw new Error("self-signed certificate"); } })).toMatchObject({ state: "fail", found: expect.stringContaining("TLS failed") });
    expect(await chain({ get: async () => { throw new Error("connect ECONNREFUSED 192.0.2.7:443"); } })).toMatchObject({ state: "fail", found: expect.stringContaining("did not answer") });
    expect(await chain({ get: async () => ({ status: 502, body: "<html>Bad Gateway</html>" }) })).toMatchObject({ state: "fail", found: expect.stringContaining("something other than the router"), fix: expect.stringContaining(`port ${port}`) });
    expect(await chain({ get: async () => throughRouter(port).get("https://renamed.root.example.dev/") })).toMatchObject({ state: "fail", fix: expect.stringContaining("Host header") });
    const ws = check(await doctor({ config, run, version: "test", previews: links, find, net: { ...base, upgrade: async () => ({ status: 400, echoed: false }) } }), "websocket");
    expect(ws).toMatchObject({ state: "warn", fix: expect.stringContaining("WebSocket") });
    await done();
  });

  it("is served to the owner as /api/doctor", async () => {
    const { buildServer, EventBus, HostLinks, LaneManager, Store } = await import("@contextlanes/daemon");
    const { config, done } = await setup({}, "off");
    const store = Store.open(":memory:"); const bus = new EventBus();
    const app = signedIn(buildServer({ store, bus, lanes: new LaneManager({ store, bus, config, run }), hosts: new HostLinks({ store, bus }), config, version: "test", run }), store, config);
    const res = await app.inject("/api/doctor");
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(["node", "git", "tmux", "python3", "agents", "supervisor", "sandbox", "router"]));
    expect((await app.inject({ url: "/api/doctor", headers: { authorization: "" } })).statusCode).toBe(401);
    await app.close(); store.close(); await done();
  });
});
