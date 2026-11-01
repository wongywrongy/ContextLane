import { createServer, request, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";

/** An isolated preview origin can reach only a port explicitly published by this daemon. */
export class LocalProxy {
  private routes = new Map<string, number>();
  private connections = new Set<Socket>();
  private server = createServer((req, res) => {
    const port = this.target(req);
    if (!port) { res.writeHead(404).end("No running preview for this name."); return; }
    const upstream = request({ hostname: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers }, (reply) => { res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res); });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Preview unavailable."); });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  private ready?: Promise<void>;
  constructor(private port: number) {
    this.server.on("connection", (socket) => { this.connections.add(socket); socket.on("close", () => this.connections.delete(socket)); });
    this.server.on("upgrade", (req, socket, head) => {
      const port = this.target(req);
      if (!port) { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
      const upstream = request({ hostname: "127.0.0.1", port, path: req.url, headers: req.headers });
      upstream.on("upgrade", (reply, peer, received) => {
        socket.write(`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n${Object.entries(reply.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\r\n")}\r\n\r\n`);
        if (received.length) socket.write(received);
        if (head.length) peer.write(head);
        peer.pipe(socket); socket.pipe(peer);
        socket.on("error", () => peer.destroy()); peer.on("error", () => socket.destroy());
        socket.on("close", () => peer.destroy()); peer.on("close", () => socket.destroy());
      });
      upstream.on("response", (reply) => { reply.resume(); socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      upstream.end();
    });
    this.server.unref();
  }
  private target(req: IncomingMessage) { return this.routes.get((req.headers.host ?? "").toLowerCase()); }
  async publish(hostname: string, target: number): Promise<string> {
    this.ready ??= new Promise<void>((resolve, reject) => {
      const error = (err: Error) => { this.ready = undefined; reject(err); };
      this.server.once("error", error);
      this.server.listen(this.port, "127.0.0.1", () => { this.server.off("error", error); this.port = (this.server.address() as { port: number }).port; resolve(); });
    });
    await this.ready;
    this.routes.set(`${hostname}:${this.port}`, target);
    return `http://${hostname}:${this.port}`;
  }
  unpublish(url: string): void { this.routes.delete(new URL(url).host); }
  close(): void { this.server.close(); for (const socket of this.connections) socket.destroy(); }
}
