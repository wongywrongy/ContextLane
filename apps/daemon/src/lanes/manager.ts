import { readFile } from "node:fs/promises";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Skills } from "../skills.js";
import { laneColour, laneId, laneTitle, StartLaneRequest, type Lane, type ServiceProposal } from "@contextlanes/protocol";
import type { EventBus } from "../bus.js";
import type { Config } from "../config.js";
import type { Store } from "../db/store.js";
import type { Runner } from "../run.js";
import { Terminals } from "../terminal/tmux.js";
import { branchName, hostUnit, terminalSession, worktreePath } from "./naming.js";
import { requireSandbox, sandbox, socketPath } from "../sandbox.js";

/**
 * Turns a task into a lane: branch + worktree, a tmux session, then (when enabled) a lane host
 * under systemd that holds the agent's ACP session. Every step is an event.
 */
export class LaneManager {
  private readonly terminals: Terminals;
  /** When each lane's agent host was last started by this daemon, so the UI can say "starting" instead of "not connected". */
  private readonly launched = new Map<string, { at: number; since: number }>();

  constructor(
    private readonly deps: { store: Store; bus: EventBus; config: Config; run: Runner },
  ) {
    this.terminals = new Terminals(deps.run);
  }

  /**
   * Lane numbers restart with a fresh database, and branches and tmux sessions outlive their lanes,
   * so lane/01-x, cl-project-01 or a contextlanes-lane-project-01 unit may already exist. Add -2, -3…
   * until the branch, the checkout folder, the terminal session and the host unit are all free.
   * Existing shells and units are never touched. A failed check counts as free; the setup step then
   * reports the real problem.
   */
  private async freeNames(repo: string, project: string, id: Lane["id"], n: number, task: string): Promise<{ branch: string; worktree: string; terminal: string; hostUnit: string }> {
    const sessions = new Set((await this.deps.run("tmux", ["list-sessions", "-F", "#{session_name}"]).then((r) => r.stdout, () => "")).split("\n").map((s) => s.trim()).filter(Boolean));
    const units = new Set((await this.deps.run("systemctl", ["--user", "list-units", "--all", "--plain", "--no-legend", "--type=service", "contextlanes-lane-*"]).then((r) => r.stdout, () => "")).split("\n").map((line) => line.trim().split(/\s+/)[0]!.replace(/\.service$/, "")).filter(Boolean));
    for (let i = 1; i <= 50; i++) {
      const suffix = i === 1 ? "" : `-${i}`;
      const branch = `${branchName(n, task)}${suffix}`;
      const worktree = `${worktreePath(this.deps.config.paths.lanes, project, n, task)}${suffix}`;
      const terminal = `${terminalSession(id)}${suffix}`;
      const unit = `${hostUnit(id)}${suffix}`;
      const listed = await this.deps.run("git", ["branch", "--list", branch], { cwd: repo }).then((r) => r.stdout.trim(), () => "");
      const used = await access(worktree).then(() => true, () => false);
      if (!listed && !used && !sessions.has(terminal) && !units.has(unit)) return { branch, worktree, terminal, hostUnit: unit };
    }
    throw new Refused(`Branches lane/${String(n).padStart(2, "0")}-… are all taken in this repository; delete old lane branches and try again.`);
  }

  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * `prepare` runs after the checkout exists and before the agent starts (Take over copies changes in);
   * `firstPrompt` replaces the task as the agent's first message while the lane keeps its short task.
   */
  async start(input: unknown, extra: { prepare?: (lane: Lane) => Promise<void>; firstPrompt?: string } = {}): Promise<Lane> {
    const req = StartLaneRequest.parse(input);
    const { store, config } = this.deps;
    const project = store.getProject(req.project);
    if (!project) throw new NotFound(`no project ${req.project}`);
    // Reserved one at a time, from the limit check to the lane row, so two starts never take the same
    // number or both pass the limit. The slow part (checkout, terminal, agent) runs outside the lock.
    const { lane, id, title } = await this.serial(async () => {
      const active = store.listLanes().filter((l) => ["setting_up", "working", "needs_you"].includes(l.state));
      if (active.length >= config.lanes.maxConcurrent) throw new Refused(`${active.length} lanes are already running, the most this machine allows. Finish or pause one, or raise the limit in Settings.`);

      if (config.lanes.launchHosts) await requireSandbox(this.deps.run, config);

      const n = store.nextLaneNumber(project.id);
      const id = laneId(project.id, n);
      // A task can be a whole plan: lists, the branch and the header use a short title; the agent gets all of it.
      const title = req.title ?? laneTitle(req.task);
      const names = await this.freeNames(project.path, project.id, id, n, title);
      const lane = store.insertLane({
        id,
        n,
        project: project.id,
        goal: req.goal ?? null,
        task: title,
        agent: req.agent,
        model: req.model ?? null,
        mode: req.mode,
        branch: names.branch,
        worktree: names.worktree,
        terminal: names.terminal,
        hostUnit: names.hostUnit,
        base: req.base,
        state: "draft",
        colour: laneColour(n),
      });
      this.emit(store.appendEvent(id, { type: "lane.created", payload: { task: lane.task, agent: lane.agent, branch: lane.branch, worktree: lane.worktree, ...(req.baseline ? { baseline: true } : {}) } }));
      if (req.adoption) this.emit(store.appendEvent(id, { type: "service.proposed", payload: req.adoption }));
      // The full task is the lane's first message, shown as the first step.
      this.emit(store.appendEvent(id, { type: "agent.message", payload: { role: "user", text: extra.firstPrompt ?? req.task } }));
      this.emit(store.setLaneState(id, "setting_up"));
      return { lane, id, title };
    });

    try {
      await mkdir(dirname(lane.worktree), { recursive: true });
      await this.deps.run("git", ["worktree", "add", "-b", lane.branch, lane.worktree, req.base], { cwd: project.path });
      await extra.prepare?.(lane);
      // Shared skills (4.6) go in before the agent starts, so it sees them from its first turn. A baseline bench lane gets none.
      // A skill that fails to copy is reported, not fatal: the lane still works without it.
      if (!req.baseline) await new Skills({ config, store, run: this.deps.run }).install(lane).catch((err: Error) => this.emit(store.appendEvent(id, { type: "agent.error", payload: { message: `Project skills were not copied: ${err.message}` } })));
      await this.terminals.create(lane.terminal, lane.worktree, { CONTEXTLANES_LANE: id });
      if (config.lanes.launchHosts) {
        const notes = req.baseline ? "" : await readFile(join(config.paths.data, "notes", `${project.id}.md`), "utf8").catch(() => "");
        await this.launch(lane, taskText(lane, req.adoption, extra.firstPrompt ?? (req.task !== title ? req.task : undefined), notes));
      }
      if (store.getLane(id)!.state === "setting_up") this.emit(store.setLaneState(id, "working"));
      if (store.getLane(id)!.state === "working" && store.inbox().some((i) => i.lane === id && i.kind === "permission")) this.emit(store.setLaneState(id, "needs_you"));
    } catch (err) {
      this.emit(store.setLaneState(id, "failed", err instanceof Error ? err.message : String(err)));
    }
    return store.getLane(id)!;
  }

  /**
   * Starts the lane's agent host with a fresh token and watches that it connects. The first message goes
   * in a file in the lane's attachments folder (readable in the sandbox): no argument length limit, no
   * escaping, and not visible in `ps`. The token goes through the environment for the same reason.
   */
  async launch(lane: Lane, text: string): Promise<void> {
    const { config, store, run } = this.deps;
    const dir = join(config.paths.lanes, ".attachments", lane.id.replace("/", "-"));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `task-${Date.now()}.md`);
    await writeFile(file, text, { mode: 0o600 });
    const since = store.lastSeq(lane.id);
    await run("systemd-run", hostCommand(lane, config, undefined, undefined, "", file), { env: { CONTEXTLANES_LANE_TOKEN: store.mintLaneToken(lane.id) } });
    this.launched.set(lane.id, { at: Date.now(), since });
    this.watch(lane, since);
  }

  /**
   * Hosts are transient units with no automatic restart, so one killed by the kernel (out of memory) or by
   * a machine restart just goes quiet. Run every minute: a working or waiting lane whose host is neither on
   * the socket, nor just started, nor an active unit, fails with a reason the owner can act on.
   */
  async sweep(connected: (id: string) => boolean): Promise<string[]> {
    const { store, run, config } = this.deps;
    if (!config.lanes.launchHosts) return [];
    const failed: string[] = [];
    for (const lane of store.listLanes().filter((l) => (l.state === "working" || l.state === "needs_you") && !connected(l.id) && !this.starting(l.id))) {
      const active = await run("systemctl", ["--user", "is-active", "--quiet", lane.hostUnit ?? hostUnit(lane.id)], { timeout: 10_000 }).then(() => true, () => false);
      const now = store.getLane(lane.id);
      if (active || connected(lane.id) || !now || !["working", "needs_you"].includes(now.state)) continue;
      this.emit(store.setLaneState(lane.id, "failed", "The agent's host stopped: it may have run out of memory, or the machine restarted. Restart the agent to continue from the checkout as it is."));
      failed.push(lane.id);
    }
    return failed;
  }

  /** True until the agent reports in, for at most 90 seconds after this daemon started its host: the watchdog's window. */
  starting(id: string): boolean {
    const launch = this.launched.get(id);
    if (!launch || Date.now() - launch.at >= 90_000) return false;
    return !this.deps.store.eventsOfType(["agent.session"], { lanes: [id], afterSeq: launch.since }).length;
  }

  /** Stops the lane's agent and starts it again from its first task, with a new token. Its checkout is untouched. */
  async restart(id: string): Promise<Lane> {
    const { store, config, run } = this.deps;
    const lane = store.getLane(id);
    if (!lane) throw new NotFound("no such lane");
    if (!["working", "needs_you", "failed"].includes(lane.state)) throw new Refused("Only a working, waiting or failed lane's agent can be restarted.");
    await run("systemctl", ["--user", "stop", lane.hostUnit ?? hostUnit(lane.id)], { timeout: 30_000 }).catch(() => {});
    await run("systemctl", ["--user", "reset-failed", lane.hostUnit ?? hostUnit(lane.id)], { timeout: 10_000 }).catch(() => {});
    const first = store.eventsOfType(["agent.message"], { lanes: [id] }).find((e) => e.payload.role === "user")?.payload.text ?? lane.task;
    const notes = await readFile(join(config.paths.data, "notes", `${lane.project}.md`), "utf8").catch(() => "");
    this.emit(store.appendEvent(id, { type: "agent.error", payload: { message: "Agent restarted by you. It starts again from the lane's first task and the checkout as it is now." } }));
    await this.relaunch(store.getLane(id)!, taskText(lane, undefined, `This lane's earlier agent session ended. Look at the checkout first (git status, git log) and continue from where it is.\n\n${first}`, notes));
    return store.getLane(id)!;
  }

  /**
   * Starts a new agent session on a lane whose old host is stopped (restart, hand off). What the old session
   * still owed is closed first: a stop or a mode change queued for it must not reach the new one, and a
   * permission only the old host could resolve leaves the inbox. Messages the owner wrote are kept and
   * delivered to the new session. If the new host cannot start, the lane fails and says why.
   */
  async relaunch(lane: Lane, text: string): Promise<void> {
    const { store } = this.deps;
    const id = lane.id;
    for (const c of store.pendingCommands(id)) if (c.payload.command.kind !== "prompt") this.emit(store.appendEvent(id, { type: "agent.command.result", payload: { commandId: c.payload.commandId, ok: false, error: "The agent was restarted before this reached it." } }));
    for (const item of store.inbox().filter((i) => i.lane === id && (i.kind === "permission" || i.kind === "question"))) {
      const requestId = item.id.slice(item.id.indexOf("#") + 1);
      if (store.permission(id, requestId) && !store.answered(id, requestId)) this.emit(store.appendEvent(id, { type: "permission.answered", payload: { requestId, optionId: null, by: "web" } }));
    }
    if (["failed", "needs_you"].includes(store.getLane(id)!.state)) this.emit(store.setLaneState(id, "working", "agent restarted"));
    try {
      await this.launch(store.getLane(id)!, text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit(store.setLaneState(id, "failed", `The agent could not be started again: ${message}`));
      throw new Refused(`The agent could not be started again: ${message}`);
    }
  }

  /**
   * Agent hosts fail quietly (wrong login, a missing command, a refused token); after 90 seconds without
   * the agent reporting in, the lane says so, with the host's last log lines, instead of "working" forever.
   */
  private watch(lane: Lane, since: number): void {
    const { store, run } = this.deps;
    const unit = lane.hostUnit ?? hostUnit(lane.id);
    const timer = setTimeout(() => void (async () => {
      if (store.eventsOfType(["agent.session"], { lanes: [lane.id], afterSeq: since }).length) return;
      const current = store.getLane(lane.id);
      if (!current || !["working", "needs_you"].includes(current.state)) return;
      const active = await run("systemctl", ["--user", "is-active", "--quiet", unit], { timeout: 10_000 }).then(() => true, () => false);
      const log = await run("journalctl", ["--user", "-u", unit, "-n", "12", "--no-pager", "-o", "cat"], { timeout: 10_000 }).then((r) => r.stdout.trim(), () => "");
      const tail = log ? `\n\nLast lines from the agent's host:\n${log.split("\n").slice(-12).join("\n")}` : "";
      if (active) this.emit(store.appendEvent(lane.id, { type: "agent.error", payload: { message: `The agent has not connected after 90 seconds. It may be waiting for a login, or ContextLanes refused it. Restart the agent from the lane's panel.${tail}` } }));
      else this.emit(store.setLaneState(lane.id, "failed", `The agent stopped before it connected.${tail}`));
    })().catch((err) => console.error(`Watching ${lane.id} failed:`, err)), 90_000);
    timer.unref();
  }

  private emit(e: ReturnType<Store["appendEvent"]>): void {
    this.deps.bus.publish(e);
  }
}

/** The agent's first message: the project notes (unless a baseline lane), then the task, the handoff or the adoption brief. */
export function taskText(lane: Lane, adoption?: ServiceProposal, firstPrompt?: string, notes = ""): string {
  const asked = firstPrompt ? firstPrompt : adoption ? `${lane.task}\n\nPropose a .contextlanes.json service from this observed process. Keep the outside copy running. Adapt paths to the lane's worktree, replace its observed port with a free $PORT and bind to 127.0.0.1. Request the owner's normal recipe approval before starting the copy. Observed data: ${JSON.stringify(adoption)}` : lane.task;
  // Project notes are what every lane starts with (Insights → What every lane starts with).
  return notes.trim() ? `Project notes from the owner. Keep to them unless the task says otherwise:\n${notes.trim()}\n\n---\n\n${asked}` : asked;
}

/** systemd-run arguments for a lane host. Kept separate so it can be tested and documented. */
export function hostCommand(lane: Lane, config: Config, adoption?: ServiceProposal, firstPrompt?: string, notes = "", taskFile?: string): string[] {
  const task = taskText(lane, adoption, firstPrompt, notes);
  const toolbox = { name: "contextlanes", command: config.lanes.toolbox.command, args: config.lanes.toolbox.args,
    env: Object.entries({ ...config.lanes.toolbox.env, CONTEXTLANES_LANE: lane.id, CONTEXTLANES_URL: `http://127.0.0.1:${config.listen.port}` }).map(([name, value]) => ({ name, value })) };
  return ["--user", `--unit=${lane.hostUnit ?? hostUnit(lane.id)}`, "--collect", `--working-directory=${lane.worktree}`,
    `--setenv=PATH=${process.env.PATH ?? "/usr/bin:/bin"}`, "--setenv=CONTEXTLANES_LANE_TOKEN", ...Object.entries(config.lanes.host.env ?? {}).map(([key, value]) => `--setenv=${key}=${value}`),
    // name=value keeps a task that starts with "-" a value; $$ keeps systemd from expanding $ in the task or JSON.
    ...[...sandbox(config, { socket: true }), config.lanes.host.command, ...config.lanes.host.args, `--lane=${lane.id}`, taskFile ? `--task-file=${taskFile}` : `--task=${task}`, `--agent=${lane.agent}`,
      `--socket=${socketPath(config)}`, `--mode=${lane.mode}`,
      `--toolbox=${JSON.stringify(toolbox)}`, ...(lane.model ? [`--model=${lane.model}`] : []),
      ...(config.agents[lane.agent] ? [`--agent-spec=${JSON.stringify(config.agents[lane.agent])}`] : [])].map((arg) => arg.replaceAll("$", "$$$$"))];
}

export class NotFound extends Error {}

/** The request was understood but cannot happen now; the message says why, in plain words. */
export class Refused extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}
