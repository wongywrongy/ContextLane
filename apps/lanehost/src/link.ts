import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { CommandEnvelope, type NewLaneEvent } from "@contextlanes/protocol";

/** Keeps observations until the daemon acknowledges their durable event IDs. */
export class DaemonLink {
  private socket?: Socket;
  private timer?: ReturnType<typeof setTimeout>;
  private ready = false;
  private stopped = false;
  private readonly pending = new Map<string, object>();
  private readonly drained = new Set<() => void>();

  constructor(private readonly opts: { lane: string; token: string; path: string; command: (message: CommandEnvelope) => void }) {}

  start(): void {
    if (this.stopped) return;
    const socket = this.socket = createConnection(this.opts.path);
    socket.on("connect", () => socket.write(`${JSON.stringify({ hello: this.opts.lane, token: this.opts.token })}\n`));
    socket.on("error", () => socket.destroy());
    createInterface({ input: socket }).on("error", () => socket.destroy()).on("line", (line) => {
      try {
        const msg = JSON.parse(line) as { ready?: boolean; ack?: string; error?: string };
        if (msg.ready) {
          this.ready = true;
          for (const frame of this.pending.values()) socket.write(`${JSON.stringify(frame)}\n`);
        } else if (msg.ack) {
          this.pending.delete(msg.ack);
          if (this.pending.size === 0) { for (const done of this.drained) done(); this.drained.clear(); }
        } else if (msg.error) {
          console.error(`Daemon refused a host message: ${msg.error}`);
        } else this.opts.command(CommandEnvelope.parse(msg));
      } catch (err) { console.error("Invalid daemon message", err); }
    });
    socket.on("close", () => {
      this.ready = false;
      if (!this.stopped) this.timer = setTimeout(() => this.start(), 250);
    });
  }

  emit(event: NewLaneEvent): void {
    const eventId = randomUUID();
    const frame = { eventId, event };
    this.pending.set(eventId, frame);
    if (this.ready) this.socket?.write(`${JSON.stringify(frame)}\n`);
  }

  flush(): Promise<void> {
    return this.pending.size === 0 ? Promise.resolve() : new Promise((resolve) => this.drained.add(resolve));
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.destroy();
    for (const done of this.drained) done();
    this.drained.clear();
  }
}
