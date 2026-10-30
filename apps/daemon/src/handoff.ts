import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Lane, LaneEvent } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Config } from "./config.js";
import type { Store } from "./db/store.js";
import type { HostLinks } from "./hosts.js";
import { hostCommand, NotFound, Refused, type LaneManager } from "./lanes/manager.js";
import { hostUnit } from "./lanes/naming.js";
import { handoffFrom } from "./outside.js";
import type { Runner } from "./run.js";

const ASK = `Write a handoff for a fresh session that will continue this lane's work in the same checkout. Plain text, under 400 words: the task, what is done (files and decisions), what is left in order, anything that failed and why, and rules the next session must keep. Do not use tools; reply with the handoff only.`;

/**
 * Fresh session and hand off (Work inspector, 4.1): the lane's agent writes a handoff, its session ends,
 * and a new session of the same or another agent starts in the same checkout from that handoff. Fork: a
 * new lane from this lane's branch and uncommitted changes, starting from a handoff built from its history.
 */
export class Handoffs {
  private busy = new Set<string>();
  constructor(private deps: { config: Config; store: Store; bus: EventBus; hosts: HostLinks; lanes: LaneManager; run: Runner; waitMs?: number }) {}

  private all(lane: string): LaneEvent[] {
    const out: LaneEvent[] = [];
    for (;;) { const page = this.deps.store.events(lane, out.at(-1)?.seq ?? 0); if (!page.length) return out; out.push(...page); }
  }
  private async keep(lane: Lane, text: string): Promise<string> {
    const file = join(this.deps.config.paths.data, "handoffs", lane.project, `${lane.id.split("/")[1]}-${Date.now()}.md`);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, text, { mode: 0o600 });
    return file;
  }

  /** Asks the lane's agent for its handoff and waits for the turn to end (at most five minutes). */
  private async askForHandoff(lane: Lane): Promise<string> {
    const before = this.all(lane.id).at(-1)?.seq ?? 0;
    const sent = this.deps.hosts.command(lane.id, { kind: "prompt", text: ASK, immediate: false, files: [], images: [] });
    if (!sent.delivered) throw new Refused("The lane's agent is not connected, so it cannot write a handoff. Use Fork instead, which builds one from the lane's history.");
    const deadline = Date.now() + (this.deps.waitMs ?? 300_000);
    for (;;) {
      const after = this.all(lane.id).filter((e) => e.seq > before);
      const end = after.findIndex((e) => e.type === "agent.turn" && !e.payload.active && e.payload.commandId === sent.commandId);
      if (end >= 0) {
        const text = after.slice(0, end).filter((e): e is Extract<LaneEvent, { type: "agent.message" }> => e.type === "agent.message" && e.payload.role === "agent").map((e) => e.payload.text).join("").trim();
        if (!text) throw new Refused("The agent ended its turn without writing a handoff.");
        return text;
      }
      if (Date.now() > deadline) throw new Refused("The agent did not finish its handoff within five minutes.");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** Fresh session (agent unchanged) or hand off (another agent). Runs in the background; progress shows as events. */
  async replace(id: string, to: { agent?: string; model?: string; note?: string }): Promise<{ started: true }> {
    const { store, bus, config, run } = this.deps;
    const lane = store.getLane(id);
    if (!lane) throw new NotFound("no such lane");
    if (!["working", "needs_you"].includes(lane.state)) throw new Refused("Only a working lane can start a fresh session.");
    if (to.agent && !config.agents[to.agent] && !["claude-code", "codex", "opencode"].includes(to.agent)) throw new Refused(`There is no agent called ${to.agent}.`);
    if (this.busy.has(id)) throw new Refused("A handoff is already being written for this lane.");
    this.busy.add(id);
    void (async () => {
      try {
        const handoff = `${await this.askForHandoff(lane)}${to.note ? `\n\nFrom the owner: ${to.note}` : ""}`;
        const file = await this.keep(lane, handoff);
        const agent = to.agent ?? lane.agent;
        const model = to.model ?? (to.agent ? null : lane.model);
        await run("systemctl", ["--user", "stop", lane.hostUnit ?? hostUnit(lane.id)]).catch(() => {});
        if (agent !== lane.agent || model !== lane.model) store.setLaneAgent(lane.id, agent, model);
        bus.publish(store.appendEvent(lane.id, { type: "lane.handoff", payload: { from: lane.agent, to: agent, model, chars: handoff.length, file } }));
        const next = store.getLane(lane.id)!;
        const first = `You are continuing lane ${lane.id} in this checkout from a handoff written by the previous session (${lane.agent}). Check the files rather than assuming.\n\n${handoff}`;
        await run("systemd-run", hostCommand(next, config, undefined, first, ""), { env: { CONTEXTLANES_LANE_TOKEN: store.mintLaneToken(lane.id) } });
      } catch (err) {
        bus.publish(store.appendEvent(id, { type: "agent.error", payload: { message: `Handoff stopped: ${err instanceof Error ? err.message : String(err)}` } }));
      } finally { this.busy.delete(id); }
    })();
    return { started: true };
  }

  /** A new lane from this lane's branch and its uncommitted changes, starting from a handoff built from its history. */
  async fork(id: string, to: { agent?: string; model?: string; note?: string }): Promise<Lane> {
    const { store, bus, lanes, run } = this.deps;
    const lane = store.getLane(id);
    if (!lane) throw new NotFound("no such lane");
    const messages = this.all(id).filter((e): e is Extract<LaneEvent, { type: "agent.message" }> => e.type === "agent.message").map((e) => ({ role: e.payload.role === "user" ? "user" as const : "agent" as const, text: e.payload.text }));
    const handoff = handoffFrom(messages.length ? messages : [{ role: "user", text: lane.task }], lane.worktree).replace("a session that ran outside ContextLanes in", "lane").replace("Its uncommitted changes have been copied into this checkout.", `This is a fork of lane ${lane.id}; its commits and uncommitted changes are in this checkout.`);
    const first = `${handoff}${to.note ? `\n\nFrom the owner: ${to.note}` : ""}`;
    const file = await this.keep(lane, first);
    const fork = await lanes.start({ project: lane.project, task: `Fork of ${lane.id.split("/")[1]}: ${lane.task}`.slice(0, 300), agent: to.agent ?? lane.agent, model: to.model ?? (to.agent ? undefined : lane.model ?? undefined), base: lane.branch, goal: lane.goal ?? undefined }, {
      firstPrompt: first,
      prepare: async (l) => {
        const patch = (await run("git", ["diff", "--binary", "HEAD"], { cwd: lane.worktree })).stdout;
        // The patch goes where the sandboxed git can read it (the lanes folder), not the data folder.
        if (patch.trim()) { const dir = join(this.deps.config.paths.lanes, ".attachments", "fork"); await mkdir(dir, { recursive: true, mode: 0o700 }); const p = join(dir, `${l.id.replace("/", "-")}.patch`); await writeFile(p, patch, { mode: 0o600 }); await run("git", ["apply", "--whitespace=nowarn", p], { cwd: l.worktree }); }
        for (const f of (await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: lane.worktree })).stdout.split("\0").filter(Boolean)) { await mkdir(dirname(join(l.worktree, f)), { recursive: true }); await copyFile(join(lane.worktree, f), join(l.worktree, f)); }
      },
    });
    bus.publish(store.appendEvent(id, { type: "lane.forked", payload: { from: id, to: fork.id } }));
    return fork;
  }
}
