import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { HostEvent, LaneId, type LaneCommand, type NewLaneEvent } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Store } from "./db/store.js";

/** Commands and observations are events; reconnect replays only unacknowledged work. */
export class HostLinks {
  private readonly links = new Map<string, Socket>();
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;

  constructor(private readonly deps: { store: Store; bus: EventBus }) {}

  listen(socketPath: string): Promise<void> {
    rmSync(socketPath, { force: true });
    this.server = createServer((sock) => this.accept(sock));
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(socketPath, () => { chmodSync(socketPath, 0o600); resolve(); });
    });
  }

  connected(lane: string): boolean { return this.links.has(lane); }

  send(lane: string, message: Record<string, unknown>): boolean {
    const sock = this.links.get(lane);
    if (!sock || sock.destroyed) return false;
    sock.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  command(lane: string, command: LaneCommand): { commandId: string; delivered: boolean } {
    if (!this.deps.store.getLane(lane)) throw new Error(`no lane ${lane}`);
    const commandId = randomUUID();
    const event = this.deps.store.appendEvent(lane, { type: "agent.command", payload: { commandId, command } });
    this.deps.bus.publish(event);
    return { commandId, delivered: this.send(lane, { commandId, command }) };
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => { if (this.server) this.server.close(() => resolve()); else resolve(); });
  }

  private accept(sock: Socket): void {
    this.sockets.add(sock);
    let lane: string | null = null;
    sock.on("error", () => sock.destroy());
    createInterface({ input: sock }).on("error", () => sock.destroy()).on("line", (line) => {
      try {
        if (line.length > 2_000_000) throw new Error("host message too large");
        const msg = JSON.parse(line) as Record<string, unknown>;
        const { store, bus } = this.deps;
        if (typeof msg.hello === "string") {
          if (lane) throw new Error("already introduced");
          lane = LaneId.parse(msg.hello);
          if (!store.getLane(lane)) throw new Error(`no lane ${lane}`);
          this.links.get(lane)?.destroy();
          this.links.set(lane, sock);
          this.send(lane, { ready: true });
          for (const e of store.pendingCommands(lane)) this.send(lane, e.payload);
          return;
        }
        if (!lane) throw new Error("hello first");
        const body = HostEvent.parse(msg);
        if (!store.eventBySource(lane, body.eventId)) {
          const event = store.appendEvent(lane, body.event as NewLaneEvent, body.eventId);
          bus.publish(event);
          const state = store.getLane(lane)!.state;
          if (event.type === "permission.requested" && state === "working") bus.publish(store.setLaneState(lane, "needs_you"));
          if (event.type === "agent.error" && ["working", "needs_you", "setting_up"].includes(state)) bus.publish(store.setLaneState(lane, "failed", event.payload.message));
        }
        this.send(lane, { ack: body.eventId });
      } catch (err) {
        sock.write(`${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`);
      }
    });
    sock.on("close", () => {
      this.sockets.delete(sock);
      if (lane && this.links.get(lane) === sock) this.links.delete(lane);
    });
  }
}
