import { createServer, get, request, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { hostnameOf, PreviewRouter, ROUTER_NOT_FOUND } from "../src/preview-router.js";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup.push(() => { server.close(); server.closeAllConnections(); });
  return (server.address() as { port: number }).port;
}

async function routerFor(suffixes = ["root.example.dev", "localhost"]) {
  const router = new PreviewRouter(0, "127.0.0.1", () => suffixes);
  cleanup.push(() => router.close());
  return { router, port: await router.listen() };
}

type Reply = { status: number; body: string; headers: Record<string, string | string[] | undefined> };
const send = (port: number, host: string, opts: { path?: string; method?: string; body?: Buffer | string; headers?: Record<string, string> } = {}) => new Promise<Reply>((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path: opts.path ?? "/", method: opts.method ?? "GET", headers: { host, ...opts.headers } }, (res) => {
    const chunks: Buffer[] = []; res.on("data", (d: Buffer) => chunks.push(d)); res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString(), headers: res.headers }));
  });
  req.on("error", reject);
  req.end(opts.body);
});

describe("preview router", () => {
  it("reads the hostname from a Host header", () => {
    expect(hostnameOf("Web-01-Shop.Root.Example.dev:443")).toBe("web-01-shop.root.example.dev");
    expect(hostnameOf("web.localhost.")).toBe("web.localhost");
    expect(hostnameOf("[::1]:4601")).toBe("[::1]");
    expect(hostnameOf(undefined)).toBe("");
  });

  it("routes a published label under each accepted suffix, with or without a port", async () => {
    const upstream = await listen(createServer((req, res) => res.end(`${req.method} ${req.url} ${req.headers.host}`)));
    const { router, port } = await routerFor();
    router.set("web-01-shop", upstream);
    expect(await send(port, "web-01-shop.root.example.dev", { path: "/hot?x=1" })).toMatchObject({ status: 200, body: "GET /hot?x=1 web-01-shop.root.example.dev" });
    expect((await send(port, `web-01-shop.localhost:${port}`)).status).toBe(200);
    expect((await send(port, "WEB-01-SHOP.ROOT.EXAMPLE.DEV")).status).toBe(200);
  });

  it("answers 404 with its own body for anything it did not publish", async () => {
    const upstream = await listen(createServer((_req, res) => res.end("app")));
    const { router, port } = await routerFor();
    router.set("web-01-shop", upstream);
    for (const host of ["other.root.example.dev", "web-01-shop.evil.example", "a.web-01-shop.root.example.dev", "root.example.dev", "127.0.0.1", "localhost", "web-01-shop", ""]) {
      const reply = await send(port, host);
      expect(reply, host).toMatchObject({ status: 404, body: ROUTER_NOT_FOUND });
    }
    router.delete("web-01-shop");
    expect((await send(port, "web-01-shop.localhost")).status).toBe(404);
  });

  it("adds forwarded headers and keeps the ones a proxy in front already set", async () => {
    let seen: Record<string, unknown> = {};
    const upstream = await listen(createServer((req, res) => { seen = req.headers; res.end(); }));
    const { router, port } = await routerFor();
    router.set("web-01-shop", upstream);
    await send(port, "web-01-shop.root.example.dev");
    expect(seen).toMatchObject({ host: "web-01-shop.root.example.dev", "x-forwarded-host": "web-01-shop.root.example.dev", "x-forwarded-proto": "http", "x-forwarded-for": "127.0.0.1" });
    await send(port, "web-01-shop.root.example.dev", { headers: { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9", "x-forwarded-host": "outer.example" } });
    expect(seen).toMatchObject({ "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9, 127.0.0.1", "x-forwarded-host": "outer.example" });
  });

  it("carries a 10 MB request body and streams a response as it is written", async () => {
    const upstream = await listen(createServer((req, res) => {
      if (req.url === "/upload") { let size = 0; req.on("data", (d: Buffer) => { size += d.length; }); req.on("end", () => res.end(String(size))); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 150);
    }));
    const { router, port } = await routerFor();
    router.set("api-01-shop", upstream);
    const body = Buffer.alloc(10 * 1024 * 1024, 7);
    expect(await send(port, "api-01-shop.localhost", { path: "/upload", method: "POST", body })).toMatchObject({ status: 200, body: String(body.length) });
    const first = await new Promise<{ chunk: string; at: number; started: number }>((resolve, reject) => {
      const started = Date.now();
      get({ host: "127.0.0.1", port, path: "/events", headers: { host: "api-01-shop.localhost" } }, (res) => {
        res.once("data", (d: Buffer) => { resolve({ chunk: d.toString(), at: Date.now(), started }); res.destroy(); });
      }).on("error", reject);
    });
    expect(first.chunk).toBe("data: one\n\n");
    expect(first.at - first.started).toBeLessThan(140);
  });

  it("forwards WebSocket upgrades both ways", async () => {
    const upstream = createServer((_req, res) => res.end());
    upstream.on("upgrade", (req, socket, head) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\nX-Seen-Host: ${req.headers.host}\r\n\r\n`);
      if (head.length) socket.write(head);
      socket.on("data", (data) => socket.write(data));
    });
    const { router, port } = await routerFor();
    router.set("web-01-shop", await listen(upstream));
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/ws", headers: { host: "web-01-shop.root.example.dev", Connection: "Upgrade", Upgrade: "test" } });
      req.on("upgrade", (res, socket) => {
        expect(res.statusCode).toBe(101);
        expect(res.headers["x-seen-host"]).toBe("web-01-shop.root.example.dev");
        socket.once("data", (data) => { expect(data.toString()).toBe("hot reload"); socket.destroy(); resolve(); });
        socket.write("hot reload");
      });
      req.on("error", reject);
      req.end();
    });
    const refused = await new Promise<string>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/ws", headers: { host: "nope.localhost", Connection: "Upgrade", Upgrade: "test" } });
      req.on("response", (res) => resolve(String(res.statusCode)));
      req.on("upgrade", () => resolve("upgraded"));
      req.on("error", () => resolve("closed"));
      req.end();
    });
    expect(refused).toBe("404");
  });

  it("says when the published service is not answering", async () => {
    const { router, port } = await routerFor();
    const dead = await listen(createServer());
    cleanup.splice(-1)[0]!();
    router.set("web-01-shop", dead);
    expect((await send(port, "web-01-shop.localhost")).status).toBe(502);
  });
});
