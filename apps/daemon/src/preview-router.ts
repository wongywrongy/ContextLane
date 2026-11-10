import { createServer, request, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";

/** The body every router 404 carries, so a check can tell this router's answer from a proxy's. */
export const ROUTER_NOT_FOUND = "ContextLanes: no running preview for this name.";

/** The part of a Host header that names the site: no port, lower case, no trailing dot. */
export function hostnameOf(host: string | undefined): string {
  const value = (host ?? "").trim().toLowerCase();
  const bare = value.startsWith("[") ? value.slice(0, value.indexOf("]") + 1) : value.replace(/:\d+$/, "");
  return bare.replace(/\.$/, "");
}

/**
 * One port for every preview and the web app. A request reaches a target only when its hostname is
 * exactly `<label>.<suffix>` for a published label and an accepted suffix; anything else gets a 404.
 * The Host header is passed through unchanged, so the daemon's own checks (which refuse anything
 * but localhost for local setup) still see the name the browser used.
 */
export class PreviewRouter {
  private readonly routes = new Map<string, number>();
  private readonly connections = new Set<Socket>();
  private ready?: Promise<number>;
  private readonly server = createServer((req, res) => {
    const port = this.target(req);
    if (!port) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(ROUTER_NOT_FOUND); return; }
    const upstream = request({ hostname: "127.0.0.1", port, path: req.url, method: req.method, headers: this.forwarded(req) }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.statusMessage, reply.headers);
      reply.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }); res.end("ContextLanes: the preview is not answering. Is the service running?"); });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });

  constructor(private port: number, private readonly bind: string, private readonly suffixes: () => string[]) {
    this.server.on("connection", (socket) => { this.connections.add(socket); socket.on("close", () => this.connections.delete(socket)); });
    this.server.on("upgrade", (req, socket: Socket, head) => {
      socket.on("error", () => socket.destroy());
      const port = this.target(req);
      if (!port) { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
      const upstream = request({ hostname: "127.0.0.1", port, path: req.url, method: req.method, headers: this.forwarded(req) });
      upstream.on("upgrade", (reply, peer, received) => {
        const lines = [`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}`];
        for (let i = 0; i < reply.rawHeaders.length; i += 2) lines.push(`${reply.rawHeaders[i]}: ${reply.rawHeaders[i + 1]}`);
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (received.length) socket.write(received);
        if (head.length) peer.write(head);
        peer.pipe(socket); socket.pipe(peer);
        peer.on("error", () => socket.destroy());
        socket.on("close", () => peer.destroy()); peer.on("close", () => socket.destroy());
      });
      upstream.on("response", (reply) => { reply.resume(); socket.end(`HTTP/1.1 ${reply.statusCode ?? 502} ${reply.statusMessage ?? "Bad Gateway"}\r\nConnection: close\r\n\r\n`); });
      upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"));
      upstream.end();
    });
    this.server.unref();
  }

  /** Starts listening once; resolves to the port actually bound. */
  listen(): Promise<number> {
    return this.ready ??= new Promise<number>((resolve, reject) => {
      const error = (err: Error) => { this.ready = undefined; reject(err); };
      this.server.once("error", error);
      this.server.listen(this.port, this.bind, () => {
        this.server.off("error", error);
        this.port = (this.server.address() as { port: number }).port;
        resolve(this.port);
      });
    });
  }

  get boundPort(): number { return this.port; }

  set(label: string, port: number): void { this.routes.set(label.toLowerCase(), port); }
  delete(label: string): void { this.routes.delete(label.toLowerCase()); }
  has(label: string): boolean { return this.routes.has(label.toLowerCase()); }
  labels(): string[] { return [...this.routes.keys()]; }

  /** The label a hostname names, if its suffix is accepted and the rest is exactly one DNS label. */
  labelOf(host: string | undefined): string | null {
    const name = hostnameOf(host);
    for (const suffix of this.suffixes()) {
      if (!name.endsWith(`.${suffix}`)) continue;
      const label = name.slice(0, -suffix.length - 1);
      if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return label;
    }
    return null;
  }

  private target(req: IncomingMessage): number | undefined {
    const label = this.labelOf(req.headers.host);
    return label ? this.routes.get(label) : undefined;
  }

  /** Values a proxy in front already set are kept; otherwise they describe this hop. */
  private forwarded(req: IncomingMessage): IncomingHttpHeaders {
    const headers = { ...req.headers };
    const peer = req.socket.remoteAddress ?? "";
    headers["x-forwarded-for"] = headers["x-forwarded-for"] ? `${headers["x-forwarded-for"]}, ${peer}` : peer;
    headers["x-forwarded-host"] ??= req.headers.host ?? "";
    headers["x-forwarded-proto"] ??= "http";
    return headers;
  }

  close(): void {
    this.server.close();
    for (const socket of this.connections) socket.destroy();
  }
}
