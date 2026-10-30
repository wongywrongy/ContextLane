import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, EventBus, HostLinks, LaneManager, Store, buildServer, type Runner } from "@contextlanes/daemon";
import { loadConfig } from "../src/config.js";
import { SetupManager } from "../src/setup.js";
import { installService } from "../src/install.js";
import { serveWeb } from "../src/http/static.js";
import Fastify from "fastify";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cl-setup-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const calls: { cmd: string; args: string[] }[] = [];
  const run = vi.fn<Runner>(async (cmd, args) => { calls.push({ cmd, args }); return { stdout: cmd === "git" ? "/fixture/repo\n" : "" }; });
  const config = Config.parse({ paths: { data: root, lanes: join(root, "lanes") } });
  const store = Store.open(":memory:"); cleanups.push(() => store.close());
  const bus = new EventBus(); const hosts = new HostLinks({ store, bus }); const lanes = new LaneManager({ store, bus, config, run });
  const path = join(root, "config.toml");
  const changed = vi.fn(async () => {});
  const find = vi.fn(async (name: string) => `/fixture/bin/${name}`);
  const http = vi.fn<typeof fetch>(async () => new Response("{}"));
  const setup = new SetupManager(config, store, run, { path, changed, find, fetch: http }); await setup.initialize();
  const app = buildServer({ config, store, bus, hosts, lanes, setup, run, version: "test" }); cleanups.push(() => app.close());
  const code = await readFile(setup.claimFile, "utf8");
  const claim = () => app.inject({ method: "POST", url: "/api/setup/claim/tailnet", headers: { host: "neo.test.ts.net", origin: "https://neo.test.ts.net", "tailscale-user-login": "kyle@example.com" }, payload: { code } });
  return { root, path, config, store, app, setup, code, claim, run, calls, changed, find, http, bus };
}

describe("setup and owner claim", () => {
  it("requires a private code before APIs, claims only once, and persists a private config", async () => {
    const f = await fixture();
    expect((await stat(f.setup.claimFile)).mode & 0o777).toBe(0o600);
    expect((await f.app.inject("/api/projects")).statusCode).toBe(401);
    expect((await f.app.inject("/api/health")).statusCode).toBe(200);
    expect((await f.app.inject("/api/setup/status")).body).not.toContain(f.code);
    expect((await f.app.inject({ method: "POST", url: "/api/setup/claim/tailnet", headers: { "tailscale-user-login": "kyle@example.com", host: "localhost" }, payload: { code: "wrong-code-long-enough" } })).statusCode).toBe(403);
    const claimed = await f.claim();
    expect(claimed.statusCode).toBe(200); expect(claimed.headers["set-cookie"]).toContain("HttpOnly; SameSite=Strict");
    expect(claimed.headers["set-cookie"]).toContain("Secure");
    expect(loadConfig(f.path).access.owner).toBe("kyle@example.com");
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    await expect(readFile(f.setup.claimFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.claim()).statusCode).toBe(409);
    expect((await f.app.inject({ url: "/api/projects", headers: { "tailscale-user-login": "other@example.com" } })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "POST", url: "/api/projects", headers: { host: "localhost", origin: "https://evil.example" }, payload: { path: "/fixture/repo" } })).statusCode).toBe(403);
    f.config.access.allowLocal = false;
    expect((await f.app.inject("/api/projects")).statusCode).toBe(401);
    const cookie = String(claimed.headers["set-cookie"]).split(";")[0]!;
    expect((await f.app.inject({ url: "/api/projects", headers: { cookie } })).statusCode).toBe(200);
    expect((await f.app.inject({ url: "/api/projects", headers: { cookie: "cl-owner=invented" } })).statusCode).toBe(401);
    f.config.access.allowLocal = true;
    expect((await f.app.inject({ url: "/api/setup/settings", headers: { host: "rebind.example" } })).statusCode).toBe(401);
  });
  it("binds passkey challenges to origin, consumes them on failure and refuses 127.0.0.1 registration", async () => {
    const f = await fixture();
    await expect(f.setup.registration({ code: f.code }, "http://127.0.0.1:4600")).rejects.toThrow("Passkeys need");
    const challenge = await f.setup.registration({ code: f.code }, "http://localhost:4600");
    expect(challenge.options.authenticatorSelection?.userVerification).toBe("required");
    const body = { code: f.code, challengeId: challenge.challengeId, response: { id: "abc", rawId: "abc", type: "public-key", response: { clientDataJSON: "abc", attestationObject: "abc" }, clientExtensionResults: {} } };
    await expect(f.setup.register(body, "http://localhost:4601")).rejects.toThrow("another origin");
    await expect(f.setup.register(body, "http://localhost:4600")).rejects.toThrow("expired");
    expect(f.setup.claimed).toBe(false); expect(await readFile(f.setup.claimFile, "utf8")).toBe(f.code);
    f.config.access.passkey = { id: "abc", publicKey: "abc", counter: 0, rpId: "localhost" };
    f.config.access.allowLocal = false;
    expect(f.setup.authorized("invented@example.com", undefined)).toBe(false);
    f.config.access.passkey.counter = 3;
    await expect(f.setup.update({ access: { ...f.config.access, passkey: { ...f.config.access.passkey, counter: 2 } } })).rejects.toThrow("counter moved backwards");
    await expect(f.setup.authentication("https://elsewhere.example")).rejects.toThrow("registered");
  });
  it("serializes config writes, retains old values on validation failure, and reloads projects once", async () => {
    const f = await fixture(); await f.claim();
    await f.setup.settings({ lanes: { maxConcurrent: 3, launchHosts: true } });
    const before = await readFile(f.path, "utf8");
    for (const flag of ["--dangerously-skip-permissions", "--auto", "--full-auto"]) await expect(f.setup.settings({ agents: { claude: { command: "cli", args: [flag] } } })).rejects.toThrow();
    expect(await readFile(f.path, "utf8")).toBe(before);
    expect(f.config.lanes.maxConcurrent).toBe(3); expect(f.config.lanes.host.command).toBe(process.execPath);
    await expect(f.setup.addProject({ path: "relative" })).rejects.toThrow("absolute");
    await f.setup.addProject({ path: "/fixture/repo", name: "Example" });
    await f.setup.addProject({ path: "/fixture/repo", name: "Example" });
    await f.setup.initialize();
    expect(f.store.listProjects()).toHaveLength(1); expect(loadConfig(f.path).projects).toHaveLength(1);
    expect(f.calls.some((c) => c.cmd === "git" && c.args.join(" ") === "rev-parse --show-toplevel")).toBe(true);
    expect(f.changed).toHaveBeenCalled();
    const reloaded = new SetupManager(loadConfig(f.path), f.store, f.run, { path: f.path }); await reloaded.initialize();
    expect(reloaded.claimed).toBe(true);
    f.run.mockRejectedValueOnce(new Error("not a git repository"));
    await expect(f.setup.addProject({ path: "/other/repo" })).rejects.toThrow("not a git");
    expect(loadConfig(f.path).projects).toHaveLength(1);
  });
  it("detects logins without returning auth output and installs only pinned adapters through Runner", async () => {
    const f = await fixture();
    f.run.mockImplementation(async (cmd) => ({ stdout: cmd.endsWith("claude") ? '{"loggedIn":true,"token":"never-return-this"}' : "" }));
    const detected = await f.setup.detectAgents();
    expect(detected.find((a) => a.id === "claude-code")?.login).toBe("ready");
    expect(detected.find((a) => a.id === "codex")?.login).toBe("ready");
    expect(detected.find((a) => a.id === "opencode")?.login).toBe("unknown");
    expect(JSON.stringify(detected)).not.toContain("never-return-this");
    await f.setup.installAgent({ id: "codex" });
    expect(f.run).toHaveBeenCalledWith("npm", ["install", "--global", "--prefix", expect.stringMatching(/\.local$/), "@agentclientprotocol/codex-acp@2.5.0"], { timeout: 180000 });
    expect(loadConfig(f.path).agents.codex?.command).toMatch(/codex-acp$/);
    await expect(f.setup.installAgent({ id: "invented" })).rejects.toThrow();
  });
  it("preserves occupied Tailscale routes and links only the node owner", async () => {
    const f = await fixture(); await f.claim();
    f.run.mockImplementation(async (_cmd, args) => ({ stdout: args[0] === "status" ? JSON.stringify({ BackendState: "Running", Self: { DNSName: "neo.test.ts.net.", UserID: 12 }, User: { "12": { LoginName: "kyle@example.com" } } }) : args[1] === "status" ? '{"TCP":{"443":{}}}' : "" }));
    expect(await f.setup.enableTailnet()).toEqual({ publicUrl: "https://neo.test.ts.net:8443" });
    expect(f.run).toHaveBeenCalledWith("tailscale", ["serve", "--bg", "--https=8443", "--yes", "http://127.0.0.1:4600"], { timeout: 30000 });
    expect(loadConfig(f.path).notifications.publicUrl).toBe("https://neo.test.ts.net:8443");
    f.run.mockImplementation(async (_cmd, args) => ({ stdout: args[0] === "status" ? JSON.stringify({ BackendState: "Running", Self: { DNSName: "neo.test.ts.net.", UserID: 12 }, User: { "12": { LoginName: "kyle@example.com" } } }) : '{"TCP":{"443":{},"8443":{}}}' }));
    await expect(f.setup.enableTailnet()).rejects.toThrow("already in use");
    f.config.access.owner = "another@example.com";
    await expect(f.setup.enableTailnet()).rejects.toThrow("different owner");
    expect(f.run.mock.calls.some(([, args]) => args.includes("reset"))).toBe(false);
  });
  it("keeps generated push keys, validates local-only model endpoints, and rejects redirects", async () => {
    const f = await fixture(); await f.claim();
    const keys = await f.setup.generatePush(); expect(await f.setup.generatePush()).toEqual(keys);
    expect(loadConfig(f.path).notifications.webPush?.publicKey).toBe(keys.publicKey);
    const model = { name: "local", provider: "ollama", url: "http://127.0.0.1:11434" };
    await f.setup.probeModel(model);
    expect(f.http).toHaveBeenCalledWith(new URL("http://127.0.0.1:11434/api/tags"), expect.objectContaining({ redirect: "error" }));
    await expect(f.setup.probeModel({ ...model, url: "http://external.example" })).rejects.toThrow();
    await f.setup.settings({ localModels: [model] }); expect(loadConfig(f.path).localModels).toHaveLength(1);
    f.http.mockResolvedValue(new Response("", { status: 503 })); await expect(f.setup.probeModel(model)).rejects.toThrow("503");
  });
  it("ends live event streams before closing the daemon", async () => {
    const f = await fixture(); await f.claim();
    const subscribe = vi.spyOn(f.bus, "subscribeAll");
    const response = f.app.inject({ url: "/api/stream" }).then((r) => r);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled());
    await f.app.close();
    expect((await response).body).toContain("retry: 2000");
  });
  it("serves the built app for SPA routes, never unknown API routes or path traversal", async () => {
    const f = await fixture(); await writeFile(join(f.root, "index.html"), "<h1>Setup</h1>"); await writeFile(join(f.root, "sw.js"), "// push");
    const app = Fastify(); serveWeb(app, f.root); cleanups.push(() => app.close());
    expect((await app.inject("/setup")).body).toContain("Setup");
    expect((await app.inject("/sw.js")).headers["cache-control"]).toBe("no-cache");
    expect((await app.inject("/api/invented")).statusCode).toBe(404);
    expect((await app.inject("/%2e%2e%2fsecret.txt")).statusCode).toBe(403);
    expect((await app.inject("/missing.js")).statusCode).toBe(404);
  });
});

it("installs an absolute user service and wrappers through Runner without replacing unrelated files", async () => {
  const f = await fixture();
  const options = { root: join(f.root, "app with spaces%$"), home: f.root, node: process.execPath, run: f.run };
  await installService(options);
  const unit = await readFile(join(f.root, ".config/systemd/user/contextlanes.service"), "utf8");
  expect(unit).toContain("spaces%%$$/apps/daemon/dist/main.js"); expect(unit).toContain(`ExecStart="${process.execPath}"`); expect(unit).toContain("UMask=0077");
  expect(f.calls.slice(-2)).toEqual([{ cmd: "systemctl", args: ["--user", "daemon-reload"] }, { cmd: "systemctl", args: ["--user", "enable", "--now", "contextlanes.service"] }]);
  expect((await stat(join(f.root, ".local/bin/contextlanes"))).mode & 0o777).toBe(0o755);
  await installService(options);
  await writeFile(join(f.root, ".local/bin/contextlanes"), "user work");
  await expect(installService(options)).rejects.toThrow("Refusing to overwrite");
  expect(await readFile(join(f.root, ".local/bin/contextlanes"), "utf8")).toBe("user work");
});

it("refuses to unlink another daemon socket or a file at the socket path", async () => {
  const f = await fixture();
  const path = join(f.root, "lanes.sock");
  const hosts = new HostLinks({ store: f.store, bus: f.bus });
  cleanups.push(() => hosts.close());
  await writeFile(path, "user file");
  await expect(hosts.listen(path)).rejects.toThrow("not a socket");
  expect(await readFile(path, "utf8")).toBe("user file");
  await rm(path);
  await hosts.listen(path);
  const other = new HostLinks({ store: f.store, bus: f.bus });
  await expect(other.listen(path)).rejects.toThrow("already using");
  expect((await stat(path)).isSocket()).toBe(true);
});
