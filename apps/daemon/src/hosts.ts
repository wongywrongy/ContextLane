import { createServer, type Server, type Socket } from "node:net";
import { rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { LaneId, type NewLaneEvent } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Store } from "./db/store.js";

/**
 * Lane hosts connect over a Unix socket and speak JSON lines.
 *   host -> daemon: {"hello": "<lane>"} then {"type": "...", "payload": {...}}
 *   daemon -> host: {"prompt": "..."} | {"answer": {"requestId", "optionId"}} | {"cancel": true}
 */
export class HostLinks {
  private readonly links = new Map<string, Socket>();
  private server: Server | null = null;

  constructor(private readonly deps: { store: Store; bus: EventBus }) {}

  listen(socketPath: string): Promise<void> {
    rmSync(socketPath, { force: true });
    this.server = createServer((sock) => this.accept(sock));
    return new Promise((resolve) => this.server!.listen(socketPath, resolve));
  }

  connected(lane: string): boolean {
    return this.links.has(lane);
  }

  send(lane: string, message: Record<string, unknown>): boolean {
    const sock = this.links.get(lane);
    if (!sock) return false;
    sock.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  close(): void {
    for (const s of this.links.values()) s.destroy();
    this.server?.close();
  }

  private accept(sock: Socket): void {
    let lane: string | null = null;
    createInterface({ input: sock }).on("line", (line) => {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (typeof msg.hello === "string") {
          lane = LaneId.parse(msg.hello);
          this.links.set(lane, sock);
          return;
        }
        if (!lane) throw new Error("hello first");
        const event = this.deps.store.appendEvent(lane, msg as NewLaneEvent);
        this.deps.bus.publish(event);
      } catch (err) {
        sock.write(`${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`);
      }
    });
    sock.on("close", () => {
      if (lane && this.links.get(lane) === sock) this.links.delete(lane);
    });
  }
}
