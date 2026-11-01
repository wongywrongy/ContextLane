import { copyFile, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SafeMode, type Lane } from "@contextlanes/protocol";
import type { Config } from "../config.js";
import type { Runner } from "../run.js";
import { sandbox } from "../sandbox.js";
import { Refused } from "./manager.js";

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

/** Safety and observation switches belong to the lane, never passthrough arguments. */
export function checkCliArgs(agent: string, args: string[]): void {
  for (const arg of args) {
    if (/^--(?:danger|yolo|bypass|allow-danger|approve-for-me|full-auto|auto-approve|permission|allowed-?tools|settings|setting-sources|bare|safe-mode|remote|worktree|tmux|cd|add-dir|config|profile|enable|disable|sandbox|ask-for-approval|no-daemon)/i.test(arg)
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
    return ["--permission-mode", mode, ...(lane.model ? ["--model", lane.model] : []),
      ...(lane.effort ? ["--effort", lane.effort] : []), ...(resume ? ["--continue"] : extra ?? ["--", prompt])];
  }
  return [...(resume ? ["resume", "--last"] : []), "--no-daemon", "--sandbox", lane.mode === "plan" ? "read-only" : "workspace-write", "--ask-for-approval", "on-request",
    "-c", 'approval_reviewer="user"', ...(lane.model ? ["--model", lane.model] : []),
    ...(lane.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(lane.effort)}`] : []), ...(extra ?? (resume ? [] : ["--", prompt]))];
}

/** tmux executes multiple arguments directly. The private descriptor keeps the token out of ps. */
export async function launchCli(lane: Lane, config: Config, run: Runner, token: string, prompt: string, extra?: string[], resume = false): Promise<void> {
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
  await writeFile(file, JSON.stringify({ command: prefix[0], args: [...prefix.slice(1), lane.agent === "claude-code" ? "claude" : "codex", ...hooks, ...cliArgs(lane, first, extra, resume)],
    env: { ...home, PATH: `${process.env.PATH ?? "/usr/bin:/bin"}:${join(homedir(), ".local/bin")}`, CONTEXTLANES_LANE: lane.id, CONTEXTLANES_URL: `http://127.0.0.1:${config.listen.port}`, CONTEXTLANES_LANE_TOKEN: token } }), { mode: 0o600 });
  await run("tmux", ["set-option", "-w", "-t", `=${lane.terminal}:`, "remain-on-exit", "on"]);
  await run("tmux", ["respawn-pane", "-k", "-t", `=${lane.terminal}:`, "-c", lane.worktree, process.execPath, fileURLToPath(new URL("../../bin/cli-agent.mjs", import.meta.url)), file]);
}
