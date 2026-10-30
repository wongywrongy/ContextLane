import { readFile } from "node:fs/promises";
import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Skills } from "../skills.js";
import { laneColour, laneId, StartLaneRequest, type Lane, type ServiceProposal } from "@contextlanes/protocol";
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
    const { lane, id } = await this.serial(async () => {
      const active = store.listLanes().filter((l) => ["setting_up", "working", "needs_you"].includes(l.state));
      if (active.length >= config.lanes.maxConcurrent) throw new Refused(`${active.length} lanes are already running, the most this machine allows. Finish or pause one, or raise the limit in Settings.`);

      if (config.lanes.launchHosts) await requireSandbox(this.deps.run, config);

      const n = store.nextLaneNumber(project.id);
      const id = laneId(project.id, n);
      const names = await this.freeNames(project.path, project.id, id, n, req.task);
      const lane = store.insertLane({
        id,
        n,
        project: project.id,
        goal: req.goal ?? null,
        task: req.task,
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
      this.emit(store.setLaneState(id, "setting_up"));
      return { lane, id };
    });

    try {
      await mkdir(dirname(lane.worktree), { recursive: true });
      await this.deps.run("git", ["worktree", "add", "-b", lane.branch, lane.worktree, req.base], { cwd: project.path });
      await extra.prepare?.(lane);
      // Shared skills (4.6) go in before the agent starts, so it sees them from its first turn. A baseline bench lane gets none.
      // A skill that fails to copy is reported, not fatal: the lane still works without it.
      if (!req.baseline) await new Skills({ config, store, run: this.deps.run }).install(lane).catch((err: Error) => this.emit(store.appendEvent(id, { type: "agent.error", payload: { message: `Project skills were not copied: ${err.message}` } })));
      await this.terminals.create(lane.terminal, lane.worktree, { CONTEXTLANES_LANE: id });
      // Through the environment, not arguments: every process on the machine can read arguments.
      if (config.lanes.launchHosts) await this.deps.run("systemd-run", hostCommand(lane, config, req.adoption, extra.firstPrompt, req.baseline ? "" : await readFile(join(config.paths.data, "notes", `${project.id}.md`), "utf8").catch(() => "")), { env: { CONTEXTLANES_LANE_TOKEN: store.mintLaneToken(id) } });
      if (store.getLane(id)!.state === "setting_up") this.emit(store.setLaneState(id, "working"));
      if (store.getLane(id)!.state === "working" && store.inbox().some((i) => i.lane === id && i.kind === "permission")) this.emit(store.setLaneState(id, "needs_you"));
    } catch (err) {
      this.emit(store.setLaneState(id, "failed", err instanceof Error ? err.message : String(err)));
    }
    return store.getLane(id)!;
  }

  private emit(e: ReturnType<Store["appendEvent"]>): void {
    this.deps.bus.publish(e);
  }
}

/** systemd-run arguments for a lane host. Kept separate so it can be tested and documented. */
export function hostCommand(lane: Lane, config: Config, adoption?: ServiceProposal, firstPrompt?: string, notes = ""): string[] {
  const asked = firstPrompt ? firstPrompt : adoption ? `${lane.task}\n\nPropose a .contextlanes.json service from this observed process. Keep the outside copy running. Adapt paths to the lane's worktree, replace its observed port with a free $PORT and bind to 127.0.0.1. Request the owner's normal recipe approval before starting the copy. Observed data: ${JSON.stringify(adoption)}` : lane.task;
  // Project notes are what every lane starts with (Insights → What every lane starts with).
  const task = notes.trim() ? `Project notes from the owner. Keep to them unless the task says otherwise:\n${notes.trim()}\n\n---\n\n${asked}` : asked;
  const toolbox = { name: "contextlanes", command: config.lanes.toolbox.command, args: config.lanes.toolbox.args,
    env: Object.entries({ ...config.lanes.toolbox.env, CONTEXTLANES_LANE: lane.id, CONTEXTLANES_URL: `http://127.0.0.1:${config.listen.port}` }).map(([name, value]) => ({ name, value })) };
  return ["--user", `--unit=${lane.hostUnit ?? hostUnit(lane.id)}`, "--collect", `--working-directory=${lane.worktree}`,
    `--setenv=PATH=${process.env.PATH ?? "/usr/bin:/bin"}`, "--setenv=CONTEXTLANES_LANE_TOKEN", ...Object.entries(config.lanes.host.env ?? {}).map(([key, value]) => `--setenv=${key}=${value}`),
    // name=value keeps a task that starts with "-" a value; $$ keeps systemd from expanding $ in the task or JSON.
    ...[...sandbox(config, { socket: true }), config.lanes.host.command, ...config.lanes.host.args, `--lane=${lane.id}`, `--task=${task}`, `--agent=${lane.agent}`,
      `--socket=${socketPath(config)}`, `--mode=${lane.mode}`,
      `--toolbox=${JSON.stringify(toolbox)}`, ...(lane.model ? [`--model=${lane.model}`] : []),
      ...(config.agents[lane.agent] ? [`--agent-spec=${JSON.stringify(config.agents[lane.agent])}`] : [])].map((arg) => arg.replaceAll("$", "$$$$"))];
}

export class NotFound extends Error {}

/** The request was understood but cannot happen now; the message says why, in plain words. */
export class Refused extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}
