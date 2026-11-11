import { copyFile, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { AGENT_NOTES, SafeMode, type Lane } from "@contextlanes/protocol";
import type { Config } from "../config.js";
import type { Runner } from "../run.js";
import { sandbox } from "../sandbox.js";
import { Refused } from "./manager.js";
import { laneEnv, type LaneTarget } from "../docker/exec.js";
import { LANE_AGENT_HOME, LANE_DIR, LANE_TMUX_SOCKET, LANE_TOOLS } from "../docker/names.js";

/** Keep login and customizations, but let native trust/login refresh write only inside this lane. */
async function agentHome(agent: string, dir: string): Promise<Record<string, string>> {
  const claude = agent === "claude-code";
  const source = claude ? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude") : process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const target = join(dir, "agent");
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && /(?:\.json|\.toml|\.md)$/.test(entry.name)) await copyFile(join(source, entry.name), join(target, entry.name), constants.COPYFILE_EXCL).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
    // Definitions stay shared; session histories, trust and caches are local to the lane.
    if (entry.isDirectory() && ["skills", "agents", "commands", "rules", "plugins"].includes(entry.name)) await symlink(join(source, entry.name), join(target, entry.name)).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
  }
  if (claude && !process.env.CLAUDE_CONFIG_DIR) await copyFile(join(homedir(), ".claude.json"), join(target, ".claude.json"), constants.COPYFILE_EXCL).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST" && e.code !== "ENOENT") throw e; });
  return { [claude ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: target };
}

async function wireHooks(lane: Lane, dir: string): Promise<string[]> {
  const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
  const script = fileURLToPath(new URL("../../../cli/bin/hook.mjs", import.meta.url));
  const command = `${node} '${script.replaceAll("'", "'\\''")}'`;
  const events = lane.agent === "claude-code" ? ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "Notification"]
    : ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop", "Interrupt"];
  const hooks = Object.fromEntries(events.map((event) => [event, [{ hooks: [{ type: "command", command: `${command} ${event}`, timeout: event === "PermissionRequest" ? 86_400 : 2 }] }]]));
  const file = join(dir, lane.agent === "claude-code" ? "hooks.json" : "agent/hooks.json");
  if (lane.agent === "codex") {
    const previous = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as { hooks?: Record<string, { hooks?: { command?: string }[] }[]> };
    for (const [event, entries] of Object.entries(previous.hooks ?? {})) {
      const kept = entries.map((entry) => ({ ...entry, hooks: entry.hooks?.filter((h) => !h.command?.includes("/apps/cli/bin/hook.mjs")) })).filter((entry) => entry.hooks?.length);
      hooks[event] = [...kept, ...(hooks[event] ?? [])] as typeof hooks[string];
    }
  }
  await writeFile(file, JSON.stringify({ hooks }), { mode: 0o600 });
  return lane.agent === "claude-code" ? ["--settings", file] : [];
}

/** Native MCP configuration stays private to the lane; tokens travel only in the environment. */
async function wireToolbox(lane: Lane, config: Config, dir: string, baseline: boolean, run: Runner, prefix: string[], env: Record<string, string>): Promise<string[]> {
  const file = join(dir, "mcp.json");
  const spec = config.lanes.toolbox;
  if (lane.agent === "claude-code") {
    await writeFile(file, JSON.stringify({ mcpServers: baseline ? {} : { contextlanes: { command: spec.command, args: spec.args, env: spec.env, timeout: 86_400_000 } } }), { mode: 0o600 });
    return ["--mcp-config", file, ...(baseline ? ["--strict-mcp-config"] : [])];
  }
  if (baseline) {
    // An empty table merges rather than clears Codex's inherited servers. Disable every resolved name.
    const [bin, ...args] = [...prefix, "codex", "mcp", "list", "--json"];
    const result = await run(bin!, args, { cwd: lane.worktree, env, timeout: 10_000 });
    const servers = z.array(z.object({ name: z.string().min(1) })).parse(JSON.parse(result.stdout));
    return servers.flatMap(({ name }) => ["-c", `mcp_servers.${JSON.stringify(name)}.enabled=false`]);
  }
  const target = join(dir, "agent", "config.toml");
  const previous = parse(await readFile(target, "utf8").catch(() => ""));
  const server = { command: spec.command, args: spec.args, env: spec.env, env_vars: ["CONTEXTLANES_LANE", "CONTEXTLANES_URL", "CONTEXTLANES_LANE_TOKEN"], startup_timeout_sec: 10, tool_timeout_sec: 86_400, enabled: true };
  const inherited = previous.mcp_servers && typeof previous.mcp_servers === "object" ? previous.mcp_servers : {};
  await writeFile(target, stringify({ ...previous, mcp_servers: { ...inherited, contextlanes: server } }), { mode: 0o600 });
  return Object.entries(server).filter(([key]) => key !== "env").flatMap(([key, value]) => ["-c", `mcp_servers.contextlanes.${key}=${JSON.stringify(value)}`]);
}

/** Safety and observation switches belong to the lane, never passthrough arguments. */
export function checkCliArgs(agent: string, args: string[]): void {
  for (const arg of args) {
    if (/^--(?:danger|yolo|bypass|allow-danger|approve-for-me|full-auto|auto-approve|permission|allowed-?tools|mcp-config|strict-mcp-config|settings|setting-sources|bare|safe-mode|remote|worktree|tmux|cd|add-dir|config|profile|enable|disable|sandbox|ask-for-approval|no-daemon)/i.test(arg)
      || /^-[acpsCwP](?:.|$)/.test(arg) || /^(?:danger-full-access|bypassPermissions|dontAsk|never)$/.test(arg)) {
      throw new Refused(`The lane owns permissions, sandbox and settings; ${arg} cannot be passed through.`, 400);
    }
  }
  if (!["claude-code", "codex"].includes(agent)) throw new Refused(`No CLI lane support for ${agent}; use an ACP lane.`, 400);
}

export function cliArgs(lane: Lane, prompt: string, extra?: string[], resume = false): string[] {
  checkCliArgs(lane.agent, extra ?? []);
  if (lane.agent === "claude-code") {
    const mode = lane.mode === "edits" ? "acceptEdits" : lane.mode === "plan" ? "plan" : "manual";
    SafeMode.parse(mode);
    return [...(lane.remoteControl ? ["--remote-control"] : []), "--permission-mode", mode, ...(lane.model ? ["--model", lane.model] : []),
      ...(lane.effort ? ["--effort", lane.effort] : []), ...(resume ? ["--continue"] : extra ?? ["--", prompt])];
  }
  // UNVERIFIED in a lane container: Codex's own workspace-write sandbox (Landlock and seccomp) inside Docker's default seccomp profile.
  return [...(resume ? ["resume", "--last"] : []), "--no-daemon", "--sandbox", lane.mode === "plan" ? "read-only" : "workspace-write", "--ask-for-approval", "on-request",
    "-c", 'approval_reviewer="user"', ...(lane.model ? ["--model", lane.model] : []),
    ...(lane.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(lane.effort)}`] : []), ...(extra ?? (resume ? [] : ["--", prompt]))];
}

/**
 * The sandbox hides ContextLanes' data folder, and the installed `contextlanes` in ~/.local/bin runs from
 * there (through `current`). So each lane gets its own wrapper, in the lane's data directory (which the
 * sandbox shows read-only), pointing at this release's CLI by its real path, first on the agent's PATH.
 */
export async function laneCommandDir(dir: string, node = process.execPath, cli = releaseCli()): Promise<string> {
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  await writeFile(join(bin, "contextlanes"), `#!/bin/sh\nexec ${quote(node)} ${quote(cli)} "$@"\n`, { mode: 0o755 });
  return bin;
}

function releaseCli(): string {
  const path = fileURLToPath(new URL("../../../cli/dist/main.js", import.meta.url));
  try { return realpathSync(path); } catch { return path; }
}

/**
 * Tells the agent about the contextlanes command, whether the lane starts with a prompt or interactively.
 * Claude Code: appended to its system prompt. Codex: its global instructions file in the lane's own
 * CODEX_HOME (AGENTS.override.md when the owner has one, since Codex then ignores AGENTS.md).
 */
export async function wireNotes(agent: string, dir: string, baseline: boolean): Promise<string[]> {
  if (baseline) return [];
  if (agent === "claude-code") return ["--append-system-prompt", AGENT_NOTES];
  const home = join(dir, "agent");
  const override = join(home, "AGENTS.override.md");
  const file = await readFile(override, "utf8").then(() => override, () => join(home, "AGENTS.md"));
  const current = await readFile(file, "utf8").catch(() => "");
  if (!current.includes(AGENT_NOTES)) await writeFile(file, `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${AGENT_NOTES}\n`, { mode: 0o600 });
  return [];
}

/** tmux executes multiple arguments directly. The private descriptor keeps the token out of ps. */
export async function launchCli(lane: Lane, config: Config, run: Runner, token: string, prompt: string, extra?: string[], resume = false, baseline = false): Promise<void> {
  const dir = join(config.paths.data, "cli", lane.id.replace("/", "-"));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "launch.json");
  const home = await agentHome(lane.agent, dir);
  const hooks = await wireHooks(lane, dir);
  // A single Linux argument is limited to 128 KiB. Large plans remain a file readable only in this lane.
  const task = join(dir, "task.md");
  if (resume) {
    prompt = await readFile(task, "utf8").catch(() => lane.task);
    const logs = join(dir, "agent", lane.agent === "claude-code" ? "projects" : "sessions");
    resume = (await readdir(logs, { recursive: true }).catch(() => [])).some((f) => f.endsWith(".jsonl"));
  }
  await writeFile(task, prompt, { mode: 0o600 });
  const first = Buffer.byteLength(prompt) > 64_000 ? `Read ${task} for your task, then carry it out.` : prompt;
  const prefix = sandbox(config, { laneData: dir, agentHome: join(dir, "agent") });
  const bin = await laneCommandDir(dir);
  const env = { ...home, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}:${join(homedir(), ".local/bin")}`, CONTEXTLANES_LANE: lane.id, CONTEXTLANES_URL: `http://127.0.0.1:${config.listen.port}`, CONTEXTLANES_LANE_TOKEN: token };
  const mcp = await wireToolbox(lane, config, dir, baseline, run, prefix, env);
  const notes = await wireNotes(lane.agent, dir, baseline);
  const [command, ...args] = [...prefix, lane.agent === "claude-code" ? "claude" : "codex", ...hooks, ...mcp, ...notes, ...cliArgs(lane, first, extra, resume)];
  await writeFile(file, JSON.stringify({ command, args,
    env }), { mode: 0o600 });
  await run("tmux", ["set-option", "-w", "-t", `=${lane.terminal}:`, "remain-on-exit", "on"]);
  await run("tmux", ["respawn-pane", "-k", "-t", `=${lane.terminal}:`, "-c", lane.worktree, process.execPath, fileURLToPath(new URL("../../bin/cli-agent.mjs", import.meta.url)), file]);
}

// ── The Docker runtime (docs/V4.md 3.3): the agent runs in the lane's container, from the tools volume ──

/** The hook events v3 wires, per agent. */
const hookEvents = (agent: string) => agent === "claude-code" ? ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "Notification"]
  : ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop", "Interrupt"];

/** The hooks file the agent gets in a lane: the hook from the tools volume, which reads the lane from its environment. */
export function laneHooks(agent: string): { hooks: Record<string, { hooks: { type: "command"; command: string; timeout: number }[] }[]> } {
  const command = `'${LANE_TOOLS}/bin/node' '${LANE_TOOLS}/cli/hook.mjs'`;
  return { hooks: Object.fromEntries(hookEvents(agent).map((event) => [event, [{ hooks: [{ type: "command" as const, command: `${command} ${event}`, timeout: event === "PermissionRequest" ? 86_400 : 2 }] }]])) };
}

/** The MCP toolbox in a lane: the bundle in the tools volume, run by the volume's own Node. */
export const laneToolbox = (config: Config) => ({ command: `${LANE_TOOLS}/bin/node`, args: [`${LANE_TOOLS}/cli/toolbox.mjs`], env: config.lanes.toolbox.env ?? {} });

/** What launchCliDocker needs from the lane's container. */
export type LaneFiles = {
  write(target: LaneTarget, path: string, content: string): Promise<void>;
  read(target: LaneTarget, path: string): Promise<string>;
  exec(target: LaneTarget, argv: string[], opts?: { timeout?: number }): Promise<{ stdout: string }>;
};

/**
 * launchCli for a lane container. Files go in the lane's own folder inside the container (LANE_DIR, 0700,
 * not the checkout), written through stdin; the token is in the launch file and in LANE_DIR/token, where the
 * lane's `contextlanes` reads it, never in an argument. The agents' config folders are the shared login
 * volume (CLAUDE_CONFIG_DIR, CODEX_HOME), so one sign-in covers every lane of that uid: what ContextLanes
 * puts there (Codex's hooks, MCP entry and notes) is the same for every lane, and lane-specific files stay
 * in LANE_DIR.
 */
export async function launchCliDocker(lane: Lane, config: Config, files: LaneFiles, target: LaneTarget, token: string, prompt: string, extra?: string[], resume = false, baseline = false): Promise<void> {
  const dir = `${LANE_DIR}/agent`;
  const tmux = (args: string[]) => files.exec(target, ["tmux", "-L", LANE_TMUX_SOCKET, ...args]);
  await files.write(target, `${LANE_DIR}/token`, token);
  const task = `${dir}/task.md`;
  if (resume) {
    prompt = (await files.read(target, task)) || lane.task;
    // UNVERIFIED: Claude Code keeps a session per folder under projects/<folder with / and . as ->; Codex's resume --last is assumed to pick this folder's session.
    const logs = lane.agent === "claude-code" ? `${LANE_AGENT_HOME}/claude/projects/${lane.worktree.replace(/[/.]/g, "-")}` : `${LANE_AGENT_HOME}/codex/sessions`;
    resume = !!(await files.exec(target, ["sh", "-c", 'find "$1" -name "*.jsonl" -print 2>/dev/null | head -n 1', "sh", logs]).then((r) => r.stdout.trim(), () => ""));
  }
  await files.write(target, task, prompt);
  const first = Buffer.byteLength(prompt) > 64_000 ? `Read ${task} for your task, then carry it out.` : prompt;
  const args: string[] = [];
  const toolbox = laneToolbox(config);
  if (lane.agent === "claude-code") {
    await files.write(target, `${dir}/hooks.json`, JSON.stringify(laneHooks(lane.agent)));
    await files.write(target, `${dir}/mcp.json`, JSON.stringify({ mcpServers: baseline ? {} : { contextlanes: { ...toolbox, timeout: 86_400_000 } } }));
    args.push("--settings", `${dir}/hooks.json`, "--mcp-config", `${dir}/mcp.json`, ...(baseline ? ["--strict-mcp-config"] : []), ...(baseline ? [] : ["--append-system-prompt", AGENT_NOTES]));
  } else {
    const home = `${LANE_AGENT_HOME}/codex`;
    // Codex reads hooks from CODEX_HOME. Earlier entries of ours are replaced; the owner's own are kept.
    const previous = JSON.parse((await files.read(target, `${home}/hooks.json`)) || "{}") as { hooks?: Record<string, { hooks?: { command?: string }[] }[]> };
    const hooks = laneHooks(lane.agent).hooks as Record<string, unknown[]>;
    for (const [event, entries] of Object.entries(previous.hooks ?? {})) {
      const kept = entries.map((entry) => ({ ...entry, hooks: entry.hooks?.filter((h) => !h.command?.includes("/cli/hook.mjs")) })).filter((entry) => entry.hooks?.length);
      hooks[event] = [...kept, ...(hooks[event] ?? [])];
    }
    await files.write(target, `${home}/hooks.json`, JSON.stringify({ hooks }));
    if (baseline) {
      const listed = await files.exec(target, ["codex", "mcp", "list", "--json"], { timeout: 10_000 });
      const servers = z.array(z.object({ name: z.string().min(1) })).parse(JSON.parse(listed.stdout));
      args.push(...servers.flatMap(({ name }) => ["-c", `mcp_servers.${JSON.stringify(name)}.enabled=false`]));
    } else {
      const server = { command: toolbox.command, args: toolbox.args, env: toolbox.env, env_vars: ["CONTEXTLANES_LANE", "CONTEXTLANES_URL", "CONTEXTLANES_LANE_TOKEN"], startup_timeout_sec: 10, tool_timeout_sec: 86_400, enabled: true };
      const current = parse((await files.read(target, `${home}/config.toml`)) || "");
      const inherited = current.mcp_servers && typeof current.mcp_servers === "object" ? current.mcp_servers : {};
      await files.write(target, `${home}/config.toml`, stringify({ ...current, mcp_servers: { ...inherited, contextlanes: server } }));
      args.push(...Object.entries(server).filter(([key]) => key !== "env").flatMap(([key, value]) => ["-c", `mcp_servers.contextlanes.${key}=${JSON.stringify(value)}`]));
      const notes = (await files.read(target, `${home}/AGENTS.md`));
      if (!notes.includes(AGENT_NOTES)) await files.write(target, `${home}/AGENTS.md`, `${notes.trimEnd()}${notes.trim() ? "\n\n" : ""}${AGENT_NOTES}\n`);
    }
  }
  const env = { ...laneEnv(target), CONTEXTLANES_LANE_TOKEN: token };
  const launch = `${dir}/launch.json`;
  await files.write(target, launch, JSON.stringify({ command: lane.agent === "claude-code" ? "claude" : "codex", args: [...args, ...cliArgs(lane, first, extra, resume)], env }));
  await tmux(["set-option", "-w", "-t", `=${lane.terminal}:`, "remain-on-exit", "on"]);
  await tmux(["respawn-pane", "-k", "-t", `=${lane.terminal}:`, "-c", lane.worktree, `${LANE_TOOLS}/bin/node`, `${LANE_TOOLS}/cli/cli-agent.mjs`, launch]);
}
