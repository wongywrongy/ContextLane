import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Runtime } from "../runtime.js";
import { Skills } from "../skills.js";
import { agentProfile, featureOff, laneColour, laneId, laneTitle, StartLaneRequest, type Lane, type ServiceProposal } from "@contextlanes/protocol";
import type { EventBus } from "../bus.js";
import type { Config } from "../config.js";
import type { Store } from "../db/store.js";
import type { Runner } from "../run.js";
import { Terminals } from "../terminal/tmux.js";
import { branchName, hostUnit, terminalSession, worktreePath } from "./naming.js";
import { supervisorFor } from "../supervisor/index.js";
import { requireSandbox, sandbox, socketPath } from "../sandbox.js";
import { agentHome, checkCliArgs, launchCli, launchCliDocker, laneCommandDir } from "./cli.js";
import type { DockerLanes } from "../docker/lanes.js";
import { LANE_DIR } from "../docker/names.js";

/**
 * Turns a task into a lane: branch + worktree, a tmux session, then (when enabled) a lane host
 * under systemd that holds the agent's ACP session. Every step is an event.
 */
export class LaneManager {
  private readonly terminals: Terminals;
  /** When each lane's agent host was last started by this daemon, so the UI can say "starting" instead of "not connected". */
  private readonly launched = new Map<string, { at: number; since: number }>();

  constructor(
    /** docker: lane containers, in the Docker runtime (docs/V4.md 3.3). */
    private readonly deps: { store: Store; bus: EventBus; config: Config; run: Runner; docker?: DockerLanes },
  ) {
    this.terminals = new Terminals(deps.run, supervisorFor(deps.config, deps.run));
  }

  /** Lane containers, when this daemon is the Docker runtime's control service. */
  get docker(): DockerLanes | undefined { return this.deps.config.runtime.mode === "docker" ? this.deps.docker : undefined; }

  /** The lane is a container of the Docker runtime (it has lane.container events). */
  inContainer(lane: Pick<Lane, "id">): boolean { return !!this.docker?.isDocker(lane); }

  /** tmux for this lane: inside its container in the Docker runtime, on this machine otherwise. */
  tmux(lane: Pick<Lane, "id" | "worktree">, args: string[], opts: { timeout?: number } = {}): Promise<{ stdout: string }> {
    if (this.docker && this.inContainer(lane)) return this.docker.tmux(lane, args, opts);
    return this.deps.run("tmux", args, opts);
  }

  /**
   * What the owner's shell in a lane starts with: which lane it is, where the daemon listens, and the
   * contextlanes command on PATH, so `contextlanes app start` works there with nothing installed and nothing to name.
   */
  private async terminalEnv(id: string): Promise<Record<string, string>> {
    const { config } = this.deps;
    const env: Record<string, string> = { CONTEXTLANES_LANE: id, CONTEXTLANES_URL: `http://127.0.0.1:${config.listen.port}` };
    const bin = await laneCommandDir(config.paths.data).catch(() => null);
    if (bin) env.PATH = `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
    return env;
  }

  /**
   * The branch a lane was asked to work on, checked before anything is created: it must exist (here or
   * on origin) and not be open in another checkout, since git allows a branch in one place at a time.
   */
  private async existingBranch(repo: string, branch: string | undefined): Promise<{ name: string; remoteOnly: boolean } | null> {
    if (!branch) return null;
    const has = (ref: string) => this.deps.run("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: repo }).then(() => true, () => false);
    const local = await has(`refs/heads/${branch}`);
    if (!local && !await has(`refs/remotes/origin/${branch}`)) throw new Refused(`There is no branch ${branch} in this repository or on origin. Leave the branch out to start a new one.`, 400, "no_branch");
    const open = (await this.deps.run("git", ["worktree", "list", "--porcelain"], { cwd: repo }).then((r) => r.stdout, () => "")).split("\n\n")
      .find((entry) => entry.split("\n").includes(`branch refs/heads/${branch}`));
    if (open) {
      const where = open.split("\n").find((line) => line.startsWith("worktree "))?.slice(9) ?? "another checkout";
      throw new Refused(`${branch} is already open in ${where}, and git allows a branch in one place at a time. Use --here to work in that checkout, or pick another branch.`, 409, "branch_in_use");
    }
    return { name: branch, remoteOnly: !local };
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
    const docker = config.runtime.mode === "docker";
    if (docker && !this.deps.docker) throw new Refused("This control service was started without lane containers.", 503, "docker_unreachable");
    const project = store.getProject(req.project);
    if (!project) throw new NotFound(`no project ${req.project}`);
    // Claude Code and Codex run as their own CLIs; other agents speak ACP. A shell lane runs no agent.
    const kind = req.kind ?? (["claude-code", "codex"].includes(req.agent) ? "cli" : "acp");
    if (kind === "cli") checkCliArgs(req.agent, req.cliArgs ?? []);
    if (kind === "shell" && (req.cliArgs?.length || req.remoteControl || req.auto)) throw new Refused("A lane without an agent takes no agent options.", 400);
    if (req.direct && kind === "acp") throw new Refused("Direct mode requires a CLI or shell lane.", 400);
    if (kind === "acp" && !config.features.acp) throw new Refused(featureOff("acp"), 400, "feature_off");
    if (kind === "acp" && config.supervisor.driver === "process") throw new Refused("ACP lanes run their agent host as a systemd user unit, and this machine runs without systemd. Use Claude Code or Codex, which run as their own CLIs.", 400, "needs_systemd");
    if (req.remoteControl && (kind !== "cli" || req.agent !== "claude-code")) throw new Refused("Remote Control requires a Claude Code CLI lane.", 400);
    if (docker && kind === "acp") throw new Refused("ACP lanes run their agent host as a systemd unit and are not part of the Docker setup. Use Claude Code or Codex, which run as their own CLIs in the lane's container.", 400, "needs_systemd");
    if (docker && req.direct) throw new Refused("--here (a lane in the project folder itself) does not run in the Docker setup yet; a lane gets its own checkout beside the project.", 501, "not_yet");
    const directBranch = req.direct ? (await this.deps.run("git", ["symbolic-ref", "--short", "HEAD"], { cwd: project.path })).stdout.trim() : null;
    if (req.direct && !directBranch) throw new Refused("Direct mode needs a checked-out branch.", 400);
    const ownBranch = req.direct ? null : await this.existingBranch(project.path, req.branch);
    // Agents that act without asking cannot run in a lane: only you approve (AGENTS.md).
    const profile = agentProfile(req.agent);
    if (profile?.support === "unsupported") throw new Refused(`${profile.name} cannot run in a lane: ${profile.note}`);
    // Reserved one at a time, from the limit check to the lane row, so two starts never take the same
    // number or both pass the limit. The slow part (checkout, terminal, agent) runs outside the lock.
    const { lane, id, title } = await this.serial(async () => {
      const active = store.listLanes().filter((l) => ["setting_up", "working", "needs_you"].includes(l.state));
      if (active.length >= config.lanes.maxConcurrent) throw new Refused(`${active.length} lanes are already running, the most this machine allows. Finish or pause one, or raise the limit in Settings.`);

      // The sandbox protects ContextLanes from agent code; a lane with no agent of ours runs none. In the
      // Docker runtime the lane's container is the boundary (docs/V4.md 3.5).
      if (!docker && config.lanes.launchHosts && kind !== "shell") await requireSandbox(this.deps.run, config);

      const n = store.nextLaneNumber(project.id);
      const id = laneId(project.id, n);
      // A task can be a whole plan: lists, the branch and the header use a short title; the agent gets all of it.
      const title = req.title ?? laneTitle(req.task);
      const names = docker
        ? await this.deps.docker!.freeNames(project, n, title, ownBranch?.name ?? null).then((d) => ({ branch: d.branch, worktree: d.worktree, terminal: d.container, hostUnit: null }))
        : await this.freeNames(project.path, project.id, id, n, title);
      const lane = store.insertLane({
        id,
        n,
        project: project.id,
        goal: req.goal ?? null,
        task: title,
        agent: kind === "shell" ? "none" : req.agent,
        kind,
        direct: req.direct,
        remoteControl: req.remoteControl,
        model: req.model ?? null,
        mode: req.mode,
        auto: req.auto,
        effort: req.effort ?? null,
        branch: directBranch ?? ownBranch?.name ?? names.branch,
        worktree: req.direct ? project.path : names.worktree,
        terminal: names.terminal,
        hostUnit: names.hostUnit,
        base: req.base,
        state: "draft",
        colour: laneColour(n),
      });
      this.emit(store.appendEvent(id, { type: "lane.created", payload: { task: lane.task, agent: lane.agent, branch: lane.branch, worktree: lane.worktree, kind, direct: req.direct, remoteControl: req.remoteControl, ...(req.baseline ? { baseline: true } : {}), ...(config.sandbox.mode === "off" && kind !== "shell" ? { sandbox: "off" as const } : {}) } }));
      if (lane.auto) this.emit(store.appendEvent(id, { type: "lane.auto", payload: { on: true } }));
      if (req.adoption) this.emit(store.appendEvent(id, { type: "service.proposed", payload: req.adoption }));
      // The full task is the lane's first message, shown as the first step.
      this.emit(store.appendEvent(id, { type: "agent.message", payload: { role: "user", text: extra.firstPrompt ?? req.task } }));
      this.emit(store.setLaneState(id, "setting_up"));
      return { lane, id, title };
    });

    if (docker) return this.startInContainer(lane, project, req, ownBranch, extra, title);
    try {
      if (!lane.direct) {
        await mkdir(dirname(lane.worktree), { recursive: true });
        // A base that exists only on origin (a pull request's branch) starts from origin's copy; the lane still merges back to its name.
        const local = await this.deps.run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${req.base}`], { cwd: project.path }).then(() => true, () => false);
        const remote = !local && await this.deps.run("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${req.base}`], { cwd: project.path }).then(() => true, () => false);
        // On an existing branch the lane checks that branch out; otherwise it gets a new one from the base.
        if (ownBranch) await this.deps.run("git", ["worktree", "add", ...(ownBranch.remoteOnly ? ["--track", "-b", ownBranch.name, lane.worktree, `origin/${ownBranch.name}`] : [lane.worktree, ownBranch.name])], { cwd: project.path });
        else await this.deps.run("git", ["worktree", "add", "-b", lane.branch, lane.worktree, remote ? `origin/${req.base}` : req.base], { cwd: project.path });
      }
      await extra.prepare?.(lane);
      await new Runtime(this.deps).prepareWorkspace(lane);
      // Shared skills (4.6) go in before the agent starts, so it sees them from its first turn. A baseline bench lane gets none.
      // A skill that fails to copy is reported, not fatal: the lane still works without it.
      if (!req.baseline && !lane.direct) await new Skills({ config, store, run: this.deps.run }).install(lane).catch((err: Error) => this.emit(store.appendEvent(id, { type: "agent.error", payload: { message: `Project skills were not copied: ${err.message}` } })));
      await this.terminals.create(lane.terminal, lane.worktree, await this.terminalEnv(id), lane.kind !== "acp");
      if (config.lanes.launchHosts && lane.kind !== "shell") {
        const notes = req.baseline || lane.kind === "cli" ? "" : await readFile(join(config.paths.data, "notes", `${project.id}.md`), "utf8").catch(() => "");
        // CLI lanes learn the contextlanes command from launchCli (system prompt or AGENTS.md); ACP lanes get the MCP tools.
        const text = taskText(lane, req.adoption, extra.firstPrompt ?? (req.task !== title ? req.task : undefined), notes, req.baseline || lane.kind === "cli" ? "" : toolsHint(config));
        if (lane.kind === "cli") await launchCli(lane, config, this.deps.run, store.mintLaneToken(id), text, req.cliArgs, false, req.baseline, project.path);
        else await this.launch(lane, text);
      }
      if (store.getLane(id)!.state === "setting_up") this.emit(store.setLaneState(id, "working"));
      if (store.getLane(id)!.state === "working" && store.inbox().some((i) => i.lane === id && i.kind === "permission")) this.emit(store.setLaneState(id, "needs_you"));
    } catch (err) {
      this.emit(store.setLaneState(id, "failed", err instanceof Error ? err.message : String(err)));
    }
    return store.getLane(id)!;
  }

  /**
   * The Docker runtime's half of start: checkout, container, mounts, network, terminal and agent, in that
   * order, through DockerLanes, which cleans up after a failed step. An approved recipe's setup runs inside
   * the lane before the agent; project skills read the project's files from the control side and are not copied yet.
   */
  private async startInContainer(lane: Lane, project: NonNullable<ReturnType<Store["getProject"]>>, req: ReturnType<typeof StartLaneRequest.parse>, ownBranch: { name: string; remoteOnly: boolean } | null, extra: { prepare?: (lane: Lane) => Promise<void>; firstPrompt?: string }, title: string): Promise<Lane> {
    const { store, config } = this.deps;
    const id = lane.id;
    try {
      if (extra.prepare) throw new Refused("Taking over changes into a new lane does not run in the Docker setup yet.", 501, "not_yet");
      await this.deps.docker!.create(lane, project, {
        ownBranch, base: req.base,
        launch: async (target) => {
          // An approved recipe's setup runs before the agent, inside the lane, as on the host. A setup that
          // fails is recorded on the lane's app (contextlanes app status) and the lane still starts.
          await new Runtime(this.deps).prepareWorkspace(lane).catch((err: Error) => this.emit(store.appendEvent(id, { type: "env.status", payload: { service: "setup", up: false, state: "failed", detail: err.message.slice(0, 600) } })));
          // Every lane gets its token, so `contextlanes` in the owner's own shell there works too.
          if (!config.lanes.launchHosts || lane.kind !== "cli") { await this.deps.docker!.write(target, `${LANE_DIR}/token`, store.mintLaneToken(id)); return; }
          const text = taskText(lane, req.adoption, extra.firstPrompt ?? (req.task !== title ? req.task : undefined));
          await launchCliDocker(lane, config, this.deps.docker!, target, store.mintLaneToken(id), text, req.cliArgs, false, req.baseline);
        },
      });
      if (store.getLane(id)!.state === "setting_up") this.emit(store.setLaneState(id, "working"));
      if (store.getLane(id)!.state === "working" && store.inbox().some((i) => i.lane === id && i.kind === "permission")) this.emit(store.setLaneState(id, "needs_you"));
    } catch (err) {
      const step = (err as { step?: string }).step;
      const message = err instanceof Error ? err.message : String(err);
      this.emit(store.setLaneState(id, "failed", step ? `Setting up the lane failed at the ${step} step: ${message}` : message));
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
    const privateDir = join(config.paths.data, "acp", lane.id.replace("/", "-"));
    const home = ["claude-code", "codex"].includes(lane.agent) ? await agentHome(lane.agent, privateDir) : {};
    const since = store.lastSeq(lane.id);
    await run("systemd-run", hostCommand(lane, config, undefined, undefined, "", file, store.getProject(lane.project)!.path, home), { env: { CONTEXTLANES_LANE_TOKEN: store.mintLaneToken(lane.id) } });
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
    for (const lane of store.listLanes().filter((l) => (l.state === "working" || l.state === "needs_you") && l.kind !== "shell" && !connected(l.id) && !this.starting(l.id))) {
      if (lane.kind === "cli") {
        if (!await this.cliConnected(lane.id)) { this.emit(store.setLaneState(lane.id, "failed", "The CLI stopped. Restart the agent to resume its session.")); failed.push(lane.id); }
        continue;
      }
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
    if (lane.kind === "shell") throw new Refused("This lane has no agent to restart.", 400);
    if (!["working", "needs_you", "failed"].includes(lane.state)) throw new Refused("Only a working, waiting or failed lane's agent can be restarted.");
    if (lane.kind === "cli") {
      if (this.docker && this.inContainer(lane)) await this.docker.ensureTerminal(lane);
      else if (!await this.terminals.exists(lane.terminal)) await this.terminals.create(lane.terminal, lane.worktree, await this.terminalEnv(id), true);
      this.emit(store.appendEvent(id, { type: "agent.error", payload: { message: "CLI restarted by you; resuming the last session in this checkout." } }));
      await this.relaunch(lane, "");
      return store.getLane(id)!;
    }
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
      const baseline = !!store.eventsOfType(["lane.created"], { lanes: [id] })[0]?.payload.baseline;
      const target = this.docker && this.inContainer(lane) ? this.docker.target(lane) : null;
      if (lane.kind === "cli" && target) await launchCliDocker(store.getLane(id)!, this.deps.config, this.docker!, target, store.mintLaneToken(id), text, undefined, true, baseline);
      else if (lane.kind === "cli") await launchCli(store.getLane(id)!, this.deps.config, this.deps.run, store.mintLaneToken(id), text, undefined, true, baseline, store.getProject(lane.project)!.path);
      else await this.launch(store.getLane(id)!, text);
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

  async cliConnected(id: string): Promise<boolean> {
    const lane = this.deps.store.getLane(id);
    if (!lane || lane.kind !== "cli") return false;
    return this.tmux(lane, ["display-message", "-p", "-t", `=${lane.terminal}:`, "#{pane_dead}"], { timeout: 15_000 }).then((r) => r.stdout.trim() === "0", () => false);
  }
}

/** Optional coordination tools; source files and runnable checks remain authoritative. */
export function toolsHint(config: Config): string {
  const f = config.features;
  const helper = f.helper && config.localModels.some((m) => !m.roles?.length || m.roles.includes("helper"));
  const uses = [
    f.insights ? "get_brief for prior project decisions; verify its claims against source code" : "",
    "ask_owner for decisions requiring owner input",
    "env_start, env_status, get_logs and preview_url to run this lane's copy of the app and check it",
    f.sublanes ? "split_lanes for 2 to 5 independent tasks with separate file ownership and concrete acceptance checks" : "",
    f.review ? "run the agreed checks and use checkpoint when committed work is ready for review" : "",
  ].filter(Boolean);
  return [
    `Optional ContextLanes tools (MCP server "contextlanes"): ${uses.join("; ")}.`,
    helper ? "delegate offers a local model for a narrow read question or the project's approved checks; verify its results." : "",
  ].filter(Boolean).join(" ");
}

/** The agent's first message: the project notes (unless a baseline lane), then the task, the handoff or the adoption brief, then the tools hint. */
export function taskText(lane: Lane, adoption?: ServiceProposal, firstPrompt?: string, notes = "", tools = ""): string {
  const asked = firstPrompt ? firstPrompt : adoption ? `${lane.task}\n\nPropose a .contextlanes.json service from this observed process. Keep the outside copy running. Adapt paths to the lane's worktree, replace its observed port with a free $PORT and bind to 127.0.0.1. Request the owner's normal recipe approval before starting the copy. Observed data: ${JSON.stringify(adoption)}` : lane.task;
  // Project notes are what every lane starts with (Insights → What every lane starts with).
  const body = notes.trim() ? `Project notes from the owner. Keep to them unless the task says otherwise:\n${notes.trim()}\n\n---\n\n${asked}` : asked;
  return tools ? `${body}\n\n---\n\n${tools}` : body;
}

/** systemd-run arguments for a lane host. Kept separate so it can be tested and documented. */
export function hostCommand(lane: Lane, config: Config, adoption?: ServiceProposal, firstPrompt?: string, notes = "", taskFile?: string, repository?: string, agentEnvironment: Record<string, string> = {}): string[] {
  const task = taskText(lane, adoption, firstPrompt, notes);
  const toolbox = { name: "contextlanes", command: config.lanes.toolbox.command, args: config.lanes.toolbox.args,
    env: Object.entries({ ...config.lanes.toolbox.env, CONTEXTLANES_LANE: lane.id, CONTEXTLANES_URL: `http://127.0.0.1:${config.listen.port}` }).map(([name, value]) => ({ name, value })) };
  return ["--user", `--unit=${lane.hostUnit ?? hostUnit(lane.id)}`, "--collect", `--working-directory=${lane.worktree}`,
    `--setenv=PATH=${process.env.PATH ?? "/usr/bin:/bin"}`, "--setenv=CONTEXTLANES_LANE_TOKEN", ...Object.entries({ ...config.lanes.host.env, ...agentEnvironment }).map(([key, value]) => `--setenv=${key}=${value}`),
    // name=value keeps a task that starts with "-" a value; $$ keeps systemd from expanding $ in the task or JSON.
    ...[...sandbox(config, { socket: true, worktree: lane.worktree, providerCredentials: !Object.keys(agentEnvironment).length, ...(repository ? { repository } : {}),
      readable: [join(config.paths.lanes, ".attachments", lane.id.replace("/", "-"))].filter((path) => taskFile || existsSync(path)),
      ...(Object.values(agentEnvironment)[0] ? { agentHome: Object.values(agentEnvironment)[0] } : {}) }), config.lanes.host.command, ...config.lanes.host.args, `--lane=${lane.id}`, taskFile ? `--task-file=${taskFile}` : `--task=${task}`, `--agent=${lane.agent}`,
      `--socket=${socketPath(config)}`, `--mode=${lane.mode}`,
      `--toolbox=${JSON.stringify(toolbox)}`, ...(lane.model ? [`--model=${lane.model}`] : []), ...(lane.effort ? [`--effort=${lane.effort}`] : []),
      ...(config.agents[lane.agent] ? [`--agent-spec=${JSON.stringify(config.agents[lane.agent])}`] : [])].map((arg) => arg.replaceAll("$", "$$$$"))];
}

export class NotFound extends Error {}

/** The request was understood but cannot happen now; the message says why, in plain words. */
export class Refused extends Error {
  /** code: a stable name for callers that act on the reason (the CLI's exit codes), not only show it. */
  constructor(message: string, readonly statusCode = 409, readonly code?: string) { super(message); }
}
