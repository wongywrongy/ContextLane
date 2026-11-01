import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const exec = promisify(execFile);
it("prints lane/status JSON and queues exact multiline input from the CLI", async () => {
  const requests: { url: string; body: unknown }[] = [];
  const lane = { id: "shop/01", state: "working", agent: "codex" };
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url!, body: body ? JSON.parse(body) : null });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/api/projects" ? [{ id: "shop" }] : req.url === "/api/projects/shop/lanes" ? [lane] : req.url?.endsWith("/status") ? { lane, plan: [], verdict: null } : {}));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const cli = (...args: string[]) => exec(process.execPath, ["--import", import.meta.resolve("tsx"), "--conditions=source", fileURLToPath(new URL("../src/main.ts", import.meta.url)), ...args], { env: { ...process.env, CONTEXTLANES_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}` } });
    expect(JSON.parse((await cli("lanes", "--json")).stdout)).toEqual([lane]);
    expect(JSON.parse((await cli("status", "shop/01", "--json")).stdout)).toMatchObject({ lane, plan: [], verdict: null });
    await cli("send", "shop/01", "First line\nSecond line");
    expect(requests.at(-1)).toEqual({ url: "/api/lanes/shop/01/prompt", body: { text: "First line\nSecond line" } });
  } finally { server.closeAllConnections(); server.close(); }
});
