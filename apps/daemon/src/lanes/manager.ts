import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { laneColour, laneId, StartLaneRequest, type Lane } from "@contextlanes/protocol";
import type { EventBus } from "../bus.js";
import type { Config } from "../config.js";
import type { Store } from "../db/store.js";
import type { Runner } from "../run.js";
import { Terminals } from "../terminal/tmux.js";
import { branchName, hostUnit, terminalSession, worktreePath } from "./naming.js";

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

  async start(input: unknown): Promise<Lane> {
    const req = StartLaneRequest.parse(input);
    const { store, config } = this.deps;
    const project = store.getProject(req.project);
    if (!project) throw new NotFound(`no project ${req.project}`);
    const active = store.listLanes().filter((l) => ["setting_up", "working", "needs_you"].includes(l.state));
    if (active.length >= config.lanes.maxConcurrent) throw new Error("maximum concurrent lanes reached");

    const n = store.nextLaneNumber(project.id);
    const id = laneId(project.id, n);
    const lane = store.insertLane({
      id,
      n,
      project: project.id,
      goal: req.goal ?? null,
      task: req.task,
      agent: req.agent,
      model: req.model ?? null,
      mode: req.mode,
      branch: branchName(n, req.task),
      worktree: worktreePath(config.paths.lanes, project.id, n, req.task),
      terminal: terminalSession(id),
      state: "draft",
      colour: laneColour(n),
    });
    this.emit(store.appendEvent(id, { type: "lane.created", payload: { task: lane.task, agent: lane.agent, branch: lane.branch, worktree: lane.worktree } }));
    this.emit(store.setLaneState(id, "setting_up"));

    try {
      await mkdir(dirname(lane.worktree), { recursive: true });
      await this.deps.run("git", ["worktree", "add", "-b", lane.branch, lane.worktree, req.base], { cwd: project.path });
      await this.terminals.create(lane.terminal, lane.worktree, { CONTEXTLANES_LANE: id });
      if (config.lanes.launchHosts) await this.deps.run("systemd-run", hostCommand(lane, config));
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
export function hostCommand(lane: Lane, config: Config): string[] {
  const toolbox = { name: "contextlanes", command: config.lanes.toolbox.command, args: config.lanes.toolbox.args,
    env: Object.entries({ ...config.lanes.toolbox.env, CONTEXTLANES_LANE: lane.id, CONTEXTLANES_URL: `http://127.0.0.1:${config.listen.port}` }).map(([name, value]) => ({ name, value })) };
  return ["--user", `--unit=${hostUnit(lane.id)}`, "--collect", `--working-directory=${lane.worktree}`,
    `--setenv=PATH=${process.env.PATH ?? "/usr/bin:/bin"}`, ...Object.entries(config.lanes.host.env ?? {}).map(([key, value]) => `--setenv=${key}=${value}`),
    config.lanes.host.command, ...config.lanes.host.args, "--lane", lane.id, "--task", lane.task, "--agent", lane.agent,
    "--socket", join(config.paths.data, "lanes.sock"), "--mode", lane.mode,
    "--toolbox", JSON.stringify(toolbox), ...(lane.model ? ["--model", lane.model] : []),
    ...(config.agents[lane.agent] ? ["--agent-spec", JSON.stringify(config.agents[lane.agent])] : [])];
}

export class NotFound extends Error {}
