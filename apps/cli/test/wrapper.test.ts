import { afterEach, expect, it, vi } from "vitest";
import { startCliLane } from "../src/wrapper.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each(["claude", "codex"] as const)("registers the checkout and forwards %s argv intact, taking --here for itself", async (agent) => {
  const calls: { path: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/api/setup/status") return Response.json({});
    if (path === "/api/projects") return Response.json({ id: "demo" });
    if (path.endsWith("/branches")) return Response.json({ defaultBranch: "develop" });
    return Response.json({ id: "demo/01", state: "working", terminal: "cl-demo-01" });
  }));
  await expect(startCliLane(agent, ["--here", "--model", "small", "A task\nwith `$()` and spaces"])).resolves.toMatchObject({ id: "demo/01" });
  expect(calls.find((c) => c.path === "/api/projects")!.body).toEqual({ path: process.cwd() });
  expect(calls.find((c) => c.path === "/api/lanes")!.body).toMatchObject({ agent: agent === "claude" ? "claude-code" : "codex", kind: "cli", direct: true, base: "develop", cliArgs: ["--model", "small", "A task\nwith `$()` and spaces"] });
});
