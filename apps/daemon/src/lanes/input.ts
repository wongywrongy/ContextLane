import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cliPromptText, type NewLaneEvent } from "@contextlanes/protocol";
import type { EventBus } from "../bus.js";
import type { Config } from "../config.js";
import type { Store } from "../db/store.js";
import type { Runner } from "../run.js";
import type { Lane } from "@contextlanes/protocol";
import type { LaneManager } from "./manager.js";
import { LANE_DIR } from "../docker/names.js";

/** lanes: in the Docker runtime a lane's tmux runs in its container (LaneManager.tmux, DockerLanes). */
type Deps = { store: Store; bus: EventBus; config: Config; run: Runner; lanes?: Pick<LaneManager, "tmux" | "inContainer" | "docker"> };

/** CLI input shares the durable command queue with ACP. Only a native Stop makes a lane ready. */
export class CliInputs {
  private running = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  private stopped = false;
  private off: () => void;
  constructor(private deps: Deps) {
    this.off = deps.bus.subscribeAll((e) => { if (e.type === "agent.command" || e.type === "agent.turn") this.wake(e.lane); });
    for (const lane of deps.store.listLanes()) if (lane.kind === "cli") this.wake(lane.id);
  }
  async close(): Promise<void> { this.stopped = true; this.off(); await Promise.all(this.running.values()); }
  private emit(id: string, event: NewLaneEvent): void { this.deps.bus.publish(this.deps.store.appendEvent(id, event)); }
  private done(id: string, commandId: string, ok: boolean, error?: string) { this.emit(id, { type: "agent.command.result", payload: { commandId, ok, ...(error ? { error } : {}) } }); }
  private wake(id: string): void {
    if (this.stopped || this.deps.store.getLane(id)?.kind !== "cli") return;
    if (this.running.has(id)) { this.dirty.add(id); return; }
    const work = this.drain(id).catch((e) => console.error(`CLI input ${id}:`, e)).finally(() => { this.running.delete(id); if (this.dirty.delete(id)) this.wake(id); });
    this.running.set(id, work);
  }
  private tmux(lane: Lane, args: string[]): Promise<{ stdout: string }> {
    return this.deps.lanes?.inContainer(lane) ? this.deps.lanes.tmux(lane, args, { timeout: 10_000 }) : this.deps.run("tmux", args, { timeout: 10_000 });
  }

  private async drain(id: string): Promise<void> {
    const { store, config } = this.deps;
    const lane = store.getLane(id)!;
    if (!["working", "needs_you", "in_review"].includes(lane.state)) return;
    const pending = store.pendingCommands(id);
    for (const event of pending.filter((e) => e.payload.command.kind !== "prompt")) {
      if (this.stopped) return;
      const { command, commandId } = event.payload;
      try {
        if (command.kind !== "cancel") throw new Error("Use the agent's own session commands in its terminal to change settings.");
        await this.tmux(lane, ["send-keys", "-t", `=${lane.terminal}:`, "Escape"]);
        this.done(id, commandId, true);
      } catch (e) { this.done(id, commandId, false, (e as Error).message); }
    }
    const event = pending.find((e) => e.payload.command.kind === "prompt");
    if (!event || this.stopped || event.payload.command.kind !== "prompt") return;
    const { command, commandId } = event.payload;
    const inputs = store.eventsOfType(["agent.input"], { lanes: [id] });
    const recorded = inputs.findLast((e) => e.payload.commandId === commandId);
    // A crash between paste and recording success cannot be replayed safely: never send the same message twice silently.
    if (recorded) { this.done(id, commandId, recorded.payload.phase === "sent", recorded.payload.phase === "sending" ? "Delivery was interrupted. Check the terminal before sending this message again." : undefined); return; }
    const turn = store.eventsOfType(["agent.turn"], { lanes: [id] }).at(-1);
    if (!turn || turn.payload.active) return;
    const previous = inputs.findLast((e) => e.payload.phase === "sending");
    if (previous && previous.seq > turn.seq) {
      const prior = store.eventsOfType(["agent.command"], { lanes: [id] }).find((e) => e.payload.commandId === previous.payload.commandId)?.payload.command;
      if (prior?.kind === "prompt" && !prior.text.trimStart().startsWith("/")) return;
    }
    // In a lane container the message file is written inside it (through stdin), where its tmux can read it.
    const docker = this.deps.lanes?.inContainer(lane) ? this.deps.lanes.docker : undefined;
    const target = docker?.target(lane) ?? null;
    const dir = target ? LANE_DIR : join(config.paths.data, "cli", id.replace("/", "-"));
    const file = target ? `${LANE_DIR}/input-${commandId}.txt` : join(dir, `input-${commandId}.txt`);
    const buffer = `cl-${commandId}`;
    try {
      if (docker && target) await docker.write(target, file, cliPromptText(command));
      else {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(file, cliPromptText(command), { mode: 0o600 });
      }
      this.emit(id, { type: "agent.input", payload: { commandId, phase: "sending" } });
      await this.tmux(lane, ["load-buffer", "-b", buffer, file]);
      await this.tmux(lane, ["paste-buffer", "-d", "-p", "-b", buffer, "-t", `=${lane.terminal}:`]);
      await this.tmux(lane, ["send-keys", "-t", `=${lane.terminal}:`, "Enter"]);
      this.emit(id, { type: "agent.input", payload: { commandId, phase: "sent" } });
      this.done(id, commandId, true);
    } catch (e) { this.done(id, commandId, false, `The message could not be sent. Check the terminal before retrying: ${(e as Error).message}`); }
    finally {
      if (docker && target) await docker.exec(target, ["rm", "-f", file]).catch(() => {});
      else await rm(file, { force: true });
      await this.tmux(lane, ["delete-buffer", "-b", buffer]).catch(() => {});
    }
  }
}
