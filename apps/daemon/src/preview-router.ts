import { createServer, ServerResponse, type IncomingMessage } from "node:http";
import { createProxyServer } from "http-proxy-3";
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
 * Proxying is http-proxy-3 (what Vite's own dev server uses): the Host header is passed through unchanged,
 * so the daemon's own checks (which refuse anything but localhost for local setup) still see the name the
 * browser used, upgrades (hot reload) are piped as they are, and x-forwarded-* are added to what a proxy
 * in front already set.
 */
export class PreviewRouter {
  /** label → where it goes: 127.0.0.1 and a port on the host, a lane container's name and its port in Docker. */
  private readonly routes = new Map<string, { host: string; port: number }>();
  private readonly connections = new Set<Socket>();
  private ready?: Promise<number>;
  private readonly proxy = createProxyServer({ xfwd: true, changeOrigin: false, ws: true });
  private readonly server = createServer((req, res) => {
    const to = this.target(req);
    if (!to) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(ROUTER_NOT_FOUND); return; }
    this.proxy.web(req, res, { target: `http://${to.host}:${to.port}` });
  });

  constructor(private port: number, private readonly bind: string, private readonly suffixes: () => string[]) {
    this.proxy.on("error", (_err, _req, out) => {
      if (out instanceof ServerResponse) {
        if (!out.headersSent) out.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        out.end("ContextLanes: the preview is not answering. Is the service running?");
      } else (out as Socket | undefined)?.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    this.server.on("connection", (socket) => { this.connections.add(socket); socket.on("close", () => this.connections.delete(socket)); });
    this.server.on("upgrade", (req, socket: Socket, head) => {
      socket.on("error", () => socket.destroy());
      const to = this.target(req);
      if (!to) { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
      this.proxy.ws(req, socket, head, { target: `http://${to.host}:${to.port}` });
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

  /** host: 127.0.0.1 by default; in the Docker runtime a lane container's name on the contextlanes network. */
  set(label: string, port: number, host = "127.0.0.1"): void {
    if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host)) throw new Error(`Not a route target: ${host}`);
    this.routes.set(label.toLowerCase(), { host, port });
  }
  /** Where a label goes, as host:port. */
  targetOf(label: string): string | null { const t = this.routes.get(label.toLowerCase()); return t ? `${t.host}:${t.port}` : null; }
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

  private target(req: IncomingMessage): { host: string; port: number } | undefined {
    const label = this.labelOf(req.headers.host);
    return label ? this.routes.get(label) : undefined;
  }

  close(): void {
    this.server.close();
    this.proxy.close();
    for (const socket of this.connections) socket.destroy();
  }
}
