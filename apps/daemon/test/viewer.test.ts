import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer, Config, EventBus, HostLinks, LaneManager, Store, type Runner } from "@contextlanes/daemon";
import { browserMay, browserSettings } from "../src/http/viewer.js";
import { connectTerminal } from "../src/terminal/socket.js";
import { attachArgs } from "../src/terminal/tmux.js";
import { cliToken } from "./signed-in.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function fixture(features: Record<string, boolean> = {}) {
  const root = await mkdtemp("/tmp/cl-viewer-"); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = Config.parse({ features, paths: { data: join(root, "data"), lanes: join(root, "lanes") } });
  const store = Store.open(":memory:"); const bus = new EventBus();
  const run: Runner = async () => ({ stdout: "" });
  const app = buildServer({ store, bus, config, run, hosts: new HostLinks({ store, bus }), lanes: new LaneManager({ store, bus, config, run }), version: "test" });
  cleanups.push(() => app.close());
  const as = (token: string) => (method: string, url: string, payload: unknown = {}) => app.inject({ method: method as "POST", url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });
  return { config, store, browser: as(store.ownerSession()), cli: as(cliToken(config)) };
}

describe("the web app is a viewer", () => {
  it("lets a browser read, and refuses every change to lanes, projects, environments and settings", async () => {
    const { browser } = await fixture();
    expect((await browser("GET", "/api/projects")).statusCode).toBe(200);
    for (const [method, url] of [
      ["POST", "/api/projects"], ["DELETE", "/api/projects/demo"], ["PATCH", "/api/projects/demo"], ["PUT", "/api/projects/order"],
      ["POST", "/api/lanes"], ["PATCH", "/api/lanes/demo/01"], ["POST", "/api/lanes/demo/01/prompt"], ["POST", "/api/lanes/demo/01/restart"],
      ["POST", "/api/lanes/demo/01/discard"], ["POST", "/api/lanes/demo/01/archive"], ["POST", "/api/lanes/demo/01/auto"],
      ["POST", "/api/lanes/demo/01/env/start"], ["POST", "/api/lanes/demo/01/env/stop"],
    ] as const) {
      const reply = await browser(method, url);
      expect(reply.statusCode, `${method} ${url}`).toBe(403);
      expect(reply.json()).toMatchObject({ code: "viewer" });
    }
  });

  it("lets the same owner do those things from the command line", async () => {
    const { cli, store } = await fixture();
    for (const [method, url] of [["POST", "/api/lanes"], ["PUT", "/api/projects/order"]] as const) {
      expect((await cli(method, url)).statusCode, `${method} ${url}`).not.toBe(403);
    }
    expect(store.listProjects()).toEqual([]);
  });

  it("keeps the decisions only the owner can make, and this browser's own sign-in and notifications", () => {
    const { config } = { config: Config.parse({}) };
    for (const write of ["POST /api/answers", "POST /api/projects/:project/recipe/approve", "POST /api/tickets", "POST /api/push/subscriptions", "DELETE /api/push/subscriptions", "POST /api/setup/passkey"]) {
      const [method, route] = write.split(" ") as [string, string];
      expect(browserMay(config, method, route), write).toBe(true);
    }
  });

  it("gives a browser tickets for what it watches, not for the agent sign-in terminal", async () => {
    const { browser, cli } = await fixture();
    expect((await browser("POST", "/api/tickets", { path: "/api/lanes/demo/01/terminal" })).statusCode).toBe(200);
    expect((await browser("POST", "/api/tickets", { path: "/api/setup/agents/claude-code/terminal" })).json()).toMatchObject({ code: "viewer" });
    expect((await cli("POST", "/api/tickets", { path: "/api/setup/agents/claude-code/terminal" })).statusCode).toBe(200);
  });

  it("opens a frozen feature's own actions only when the owner turned the feature on", () => {
    const route = "/api/lanes/:project/:n/approve";
    expect(browserMay(Config.parse({}), "POST", route)).toBe(false);
    expect(browserMay(Config.parse({ features: { review: true } }), "POST", route)).toBe(true);
    expect(browserMay(Config.parse({ features: { review: true } }), "POST", "/api/lanes")).toBe(false);
  });

  it("lets a browser save only the settings of a feature that is on", () => {
    const off = Config.parse({}), helper = Config.parse({ features: { helper: true } });
    expect(browserMay(off, "POST", "/api/setup/settings")).toBe(false);
    expect(browserMay(helper, "POST", "/api/setup/settings")).toBe(true);
    expect(browserSettings(helper, { localModels: [] })).toBe(true);
    expect(browserSettings(helper, { routing: [] })).toBe(false);
    expect(browserSettings(helper, { localModels: [], notifications: {} })).toBe(false);
    expect(browserSettings(helper, { sandbox: { mode: "off" } })).toBe(false);
    expect(browserSettings(helper, {})).toBe(false);
  });

  it("attaches the browser terminal read-only and drops what is typed", () => {
    expect(attachArgs("cl-shop-01", { watch: true })).toEqual(["attach-session", "-r", "-f", "ignore-size", "-t", "=cl-shop-01"]);
    const written: string[] = []; const resized: number[][] = [];
    const handlers: Record<string, (raw: Buffer, binary: boolean) => void> = {};
    const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0, send() {}, close() {}, on(name: string, fn: (raw: Buffer, binary: boolean) => void) { handlers[name] = fn; } };
    const pty = { write: (d: string) => { written.push(d); }, resize: (c: number, r: number) => { resized.push([c, r]); }, kill() {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) };
    connectTerminal(socket as never, pty as never, { input: false });
    handlers.message!(Buffer.from(JSON.stringify({ type: "input", data: "rm -rf ~\r" })), false);
    handlers.message!(Buffer.from(JSON.stringify({ type: "resize", cols: 100, rows: 30 })), false);
    expect(written).toEqual([]);
    expect(resized).toEqual([[100, 30]]);
  });
});
