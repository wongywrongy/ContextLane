import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });
const script = fileURLToPath(new URL("../bin/hook.mjs", import.meta.url));
function hook(url: string, payload: object) {
  const child = spawn(process.execPath, [script, "PermissionRequest"], { env: { ...process.env, CONTEXTLANES_URL: url, CONTEXTLANES_LANE: "demo/01", CONTEXTLANES_LANE_TOKEN: "fixture" }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify(payload)); let stdout = ""; child.stdout.on("data", (b) => { stdout += b; });
  return new Promise<{ stdout: string; code: number | null }>((resolve) => child.on("close", (code) => resolve({ stdout, code })));
}
const payload = { hook_event_name: "PermissionRequest", session_id: "s", cwd: "/workspace" };
it("prints the native answer after polling, with no decision invented by the entry point", async () => {
  const seen: string[] = []; let polls = 0;
  const server = createServer((req, res) => { seen.push(req.headers.authorization ?? ""); res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.method === "POST" || polls++ === 0 ? { pending: true, requestId: "hook:one" } : { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Owner said no" } } })); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); stops.push(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const result = await hook(url, payload);
  expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
  expect(seen).toEqual(["Bearer fixture", "Bearer fixture", "Bearer fixture"]);
});
it("falls back to no decision within two seconds when the daemon hangs", async () => {
  const server = createServer(() => {}); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stops.push(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
  const start = Date.now(); const result = await hook(`http://127.0.0.1:${(server.address() as { port: number }).port}`, payload);
  expect(result).toEqual({ stdout: "", code: 0 }); expect(Date.now() - start).toBeLessThan(2000);
});
