import { EventEmitter, once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, EventBus, HostLinks, LaneManager, Store, buildServer, runCommand, type Runner } from "@contextlanes/daemon";
import { loadConfig } from "../src/config.js";
import { SetupManager } from "../src/setup.js";
import { ProjectDiscovery } from "../src/projects.js";
import { installService } from "../src/install.js";
import { serveWeb } from "../src/http/static.js";
import Fastify from "fastify";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
const tailscaleStatus = { BackendState: "Running", Self: { DNSName: "neo.test.ts.net.", UserID: 12 }, User: { "12": { LoginName: "kyle@example.com" } } };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cl-setup-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"); await mkdir(home);
  const calls: { cmd: string; args: string[] }[] = [];
  const run = vi.fn<Runner>(async (cmd, args, opts) => {
    calls.push({ cmd, args });
    if (cmd === "tailscale") return { stdout: args[0] === "status" ? JSON.stringify(tailscaleStatus) : "{}" };
    if (cmd === "loginctl") return { stdout: "yes\n" };
    if (cmd === "git") return { stdout: args[1] === "--list" ? "" : args[0] === "rev-parse" ? opts!.cwd! : args[0] === "symbolic-ref" ? "origin/trunk\n" : args[0] === "for-each-ref" ? "feature\ntrunk\n" : "feature\n" };
    return { stdout: cmd.endsWith("claude") ? '{"loggedIn":true,"token":"never-return-this"}' : cmd.endsWith("opencode") ? "2 credentials" : "" };
  });
  const config = Config.parse({ paths: { data: join(root, "data"), lanes: join(root, "lanes") } });
  const store = Store.open(":memory:"); cleanups.push(() => store.close());
  const bus = new EventBus(); const hosts = new HostLinks({ store, bus }); const lanes = new LaneManager({ store, bus, config, run });
  const path = join(root, "config.toml");
  const changed = vi.fn(async () => {});
  const find = vi.fn(async (name: string): Promise<string | null> => `/fixture/bin/${name}`);
  const http = vi.fn<typeof fetch>(async () => new Response("{}"));
  const setup = new SetupManager(config, store, run, { path, changed, find, fetch: http, home, user: "kyle", portFree: async () => true }); await setup.initialize();
  const app = buildServer({ config, store, bus, hosts, lanes, setup, run, version: "test" }); cleanups.push(() => app.close());
  const secret = await readFile(setup.controlFile, "utf8");
  const claim = () => app.inject({ method: "POST", url: "/api/setup/local", headers: { host: "localhost", authorization: `Bearer ${secret}` }, payload: {} });
  const remote = { host: "neo.test.ts.net", origin: "https://neo.test.ts.net", "tailscale-user-login": "kyle@example.com" };
  return { root, home, path, config, store, app, setup, secret, claim, run, calls, changed, find, http, bus, remote };
}

describe("headless setup", () => {
  it("requires shell proof, claims locally without a typed code and persists a private config", async () => {
    const f = await fixture();
    expect((await stat(f.setup.controlFile)).mode & 0o777).toBe(0o600);
    for (const path of ["/api/projects", "/api/setup/projects/scan", "/api/setup/projects/folders", "/api/projects/unknown/branches"]) expect((await f.app.inject(path)).statusCode).toBe(401);
    expect((await f.app.inject("/api/setup/status")).body).not.toContain(f.secret);
    expect((await f.app.inject({ method: "POST", url: "/api/setup/local", payload: {} })).statusCode).toBe(403);
    for (const headers of [{ origin: "http://localhost" }, { "tailscale-user-login": "kyle@example.com" }, { host: "rebind.example" }]) expect((await f.app.inject({ method: "POST", url: "/api/setup/local", headers: { authorization: `Bearer ${f.secret}`, ...headers }, payload: {} })).statusCode).toBe(403);
    const result = await f.claim(); expect(result.statusCode).toBe(200);
    expect(result.json().url).toMatch(/^https:\/\/neo.test.ts.net\/setup#signin=/);
    expect(f.setup.claimed).toBe(true); expect(loadConfig(f.path).access.shellOwner).toBe("kyle");
    expect(loadConfig(f.path).access.owner).toBe("kyle@example.com");
    expect(loadConfig(f.path).notifications.publicUrl).toBe("https://neo.test.ts.net");
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    expect(f.calls.some((c) => c.cmd === "tailscale" && c.args.includes("--https=443"))).toBe(true);
  });
  it("redeems sign-in links exactly once, binds origin and expires after ten minutes", async () => {
    const f = await fixture(); const link = (await f.claim()).json(); const token = new URL(link.url).hash.slice(8);
    const redeem = (headers = f.remote) => f.app.inject({ method: "POST", url: "/api/setup/sign-in", headers, payload: { token } });
    expect((await redeem({ ...f.remote, host: "elsewhere.test.ts.net", origin: "https://elsewhere.test.ts.net" })).statusCode).toBe(401);
    const results = await Promise.all([redeem(), redeem()]); expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    const accepted = results.find((r) => r.statusCode === 200)!;
    expect(accepted.headers["set-cookie"]).toContain("HttpOnly; SameSite=Strict"); expect(accepted.headers["set-cookie"]).toContain("Secure");
    f.config.access.allowLocal = false;
    expect((await f.app.inject("/api/projects")).statusCode).toBe(401);
    const cookie = String(accepted.headers["set-cookie"]).split(";")[0]!;
    expect((await f.app.inject({ url: "/api/projects", headers: { cookie } })).statusCode).toBe(200);
    expect((await f.app.inject({ url: "/api/projects", headers: { "tailscale-user-login": "other@example.com" } })).statusCode).toBe(403);
    expect((await f.app.inject({ url: "/api/projects", headers: { cookie: "cl-owner=invented" } })).statusCode).toBe(401);
    const expiring = await f.setup.shellSetup();
    expect(Date.parse(expiring.expiresAt) - Date.now()).toBeGreaterThan(599000);
    f.store.db.prepare("UPDATE setup_link SET expires = ?").run(Date.now() - 1);
    expect(() => f.setup.signIn(new URL(expiring.url).hash.slice(8), new URL(expiring.url).origin)).toThrow("used or expired");
    f.config.access.allowLocal = true;
    expect((await f.app.inject({ url: "/api/setup/settings", headers: { host: "rebind.example" } })).statusCode).toBe(401);
    expect((await f.app.inject({ method: "POST", url: "/api/projects", headers: { host: "localhost", origin: "https://evil.example" }, payload: { path: f.home } })).statusCode).toBe(403);
  });
  it("prints the exact linger command and gives one missing-Tailscale line plus SSH fallback", async () => {
    const f = await fixture();
    f.find.mockResolvedValue(null);
    f.run.mockResolvedValue({ stdout: "no\n" });
    const result = (await f.app.inject({ method: "POST", url: "/api/setup/local", headers: { authorization: `Bearer ${f.secret}` }, payload: { sshHost: "192.0.2.42" } })).json();
    expect(result.messages).toEqual(["Keep ContextLanes running after logout: sudo loginctl enable-linger kyle", "Tailscale is not installed: https://tailscale.com/download"]);
    expect(result.tunnel).toBe("ssh -N -L 4600:127.0.0.1:4600 kyle@192.0.2.42");
    expect(result.url).toMatch(/^http:\/\/localhost:4600\/setup#signin=/);
    expect(f.config.access.shellOwner).toBe("kyle");
  });
  it("falls back for signed-out/denied Tailscale without exposing command errors", async () => {
    const f = await fixture();
    f.run.mockImplementation(async (cmd) => { if (cmd === "tailscale") throw new Error("secret raw exec stack"); return { stdout: "yes" }; });
    const result = (await f.claim()).json(); expect(result.tunnel).toContain("ssh -N -L");
    expect(result.messages[0]).toContain("tailscale up"); expect(JSON.stringify(result)).not.toContain("secret raw");
  });
  it("adds passkeys only after sign-in at the configured HTTPS address and consumes challenges", async () => {
    const f = await fixture();
    expect((await f.app.inject({ method: "POST", url: "/api/setup/passkey/options", payload: {} })).statusCode).toBe(401);
    await f.claim();
    await expect(f.setup.registration("http://localhost:4600")).rejects.toThrow("HTTPS Tailscale");
    const challenge = await f.setup.registration("https://neo.test.ts.net");
    expect(challenge.options.authenticatorSelection?.userVerification).toBe("required");
    const body = { challengeId: challenge.challengeId, response: { id: "abc", rawId: "abc", type: "public-key", response: { clientDataJSON: "abc", attestationObject: "abc" }, clientExtensionResults: {} } };
    await expect(f.setup.register(body, "https://elsewhere.test.ts.net")).rejects.toThrow("another origin");
    await expect(f.setup.register(body, "https://neo.test.ts.net")).rejects.toThrow("expired");
    f.config.access.passkey = { id: "abc", publicKey: "abc", counter: 3, rpId: "neo.test.ts.net" };
    await expect(f.setup.update({ access: { ...f.config.access, passkey: { ...f.config.access.passkey, counter: 2 } } })).rejects.toThrow("counter moved backwards");
    await expect(f.setup.authentication("https://elsewhere.example")).rejects.toThrow("registered");
  });
  it("serializes config writes, retains old values on failure, expands ~ and reloads projects once", async () => {
    const f = await fixture(); await f.claim();
    await f.setup.settings({ lanes: { maxConcurrent: 3, launchHosts: true } });
    const before = await readFile(f.path, "utf8");
    for (const flag of ["--dangerously-skip-permissions", "--auto", "--full-auto"]) await expect(f.setup.settings({ agents: { claude: { command: "cli", args: [flag] } } })).rejects.toThrow();
    expect(await readFile(f.path, "utf8")).toBe(before);
    expect(f.config.lanes.maxConcurrent).toBe(3); expect(f.config.lanes.host.command).toBe(process.execPath);
    await expect(f.setup.addProject({ path: "relative" })).rejects.toThrow("Choose a folder");
    await f.setup.addProject({ path: "~/repo", name: "Example" }); await f.setup.addProject({ path: "~/repo", name: "Example" });
    await f.setup.initialize();
    expect(f.store.listProjects()).toHaveLength(1); expect(loadConfig(f.path).projects).toHaveLength(1);
    expect(f.run).toHaveBeenCalledWith("git", ["rev-parse", "--show-toplevel"], { cwd: join(f.home, "repo"), timeout: 5000 });
    expect(f.changed).toHaveBeenCalled();
    const reloaded = new SetupManager(loadConfig(f.path), f.store, f.run, { path: f.path, home: f.home }); await reloaded.initialize(); expect(reloaded.claimed).toBe(true);
    f.run.mockRejectedValueOnce(new Error("raw git exec failure"));
    await expect(f.setup.addProject({ path: "/other/repo" })).rejects.toThrow("not a Git repository");
    expect(loadConfig(f.path).projects).toHaveLength(1);
  });
  it("adds same-named repositories without asking for a name and keeps first-lane completion after later failure", async () => {
    const f = await fixture(); await f.claim();
    const first = await f.setup.addProject({ path: "~/one/repo" });
    const second = await f.setup.addProject({ path: "~/two/repo" });
    expect(first.id).not.toBe(second.id);
    expect((await f.setup.addProject({ path: "~/two/repo" })).id).toBe(second.id);
    await f.setup.initialize(); expect(f.store.listProjects()).toHaveLength(2);
    const lane = (await f.app.inject({ method: "POST", url: "/api/lanes", payload: { project: first.id, task: "First task" } })).json();
    expect(lane.state).toBe("working"); expect(f.store.hasStartedLane()).toBe(true);
    f.store.setLaneState(lane.id, "failed", "Fixture later failure");
    expect((await f.app.inject("/api/setup/status")).json().hasLane).toBe(true);
  });
  it("reports Ready/Install/Sign in, installs pinned packages and returns only fixed login commands", async () => {
    const f = await fixture();
    const detected = await f.setup.detectAgents(); expect(detected.map((a) => a.status)).toEqual(["Ready", "Ready", "Ready"]);
    expect(JSON.stringify(detected)).not.toContain("never-return-this");
    f.find.mockImplementation(async (name) => name === "codex-acp" || name === "opencode" ? null : `/fixture/bin/${name}`);
    expect((await f.setup.detectAgents()).map((a) => a.status)).toEqual(["Ready", "Install", "Install"]);
    f.run.mockRejectedValueOnce(new Error("not signed in")); expect((await f.setup.detectAgents())[0]?.status).toBe("Sign in");
    await f.setup.installAgent({ id: "codex" });
    expect(f.run).toHaveBeenCalledWith("npm", ["install", "--global", "--prefix", join(f.home, ".local"), "@agentclientprotocol/codex-acp@2.5.0"], { timeout: 180000 });
    expect(loadConfig(f.path).agents.codex?.command).toMatch(/codex-acp$/);
    await f.setup.installAgent({ id: "opencode" });
    expect(f.run).toHaveBeenCalledWith("npm", ["install", "--global", "--prefix", join(f.home, ".local"), "opencode-ai@1.19.5"], { timeout: 180000 });
    expect(await f.setup.loginCommand("codex")).toEqual({ command: "/fixture/bin/codex", args: ["login", "--device-auth"], cwd: f.home });
    await expect(f.setup.loginCommand("codex;bad")).rejects.toThrow();
    await expect(f.setup.installAgent({ id: "invented" })).rejects.toThrow();
  });
  it("keeps login terminals owner-only, launches fixed commands and maps native build failures", async () => {
    const f = await fixture();
    const events = new EventEmitter();
    const pty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: (fn: (text: string) => void) => { events.on("data", fn); return { dispose: () => events.off("data", fn) }; },
      onExit: (fn: (exit: { exitCode: number }) => void) => { events.on("exit", fn); return { dispose: () => events.off("exit", fn) }; } };
    f.run.terminal = vi.fn(() => pty);
    await f.app.ready();
    await expect(f.app.injectWS("/api/setup/agents/codex/terminal")).rejects.toThrow("401");
    await f.claim();
    await expect(f.app.injectWS("/api/setup/agents/codex/terminal", { headers: { ...f.remote, "tailscale-user-login": "another@example.com" } })).rejects.toThrow("403");
    await expect(f.app.injectWS("/api/setup/agents/codex/terminal", { headers: { ...f.remote, origin: "https://evil.example" } })).rejects.toThrow("403");
    await expect(f.app.injectWS("/api/setup/agents/bash/terminal", { headers: { host: "localhost" } })).rejects.toThrow("400");
    const ws = await f.app.injectWS("/api/setup/agents/codex/terminal?command=bash", { headers: { host: "localhost" } });
    ws.send(JSON.stringify({ type: "input", data: "login-input" }));
    await vi.waitFor(() => expect(pty.write).toHaveBeenCalledWith("login-input"));
    expect(f.run.terminal).toHaveBeenCalledWith("/fixture/bin/codex", ["login", "--device-auth"], { cwd: f.home, cols: 80, rows: 24 });
    const output = once(ws, "message"); events.emit("data", "Follow this login URL"); expect(String((await output)[0])).toBe("Follow this login URL");
    const closed = once(ws, "close"); ws.terminate(); await closed;
    await vi.waitFor(() => expect(pty.kill).toHaveBeenCalledOnce());
    vi.mocked(f.run.terminal).mockImplementation(() => { throw new Error("secret raw PTY failure"); });
    const failed = await f.app.injectWS("/api/setup/agents/claude-code/terminal", { headers: { host: "localhost" } });
    const [code, reason] = await once(failed, "close"); expect(code).toBe(1011); expect(String(reason)).toContain("install the native terminal build"); expect(String(reason)).not.toContain("secret raw");
  });
  it("preserves occupied routes, reuses this app’s route and keeps the node owner", async () => {
    const f = await fixture();
    f.run.mockImplementation(async (cmd, args) => ({ stdout: cmd === "tailscale" && args[0] === "status" ? JSON.stringify(tailscaleStatus) : cmd === "tailscale" && args[1] === "status" ? '{"TCP":{"443":{},"8443":{}}}' : "yes" }));
    expect(await f.setup.enableTailnet()).toEqual({ publicUrl: "https://neo.test.ts.net:4601" });
    expect(f.run).toHaveBeenCalledWith("tailscale", ["serve", "--bg", "--https=4601", "--yes", "http://127.0.0.1:4600"], { timeout: 30000 });
    f.run.mockImplementation(async (_cmd, args) => ({ stdout: args[0] === "status" ? JSON.stringify(tailscaleStatus) : '{"TCP":{"4601":{"HTTPS":true}},"Web":{"neo.test.ts.net:4601":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:4600"}}}}}' }));
    const count = f.run.mock.calls.length; await f.setup.enableTailnet(); expect(f.run.mock.calls.slice(count)).toHaveLength(2);
    f.config.access.owner = "another@example.com"; await expect(f.setup.enableTailnet()).rejects.toThrow("machine’s owner");
    expect(f.run.mock.calls.some(([, args]) => args.includes("reset"))).toBe(false);
  });
  it("does not reuse or enable a port marked public by an existing Funnel configuration", async () => {
    const f = await fixture();
    f.run.mockImplementation(async (_cmd, args) => ({ stdout: args[0] === "status" ? JSON.stringify(tailscaleStatus) : args[1] === "status" ? '{"AllowFunnel":{"neo.test.ts.net:443":true}}' : "" }));
    expect(await f.setup.enableTailnet()).toEqual({ publicUrl: "https://neo.test.ts.net:8443" });
    expect(f.run).toHaveBeenCalledWith("tailscale", ["serve", "--bg", "--https=8443", "--yes", "http://127.0.0.1:4600"], { timeout: 30000 });
  });
  it("keeps generated push keys and validates local-only model endpoints without redirects", async () => {
    const f = await fixture(); await f.claim();
    const keys = await f.setup.generatePush(); expect(await f.setup.generatePush()).toEqual(keys);
    expect(loadConfig(f.path).notifications.webPush?.publicKey).toBe(keys.publicKey);
    const model = { name: "local", provider: "ollama", url: "http://127.0.0.1:11434" };
    await f.setup.probeModel(model);
    expect(f.http).toHaveBeenCalledWith(new URL("http://127.0.0.1:11434/api/tags"), expect.objectContaining({ redirect: "error" }));
    await expect(f.setup.probeModel({ ...model, url: "http://external.example" })).rejects.toThrow();
    await f.setup.settings({ localModels: [model] }); expect(loadConfig(f.path).localModels).toHaveLength(1);
    f.http.mockResolvedValue(new Response("", { status: 503 })); await expect(f.setup.probeModel(model)).rejects.toThrow();
  });
  it("maps unexpected failures to a recovery sentence and ends live streams before shutdown", async () => {
    const f = await fixture(); await f.claim();
    f.run.mockRejectedValueOnce(new Error("raw secret stack"));
    const failed = await f.app.inject({ method: "POST", url: "/api/projects", payload: { path: "~/missing" } });
    expect(failed.body).not.toContain("raw secret"); expect(failed.json().error).toContain("choose another folder");
    const subscribe = vi.spyOn(f.bus, "subscribeAll"); const response = f.app.inject({ url: "/api/stream" }).then((r) => r);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled()); await f.app.close(); expect((await response).body).toContain("retry: 2000");
  });
  it("serves SPA routes but not unknown API routes or traversal", async () => {
    const f = await fixture(); await writeFile(join(f.root, "index.html"), "<h1>Setup</h1>"); await writeFile(join(f.root, "sw.js"), "// push");
    const app = Fastify(); serveWeb(app, f.root); cleanups.push(() => app.close());
    expect((await app.inject("/setup")).body).toContain("Setup"); expect((await app.inject("/sw.js")).headers["cache-control"]).toBe("no-cache");
    expect((await app.inject("/api/invented")).statusCode).toBe(404); expect((await app.inject("/%2e%2e%2fsecret.txt")).statusCode).toBe(403); expect((await app.inject("/missing.js")).statusCode).toBe(404);
  });
});

describe("settings secrets", () => {
  it("never sends tokens or keys to the page, and saving the mask keeps them", async () => {
    const f = await fixture();
    await f.setup.settings({ notifications: { publicUrl: "https://neo.test.ts.net", telegram: { botToken: "123:secret", chatId: "-1", ownerId: "2" }, ntfy: { topic: "t", token: "tk_secret" } }, agents: { codex: { command: "codex-acp", args: [], env: { OPENAI_API_KEY: "sk-secret" } } } });
    const shown = JSON.stringify(f.setup.redactedSettings());
    for (const secret of ["123:secret", "tk_secret", "sk-secret"]) expect(shown).not.toContain(secret);
    const page = f.setup.redactedSettings();
    await f.setup.settings({ notifications: { ...page.notifications, telegram: { ...page.notifications.telegram!, chatId: "-5" } }, agents: page.agents });
    expect(f.config.notifications.telegram).toEqual({ botToken: "123:secret", chatId: "-5", ownerId: "2" });
    expect(f.config.notifications.ntfy?.token).toBe("tk_secret");
    expect(f.config.agents.codex?.env).toEqual({ OPENAI_API_KEY: "sk-secret" });
  });
});

describe("project discovery", () => {
  it("finds repos up to depth five, skips hidden/node_modules/symlinks, and reports branches", async () => {
    const f = await fixture();
    for (const path of ["code/one", "a/b/c/d/five", "a/b/c/d/e/six", ".secret/repo", "node_modules/repo"]) await mkdir(join(f.home, path, ".git"), { recursive: true });
    await mkdir(join(f.home, "worktree")); await writeFile(join(f.home, "worktree/.git"), "gitdir: elsewhere");
    await symlink(join(f.home, "code"), join(f.home, "link"));
    const result = await f.setup.projects.scan();
    expect(result.repositories.map((p) => p.name)).toEqual(["five", "one", "worktree"]);
    expect(result.repositories.every((p) => p.branch === "feature" && p.note === null)).toBe(true);
    expect(result.limited).toBe(false);
  });
  it("does not let one wide data folder hide repositories elsewhere", async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 320 }, (_, i) => mkdir(join(f.home, "data", `set-${i}`), { recursive: true })));
    await mkdir(join(f.home, "work/code/shop/.git"), { recursive: true });
    const result = await f.setup.projects.scan();
    expect(result.repositories.map((p) => p.name)).toEqual(["shop"]);
    expect(result.skipped).toEqual([join(f.home, "data")]);
  });
  it("stops at a repository instead of walking inside it", async () => {
    const f = await fixture();
    await mkdir(join(f.home, "code/outer/.git"), { recursive: true }); await mkdir(join(f.home, "code/outer/packages/inner/.git"), { recursive: true });
    expect((await f.setup.projects.scan()).repositories.map((p) => p.name)).toEqual(["outer"]);
  });
  it("stops at the folder budget and says so", async () => {
    const f = await fixture(); await Promise.all(Array.from({ length: 80 }, (_, i) => mkdir(join(f.home, `folder-${i}`))));
    const result = await new ProjectDiscovery(f.home, f.run, { limits: { folders: 50 } }).scan();
    expect(result.scanned).toBe(50); expect(result.limited).toBe(true);
  });
  it("lists repositories from Claude Code and Codex history first, including ones outside home, but never lane worktrees", async () => {
    const f = await fixture();
    const elsewhere = join(f.root, "srv/app"); await mkdir(join(elsewhere, ".git"), { recursive: true });
    const lane = join(f.config.paths.lanes, "app/01-task"); await mkdir(lane, { recursive: true }); await writeFile(join(lane, ".git"), "gitdir: x");
    await mkdir(join(f.home, "code/one/.git"), { recursive: true });
    await mkdir(join(f.home, ".claude/projects/-srv-app"), { recursive: true });
    await writeFile(join(f.home, ".claude/projects/-srv-app/s.jsonl"), `{"type":"summary"}\n{"type":"user","cwd":${JSON.stringify(elsewhere)}}\n`);
    await mkdir(join(f.home, ".claude/projects/-lane"), { recursive: true });
    await writeFile(join(f.home, ".claude/projects/-lane/s.jsonl"), `{"cwd":${JSON.stringify(lane)}}\n`);
    await mkdir(join(f.home, ".codex/sessions/2026/10/29"), { recursive: true });
    await writeFile(join(f.home, ".codex/sessions/2026/10/29/rollout-1.jsonl"), `{"type":"session_meta","payload":{"cwd":${JSON.stringify(join(f.home, "code/one"))}}}\n`);
    const old = new Date("2026-01-01T00:00:00Z"); await utimes(join(f.home, ".codex/sessions/2026/10/29/rollout-1.jsonl"), old, old);
    const result = await f.setup.projects.scan();
    expect(result.repositories.map((p) => [p.name, p.usedBy])).toEqual([["app", ["claude-code"]], ["one", ["codex"]]]);
    expect(result.repositories[0]!.lastUsed! > result.repositories[1]!.lastUsed!).toBe(true);
  });
  it("explains repositories git refuses or that have no commits instead of hiding them", async () => {
    const f = await fixture();
    await mkdir(join(f.home, "code/theirs/.git"), { recursive: true }); await mkdir(join(f.home, "code/empty/.git"), { recursive: true });
    const run: Runner = async (cmd, args, opts) => {
      if (opts?.cwd?.endsWith("theirs")) throw new Error("fatal: detected dubious ownership in repository");
      if (opts?.cwd?.endsWith("empty") && args[0] === "rev-parse") throw new Error("exit 1");
      return f.run(cmd, args, opts);
    };
    const result = await new ProjectDiscovery(f.home, run).scan();
    expect(result.repositories.find((p) => p.name === "theirs")!.note).toContain(`git config --global --add safe.directory ${join(f.home, "code/theirs")}`);
    expect(result.repositories.find((p) => p.name === "empty")!.note).toMatch(/No commits yet/);
  });
  it("confines the folder browser to canonical home paths, including symlinks and ..", async () => {
    const f = await fixture(); const outside = join(f.root, "outside"); await mkdir(outside); await mkdir(join(f.home, "code"));
    await symlink(outside, join(f.home, "escape")); await symlink(join(f.home, "code"), join(f.home, "inside"));
    const listing = await f.setup.projects.folders("~"); expect(listing.parent).toBeNull(); expect(listing.folders.map((p) => p.name)).toEqual(["code", "inside"]);
    await mkdir(join(f.home, "code/.git")); expect((await f.setup.projects.folders("~")).folders.map((p) => p.repo)).toEqual([true, true]);
    expect((await f.setup.projects.folders("~/inside")).path).toBe(join(f.home, "code"));
    for (const path of ["~/escape", "~/..", outside, "relative"]) await expect(f.setup.projects.folders(path)).rejects.toThrow();
  });
  it("reads registered repo branches and selects remote HEAD rather than the current feature branch", async () => {
    const f = await fixture(); await f.claim(); const project = await f.setup.addProject({ path: "~/repo" });
    const branches = (await f.app.inject(`/api/projects/${project.id}/branches`)).json(); expect(branches).toEqual({ branches: ["feature", "trunk"], defaultBranch: "trunk" });
    f.config.access.allowLocal = false;
    for (const path of ["/api/setup/projects/scan", "/api/setup/projects/folders", `/api/projects/${project.id}/branches`]) expect((await f.app.inject(path)).statusCode).toBe(401);
  });
});

it("installs an absolute user service without replacing unrelated files", async () => {
  const f = await fixture(); const options = { root: join(f.root, "app with spaces%$"), home: f.root, node: process.execPath, run: f.run };
  await installService(options); const unit = await readFile(join(f.root, ".config/systemd/user/contextlanes.service"), "utf8");
  expect(unit).toContain(`WorkingDirectory=${options.root.replace(/%/g, "%%")}\n`); expect(unit).toContain("spaces%%$$/apps/daemon/dist/main.js"); expect(unit).toContain(`ExecStart="${process.execPath}"`); expect(unit).toContain("UMask=0077");
  expect(f.calls.slice(-2)).toEqual([{ cmd: "systemctl", args: ["--user", "daemon-reload"] }, { cmd: "systemctl", args: ["--user", "enable", "--now", "contextlanes.service"] }]);
  expect((await stat(join(f.root, ".local/bin/contextlanes"))).mode & 0o777).toBe(0o755); await installService(options);
  await expect(installService({ ...options, root: "bad\npath" })).rejects.toThrow("line breaks");
  await writeFile(join(f.root, ".local/bin/contextlanes"), "user work"); await expect(installService(options)).rejects.toThrow("Refusing to overwrite"); expect(await readFile(join(f.root, ".local/bin/contextlanes"), "utf8")).toBe("user work");
});
it.runIf(process.env.CONTEXTLANES_REAL_HOSTS === "1")("passes the generated installer unit through systemd's real parser, including spaces and specifiers", async () => {
  const f = await fixture();
  const root = join(f.root, "app with spaces%$"); await mkdir(root);
  await installService({ root, home: f.root, node: process.execPath, run: f.run });
  await runCommand("systemd-analyze", ["--user", "verify", join(f.root, ".config/systemd/user/contextlanes.service")]);
});
it("refuses to unlink another daemon socket or a file at its path", async () => {
  const f = await fixture(); const path = join(f.root, "lanes.sock"); const hosts = new HostLinks({ store: f.store, bus: f.bus }); cleanups.push(() => hosts.close());
  await writeFile(path, "user file"); await expect(hosts.listen(path)).rejects.toThrow("not a socket"); expect(await readFile(path, "utf8")).toBe("user file"); await rm(path); await hosts.listen(path);
  await expect(new HostLinks({ store: f.store, bus: f.bus }).listen(path)).rejects.toThrow("already using"); expect((await stat(path)).isSocket()).toBe(true);
});
