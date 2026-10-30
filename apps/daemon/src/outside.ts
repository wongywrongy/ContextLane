import { mkdir, readdir, readFile, stat, writeFile, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Lane, OutsideAgent, ProjectId } from "@contextlanes/protocol";
import type { Store } from "./db/store.js";
import { NotFound, Refused, type LaneManager } from "./lanes/manager.js";
import { inside } from "./resources.js";
import type { Runner } from "./run.js";

/** Agent command lines started by hand. Adapters (claude-agent-acp, codex-acp), logins and MCP servers are not sessions. */
export function agentOf(args: string): "claude-code" | "codex" | null {
  if (/\bacp\b|-acp\b|\b(auth|login|logout|mcp|update|doctor)\b/.test(args)) return null;
  const argv0 = args.split(/\s+/)[0] ?? "";
  const script = args.split(/\s+/)[1] ?? "";
  if (/(^|\/)claude$/.test(argv0) || /@anthropic-ai\/claude-code\/cli\.js$/.test(script)) return "claude-code";
  if (/(^|\/)codex$/.test(argv0) || /@openai\/codex\/bin\/codex\.js$/.test(script)) return "codex";
  return null;
}

/** Claude Code keeps a folder's sessions in ~/.claude/projects/<the path with every other character as ->. */
export const claudeSlug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

type Message = { role: "user" | "agent"; text: string };
const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((c) => c && typeof c === "object" && "text" in c && typeof c.text === "string" && ["text", "input_text", "output_text"].includes(String((c as { type?: unknown }).type)) ? c.text : "").filter(Boolean).join("\n") : "";

/** The conversation in a Claude Code or Codex session log, text only (no tool output). */
export function sessionMessages(agent: "claude-code" | "codex", log: string): Message[] {
  const out: Message[] = [];
  for (const line of log.split("\n")) {
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (agent === "claude-code" && (row.type === "user" || row.type === "assistant") && !row.isMeta && row.message && typeof row.message === "object") {
      const text = textOf((row.message as { content?: unknown }).content).trim();
      if (text && !text.startsWith("<command-") && !text.startsWith("<local-command")) out.push({ role: row.type === "user" ? "user" : "agent", text });
    } else if (agent === "codex" && row.type === "response_item" && row.payload && typeof row.payload === "object") {
      const p = row.payload as { type?: string; role?: string; content?: unknown };
      const text = textOf(p.content).trim();
      if (p.type === "message" && text && (p.role === "user" || p.role === "assistant") && !text.startsWith("<environment_context>") && !text.startsWith("<user_instructions>")) out.push({ role: p.role === "user" ? "user" : "agent", text });
    }
  }
  return out;
}

/** A handoff an agent in a new lane can pick up from: the task as first asked, then the latest exchanges, about 8,000 characters. */
export function handoffFrom(messages: Message[], folder: string): string {
  const first = messages.find((m) => m.role === "user")?.text ?? "";
  const tail: string[] = [];
  let size = 0;
  for (const m of [...messages].reverse()) {
    const line = `${m.role === "user" ? "Owner" : "Agent"}: ${m.text.length > 2000 ? `${m.text.slice(0, 2000)}…` : m.text}`;
    if (size + line.length > 8000) break;
    tail.unshift(line); size += line.length;
  }
  return [`You are taking over a session that ran outside ContextLanes in ${folder}. Its uncommitted changes have been copied into this checkout. Continue the work; check the files rather than assuming.`,
    first ? `\nThe task as first asked:\n${first.slice(0, 2000)}` : "", `\nThe end of that conversation:\n${tail.join("\n\n")}`].join("\n");
}

/**
 * Claude Code and Codex sessions running in a project's folders that no lane started ("Watching only"),
 * plus ones that ended in the last 12 hours, which can be taken over. Nothing here stops a process.
 */
export class OutsideAgents {
  private seen = new Map<string, OutsideAgent & { project: ProjectId }>();
  constructor(private deps: { run: Runner; store: Store; lanes: LaneManager; home?: string; data: string; lanesDir: string }) {}

  async list(project: ProjectId): Promise<OutsideAgent[]> {
    const { run, store } = this.deps;
    const p = store.getProject(project);
    if (!p) throw new NotFound("no such project");
    const roots = [p.path, ...store.listLanes(project).map((l) => l.worktree)];
    const ps = await run("ps", ["-eo", "pid=,etimes=,args="], { timeout: 5000 }).then((r) => r.stdout, () => "");
    const live = new Set<string>();
    for (const line of ps.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const agent = agentOf(m[3]!);
      if (!agent) continue;
      const pid = Number(m[1]);
      const cwd = await run("readlink", ["-e", `/proc/${pid}/cwd`], { timeout: 2000 }).then((r) => r.stdout.trim(), () => "");
      if (!cwd || !roots.some((root) => inside(root, cwd))) continue;
      const group = await run("cat", [`/proc/${pid}/cgroup`], { timeout: 2000 }).then((r) => r.stdout, () => "");
      if (/contextlanes-(lane|env)-/.test(group)) continue;
      const startedAt = new Date(Date.now() - Number(m[2]) * 1000).toISOString();
      const key = `${pid}@${startedAt.slice(0, 16)}`;
      live.add(key);
      const known = [...this.seen.values()].find((s) => s.pid === pid && Math.abs(Date.parse(s.startedAt) - Date.parse(startedAt)) < 5000);
      const session = await this.sessionFile(agent, cwd, startedAt).catch(() => null);
      this.seen.set(known ? `${known.pid}@${known.startedAt.slice(0, 16)}` : key, { project, agent, pid, cwd, startedAt: known?.startedAt ?? startedAt, running: true, endedAt: null, session: session ?? known?.session ?? null });
    }
    const now = Date.now();
    for (const [key, s] of this.seen) {
      if (s.project !== project) continue;
      if (s.running && ![...live].some((k) => k.startsWith(`${s.pid}@`))) { s.running = false; s.endedAt = new Date().toISOString(); }
      if (!s.running && now - Date.parse(s.endedAt!) > 12 * 3600_000) this.seen.delete(key);
    }
    return [...this.seen.values()].filter((s) => s.project === project).map(({ project: _p, ...rest }) => rest).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** The session log the process is writing: the newest one for its folder, touched since it started. */
  private async sessionFile(agent: "claude-code" | "codex", cwd: string, startedAt: string): Promise<string | null> {
    const home = this.deps.home ?? homedir();
    const since = Date.parse(startedAt) - 60_000;
    const newest = async (files: string[]) => {
      const stats = await Promise.all(files.map(async (f) => ({ f, t: await stat(f).then((s) => s.mtimeMs, () => 0) })));
      return stats.filter((s) => s.t >= since).sort((a, b) => b.t - a.t)[0]?.f ?? null;
    };
    if (agent === "claude-code") {
      const dir = join(process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects", claudeSlug(cwd));
      return newest((await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)));
    }
    const root = join(process.env.CODEX_HOME ?? join(home, ".codex"), "sessions");
    const days = [0, 1].map((d) => new Date(Date.now() - d * 86400_000)).map((d) => join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")));
    const files = (await Promise.all(days.map(async (dir) => (await readdir(dir).catch(() => [])).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl")).map((f) => join(dir, f))))).flat();
    const matching: string[] = [];
    for (const f of files) {
      const first = (await readFile(f, "utf8").catch(() => "")).split("\n", 1)[0] ?? "";
      try { const meta = JSON.parse(first) as { payload?: { cwd?: string } }; if (meta.payload?.cwd === cwd) matching.push(f); } catch { /* not a session file */ }
    }
    return newest(matching);
  }

  /**
   * Take over: only once the outside process has exited. A new lane starts from that folder's branch, its
   * uncommitted changes (tracked and new files) are copied in, and the agent starts from a handoff written
   * from the end of the session log. The session itself is not resumed: its log is kept per folder, and the
   * lane works in a new one.
   */
  async takeOver(project: ProjectId, pid: number, startedAt: string): Promise<Lane> {
    await this.list(project);
    const s = [...this.seen.values()].find((x) => x.project === project && x.pid === pid && x.startedAt === startedAt);
    if (!s) throw new NotFound("That session is no longer listed.");
    if (s.running) throw new Refused(`Close the ${s.agent === "codex" ? "Codex" : "Claude Code"} session first (pid ${pid}); ContextLanes never stops it for you.`);
    const { run } = this.deps;
    const branch = (await run("git", ["branch", "--show-current"], { cwd: s.cwd })).stdout.trim();
    if (!branch) throw new Refused(`${s.cwd} is not on a branch, so a lane cannot start from it.`);
    const messages = s.session ? sessionMessages(s.agent, await readFile(s.session, "utf8").catch(() => "")) : [];
    const firstAsk = messages.find((m) => m.role === "user")?.text.split("\n")[0]?.slice(0, 80);
    const patchDir = join(this.deps.lanesDir, ".attachments", "takeover");
    await mkdir(patchDir, { recursive: true, mode: 0o700 });
    const lane = await this.deps.lanes.start({ project, task: firstAsk ? `Continue: ${firstAsk}` : `Continue the session from ${s.cwd}`, agent: s.agent, base: branch }, {
      firstPrompt: handoffFrom(messages, s.cwd),
      prepare: async (l) => {
        const patch = (await run("git", ["diff", "--binary", "HEAD"], { cwd: s.cwd })).stdout;
        if (patch.trim()) {
          const file = join(patchDir, `${l.id.replace("/", "-")}.patch`);
          await writeFile(file, patch, { mode: 0o600 });
          await run("git", ["apply", "--whitespace=nowarn", file], { cwd: l.worktree });
        }
        const untracked = (await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: s.cwd })).stdout.split("\0").filter(Boolean);
        for (const f of untracked) { await mkdir(dirname(join(l.worktree, f)), { recursive: true }); await copyFile(join(s.cwd, f), join(l.worktree, f)); }
      },
    });
    this.seen.delete(`${s.pid}@${s.startedAt.slice(0, 16)}`);
    return lane;
  }
}
