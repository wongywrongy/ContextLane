import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Lane } from "@contextlanes/protocol";
import { Config, Store, EventBus, HostLinks, LaneManager, buildServer, type Runner } from "@contextlanes/daemon";
import { checkCliArgs, cliArgs, laneCommandDir, launchCli, wireNotes } from "../src/lanes/cli.js";
import { execFileSync } from "node:child_process";
import { AGENT_NOTES } from "@contextlanes/protocol";
import { signedIn } from "./signed-in.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(mergedPr = false) {
  const root = await mkdtemp("/tmp/cl-cli-test-"); roots.push(root);
  vi.stubEnv("CLAUDE_CONFIG_DIR", root); vi.stubEnv("CODEX_HOME", root);
  const calls: { cmd: string; args: string[] }[] = [];
  const run: Runner = async (cmd, args) => { calls.push({ cmd, args }); return { stdout: cmd === "gh" && mergedPr ? JSON.stringify({ url: "https://github.invalid/pr/1", state: "MERGED", headRefOid: "head", baseRefName: "main", mergeCommit: { oid: "merge" } }) : args[0] === "symbolic-ref" ? "main\n" : args[0] === "display-message" ? "0\n" : "" }; };
  const config = Config.parse({ paths: { data: join(root, "data"), lanes: join(root, "lanes") } });
  const store = Store.open(":memory:"); store.addProject({ id: "demo", name: "Demo", path: root });
  const bus = new EventBus(); const hosts = new HostLinks({ store, bus }); const lanes = new LaneManager({ store, bus, run, config });
  const app = signedIn(buildServer({ store, bus, hosts, lanes, run, config, version: "test" }), store, config);
  return { root, config, calls, store, app, lanes };
}
describe("CLI lanes", () => {
  it.each(["claude-code", "codex"])("starts %s in tmux, with a sandbox and no token in arguments", async (agent) => {
    const { app, calls, config, store } = await fixture();
    const r = await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "Write hi\nThen stop", agent, model: "small", effort: "low" } });
    expect(r.statusCode).toBe(201);
    const lane = Lane.parse(r.json()); expect(lane).toMatchObject({ kind: "cli", direct: false, state: "working" });
    const specPath = join(config.paths.data, "cli", "demo-01", "launch.json");
    const spec = JSON.parse(await readFile(specPath, "utf8"));
    expect(spec.command).toBe("bwrap"); expect(spec.args).toContain(agent === "codex" ? "codex" : "claude");
    expect(store.laneForToken(spec.env.CONTEXTLANES_LANE_TOKEN)).toBe(lane.id);
    expect(JSON.stringify(calls)).not.toContain(spec.env.CONTEXTLANES_LANE_TOKEN);
    expect(calls.find((c) => c.args[0] === "respawn-pane")?.args).toContain(specPath);
    expect((await stat(specPath)).mode & 0o777).toBe(0o600);
    expect(store.events(lane.id)[0]).toMatchObject({ type: "lane.created", payload: { kind: "cli" } });
    await app.close(); store.close();
  });
  it("wires private MCP config and preserves baseline isolation across restart", async () => {
    const { app, config, store } = await fixture();
    const lane = (await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "Baseline", baseline: true } })).json();
    const dir = join(config.paths.data, "cli", "demo-01");
    expect(JSON.parse(await readFile(join(dir, "mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
    await app.inject({ method: "POST", url: "/api/lanes/demo/01/restart", payload: {} });
    expect(JSON.parse(await readFile(join(dir, "launch.json"), "utf8")).args).toContain("--strict-mcp-config");
    const headers = { authorization: `Bearer ${store.mintLaneToken(lane.id)}` };
    expect((await app.inject({ url: "/api/lanes/demo/01/tools", headers })).json()).toEqual({ tools: [] });
    for (const name of ["get_brief", "checkpoint", "ask_owner", "lanes_list"]) expect((await app.inject({ method: "POST", url: `/api/lanes/demo/01/tools/${name}`, headers, payload: {} })).statusCode).toBe(409);
    await app.close(); store.close();
  });
  it("disables every resolved Codex MCP server for baselines, refusing an unreadable list", async () => {
    const { app, config, store } = await fixture();
    const lane = (await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "Codex", agent: "codex" } })).json();
    const run: Runner = async () => ({ stdout: '[{"name":"user.server"},{"name":"contextlanes"}]' });
    await launchCli(lane, config, run, "private-token", "Task", undefined, false, true);
    const spec = JSON.parse(await readFile(join(config.paths.data, "cli", "demo-01", "launch.json"), "utf8"));
    expect(spec.args).toContain('mcp_servers."user.server".enabled=false');
    expect(spec.args).toContain('mcp_servers."contextlanes".enabled=false');
    expect(JSON.stringify(spec.args)).not.toContain("private-token");
    await expect(launchCli(lane, config, async () => ({ stdout: "invalid" }), "token", "Task", undefined, false, true)).rejects.toThrow();
    await app.close(); store.close();
  });
  it("direct mode keeps the checkout, database and branch on Delete", async () => {
    const { app, calls, root, store } = await fixture();
    const r = await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "Interactive", direct: true } });
    expect(r.json()).toMatchObject({ direct: true, worktree: root, branch: "main" });
    const removed = await app.inject({ method: "POST", url: "/api/lanes/demo/01/discard", payload: { deleteBranch: true } });
    expect(removed.statusCode).toBe(200);
    expect(calls.filter((c) => c.cmd === "git").flatMap((c) => c.args)).not.toContain("worktree");
    expect(calls.filter((c) => c.cmd === "git").flatMap((c) => c.args)).not.toContain("-D");
    expect((await stat(root)).isDirectory()).toBe(true);
    await app.close(); store.close();
  });
  it("refuses unsafe passthrough before reserving a lane or running a command", async () => {
    const { app, calls, store } = await fixture();
    const r = await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "Hi", cliArgs: ["--yolo"] } });
    expect(r.statusCode).toBe(400); expect(store.listLanes()).toEqual([]); expect(calls).toEqual([]);
    await app.close(); store.close();
  });
  it("offers Remote Control only for Claude CLI lanes", async () => {
    const { app, store, config } = await fixture();
    for (const request of [{ agent: "codex" }, { agent: "claude-code", kind: "acp" }]) expect((await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "Task", remoteControl: true, ...request } })).statusCode).toBe(400);
    expect(store.listLanes()).toHaveLength(0);
    expect((await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "Task", remoteControl: true } })).json()).toMatchObject({ remoteControl: true });
    expect(JSON.parse(await readFile(join(config.paths.data, "cli", "demo-01", "launch.json"), "utf8")).args).toContain("--remote-control");
    await app.close(); store.close();
  });
  it("restarts in the same pane, closes stale permissions and resumes only when a session exists", async () => {
    const { app, config, calls, store } = await fixture();
    await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "Write hi" } });
    store.appendEvent("demo/01", { type: "permission.requested", payload: { requestId: "old", title: "Old request", options: [] } });
    const restart = () => app.inject({ method: "POST", url: "/api/lanes/demo/01/restart", payload: {} });
    expect((await restart()).statusCode).toBe(200);
    expect(store.answered("demo/01", "old")).toBe(true);
    const specPath = join(config.paths.data, "cli", "demo-01", "launch.json");
    expect(JSON.parse(await readFile(specPath, "utf8")).args).toContain("Write hi");
    const logs = join(config.paths.data, "cli", "demo-01", "agent", "projects", "fixture");
    await mkdir(logs, { recursive: true }); await writeFile(join(logs, "session.jsonl"), "{}");
    expect((await restart()).statusCode).toBe(200);
    expect(JSON.parse(await readFile(specPath, "utf8")).args).toContain("--continue");
    expect(calls.filter((c) => c.args[0] === "respawn-pane").every((c) => c.args.includes("=cl-demo-01:"))).toBe(true);
    expect(calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree")).toHaveLength(1);
    await app.close(); store.close();
  });
  it("Clean up preserves a direct checkout and branch", async () => {
    const { app, root, calls, store } = await fixture(true);
    await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "Interactive", direct: true } });
    store.insertCheckpoint({ id: "direct-approved", lane: "demo/01", base: "base", head: "head", recipeHash: null, summary: "Direct work", checks: [], screenshots: [], files: [], plan: [], unplanned: [], process: [], signal: "strong", decision: "approved", prUrl: "https://github.invalid/pr/1", createdAt: new Date().toISOString() });
    store.setLaneState("demo/01", "in_review"); store.setLaneState("demo/01", "pr_open"); store.setLaneState("demo/01", "merged");
    expect((await app.inject({ method: "POST", url: "/api/lanes/demo/01/cleanup", payload: {} })).statusCode).toBe(200);
    expect(store.getLane("demo/01")!.state).toBe("cleaned");
    expect((await stat(root)).isDirectory()).toBe(true);
    expect(calls.filter((c) => c.cmd === "git").flatMap((c) => c.args)).not.toContain("worktree");
    await app.close(); store.close();
  });
  it("maps human permission modes, models and effort; resumes both agents", () => {
    const base = { agent: "claude-code", mode: "edits", model: "small", effort: "high" } as Lane;
    expect(cliArgs(base, "hi")).toEqual(["--permission-mode", "acceptEdits", "--model", "small", "--effort", "high", "--", "hi"]);
    expect(cliArgs({ ...base, mode: "plan" }, "hi")).toContain("plan");
    expect(cliArgs(base, "", undefined, true)).toContain("--continue");
    expect(cliArgs({ ...base, remoteControl: true }, "hi")).toContain("--remote-control");
    expect(cliArgs(base, "hi")).not.toContain("--remote-control");
    const codex = cliArgs({ ...base, agent: "codex" }, "hi");
    expect(codex).toContain("workspace-write"); expect(codex).toContain("on-request"); expect(codex).toContain('approval_reviewer="user"');
    expect(cliArgs({ ...base, agent: "codex", mode: "plan" }, "hi")).toContain("read-only");
    expect(cliArgs({ ...base, agent: "codex" }, "", undefined, true).slice(0, 2)).toEqual(["resume", "--last"]);
    for (const arg of ["--dangerously-skip-permissions", "--yolo", "--approve-for-me", "--permission-mode=bypassPermissions", "-a", "-cfoo=1", "--mcp-config=x", "--strict-mcp-config", "--settings=x", "--sandbox=danger-full-access"]) expect(() => checkCliArgs("codex", [arg])).toThrow();
  });
});

describe("the contextlanes command inside a CLI lane", () => {
  it("puts a wrapper for this release first on the agent's PATH, inside the lane's data folder", async () => {
    const { config, app, store } = await fixture();
    const r = await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "T", agent: "claude-code", kind: "cli", cliArgs: [] } });
    const lane = Lane.parse(r.json());
    const dir = join(config.paths.data, "cli", lane.id.replace("/", "-"));
    const spec = JSON.parse(await readFile(join(dir, "launch.json"), "utf8"));
    expect(spec.env.PATH.split(":")[0]).toBe(join(dir, "bin"));
    // The sandbox shows the lane's data folder read-only, so the wrapper is visible to the agent.
    expect(spec.args.join(" ")).toContain(`--ro-bind ${dir} ${dir}`);
    const wrapper = await readFile(join(dir, "bin", "contextlanes"), "utf8");
    expect(wrapper).toMatch(/^#!\/bin\/sh\nexec '.+' '.+\/apps\/cli\/dist\/main\.js' "\$@"\n$/);
    expect((await stat(join(dir, "bin", "contextlanes"))).mode & 0o777).toBe(0o755);
    expect(spec.args).toContain("--append-system-prompt");
    expect(spec.args[spec.args.indexOf("--append-system-prompt") + 1]).toBe(AGENT_NOTES);
    await app.close(); store.close();
  });

  it("writes a wrapper that runs the CLI with its arguments, whatever the paths contain", async () => {
    const root = await mkdtemp("/tmp/cl-wrapper-it's-"); roots.push(root);
    const script = join(root, "echo args.mjs");
    await writeFile(script, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const bin = await laneCommandDir(root, process.execPath, script);
    const out = execFileSync(join(bin, "contextlanes"), ["app", "status", "--json", "it's here"], { encoding: "utf8" });
    expect(JSON.parse(out)).toEqual(["app", "status", "--json", "it's here"]);
    // One command name in the lane, too.
    await expect(stat(join(bin, "cl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives Codex the notes in its own AGENTS.md, or the override the owner uses, once", async () => {
    const root = await mkdtemp("/tmp/cl-notes-"); roots.push(root);
    await mkdir(join(root, "agent"));
    await writeFile(join(root, "agent", "AGENTS.md"), "Owner rules.\n");
    expect(await wireNotes("codex", root, false)).toEqual([]);
    await wireNotes("codex", root, false);
    const text = await readFile(join(root, "agent", "AGENTS.md"), "utf8");
    expect(text).toBe(`Owner rules.\n\n${AGENT_NOTES}\n`);
    await writeFile(join(root, "agent", "AGENTS.override.md"), "Override.");
    await wireNotes("codex", root, false);
    expect(await readFile(join(root, "agent", "AGENTS.override.md"), "utf8")).toBe(`Override.\n\n${AGENT_NOTES}\n`);
    expect(await wireNotes("codex", root, true)).toEqual([]);
    expect(await wireNotes("claude-code", root, true)).toEqual([]);
  });
});

describe("lanes without an agent", () => {
  it("gets a checkout, a terminal and an environment, and starts no agent and no sandbox check", async () => {
    const { app, calls, store, lanes } = await fixture();
    const r = await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "Try the billing page", kind: "shell" } });
    expect(r.statusCode).toBe(201);
    const lane = Lane.parse(r.json());
    expect(lane).toMatchObject({ kind: "shell", agent: "none", state: "working", direct: false });
    expect(store.getLane(lane.id)!.kind).toBe("shell");
    expect(calls.some((c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "add")).toBe(true);
    expect(calls.some((c) => c.cmd === "systemd-run" && c.args.includes("--scope") && c.args.includes("new-session"))).toBe(true);
    expect(calls.filter((c) => c.args.includes("respawn-pane") || c.args.includes("--wait") || c.args.some((a) => a.startsWith("--unit=contextlanes-host")))).toEqual([]);
    expect(await lanes.sweep(() => false)).toEqual([]);
    expect(store.getLane(lane.id)!.state).toBe("working");
    expect((await app.inject({ method: "POST", url: `/api/lanes/${lane.id}/prompt`, payload: { text: "hi" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/lanes/${lane.id}/restart`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/lanes/${lane.id}/cancel`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/lanes/${lane.id}/agent` })).json()).toEqual({ connected: false, starting: false });
    await app.close(); store.close();
  });

  it("attaches to the current checkout with --here, without a worktree", async () => {
    const { app, calls, store, root } = await fixture();
    const r = await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "x", kind: "shell", direct: true } });
    const lane = Lane.parse(r.json());
    expect(lane).toMatchObject({ kind: "shell", direct: true, worktree: root, branch: "main" });
    expect(calls.some((c) => c.cmd === "git" && c.args[0] === "worktree")).toBe(false);
    await app.close(); store.close();
  });

  it("refuses agent options, and direct mode for ACP lanes", async () => {
    const { app, store } = await fixture();
    for (const payload of [{ kind: "shell", cliArgs: ["--x"] }, { kind: "shell", remoteControl: true }, { kind: "shell", auto: true }, { kind: "acp", agent: "opencode", direct: true }]) {
      expect((await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "x", ...payload } })).statusCode).toBe(400);
    }
    await app.close(); store.close();
  });
});

describe("with the sandbox turned off", () => {
  it("runs agents unconfined only because the owner said so, and every lane records it", async () => {
    const { root, calls } = await fixture();
    const { sandbox, checkSandbox, requireSandbox, confineGit, GIT_GUARDS } = await import("../src/sandbox.js");
    const config = Config.parse({ sandbox: { mode: "off" }, paths: { data: join(root, "data"), lanes: join(root, "lanes") } });
    expect(sandbox(config)).toEqual([]);
    const run: Runner = async (cmd, args) => { calls.push({ cmd, args }); return { stdout: args[0] === "symbolic-ref" ? "main\n" : "" }; };
    expect(await checkSandbox(run, config)).toBe(false);
    await expect(requireSandbox(run, config)).resolves.toBeUndefined();
    await confineGit(run, config)("git", ["status"]);
    expect(calls.at(-1)).toEqual({ cmd: "git", args: [...GIT_GUARDS, "status"] });

    const store = Store.open(":memory:"); store.addProject({ id: "demo", name: "Demo", path: root });
    const bus = new EventBus(); const lanes = new LaneManager({ store, bus, run, config });
    const app = signedIn(buildServer({ store, bus, hosts: new HostLinks({ store, bus }), lanes, run, config, version: "test" }), store, config);
    const lane = Lane.parse((await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "T", agent: "codex", kind: "cli", cliArgs: [] } })).json());
    expect(store.events(lane.id).find((e) => e.type === "lane.created")!.payload).toMatchObject({ sandbox: "off" });
    const spec = JSON.parse(await readFile(join(config.paths.data, "cli", "demo-01", "launch.json"), "utf8"));
    expect(spec.command).toBe("codex");
    expect(spec.args).not.toContain("bwrap");
    expect((await app.inject("/api/health")).json()).toMatchObject({ sandbox: "off" });
    await app.close(); store.close();
  });

  it("refuses an agent where bubblewrap does not work, and says how to proceed", async () => {
    const { root } = await fixture();
    const { requireSandbox } = await import("../src/sandbox.js");
    const config = Config.parse({ paths: { data: join(root, "data"), lanes: join(root, "lanes") } });
    const err = await requireSandbox(async () => { throw new Error("no bwrap"); }, config).catch((e: Error & { code?: string }) => e);
    expect(err).toMatchObject({ code: "sandbox_unavailable" });
    expect((err as Error).message).toContain('[sandbox] mode = "off"');
  });
});

describe("without systemd", () => {
  it("refuses ACP lanes and scheduled lanes, which need it", async () => {
    const { root } = await fixture();
    const config = Config.parse({ supervisor: { driver: "process" }, features: { acp: true, schedules: true }, paths: { data: join(root, "data"), lanes: join(root, "lanes") }, lanes: { launchHosts: false } });
    const run: Runner = async () => ({ stdout: "" });
    const store = Store.open(":memory:"); store.addProject({ id: "demo", name: "Demo", path: root });
    const lanes = new LaneManager({ store, bus: new EventBus(), run, config });
    await expect(lanes.start({ project: "demo", task: "x", agent: "opencode" })).rejects.toMatchObject({ code: "needs_systemd" });
    const { Schedules } = await import("../src/schedules.js");
    const schedules = new Schedules({ config, store, lanes, setup: {} as never, run, home: root, node: process.execPath, cli: "x" });
    await expect(schedules.add({ id: "nightly", project: "demo", task: "x", agent: "codex", when: "*-*-* 03:00" })).rejects.toMatchObject({ code: "needs_systemd" });
    store.close();
  });
});
