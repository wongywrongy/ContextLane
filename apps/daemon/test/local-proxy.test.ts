import { createServer, get } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { LocalProxy } from "../src/local-proxy.js";
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
it("routes separate named origins, forwards upgrades, and closes unpublished routes", async () => {
  const upstream = createServer((req, res) => res.end(`${req.method} ${req.url}`));
  upstream.on("upgrade", (req, socket, head) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n");
    if (head.length) socket.write(head);
    socket.on("data", data => socket.write(data));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  cleanup.push(() => { upstream.close(); upstream.closeAllConnections(); });
  const proxy = new LocalProxy(0); cleanup.push(() => proxy.close());
  const url = new URL(await proxy.publish("web--01--shop.localhost", (upstream.address() as { port: number }).port));
  const fetchHost = (host: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    get(`http://127.0.0.1:${url.port}/hot?x=1`, { headers: { host } }, res => { let body = ""; res.on("data", d => body += d); res.on("end", () => resolve({ status: res.statusCode!, body })); }).on("error", reject);
  });
  expect(await fetchHost(url.host)).toEqual({ status: 200, body: "GET /hot?x=1" });
  expect((await fetchHost("unknown.localhost" )).status).toBe(404);
  await new Promise<void>((resolve, reject) => {
    const req = get(`http://127.0.0.1:${url.port}/ws`, { headers: { host: url.host, Connection: "Upgrade", Upgrade: "test" } });
    req.on("upgrade", (res, socket) => { expect(res.statusCode).toBe(101); socket.once("data", data => { expect(data.toString()).toBe("hot reload"); socket.destroy(); resolve(); }); socket.write("hot reload"); });
    req.on("error", reject);
  });
  proxy.unpublish(url.href);
  expect((await fetchHost(url.host)).status).toBe(404);
});
