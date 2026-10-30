import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { stringify } from "smol-toml";
import { expect, it, vi } from "vitest";
import { runCommand } from "@contextlanes/daemon";
import type { Lane, LaneEvent } from "@contextlanes/protocol";

it.runIf(process.env.CONTEXTLANES_REAL_HOSTS === "1")("keeps two real systemd lane hosts and their permissions alive across a daemon service restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "cl-real-hosts-"));
  const unit = `contextlanes-host-test-${process.pid}`;
  const project = `hosts-${process.pid}`;
  const loader = createRequire(import.meta.url).resolve("tsx");
  const executable = { command: process.execPath, args: ["--import", loader, "--conditions=source", resolve("apps/lanehost/test/fixtures/fake-stdio.ts")] };
  const host = { command: process.execPath, args: ["--import", loader, "--conditions=source", resolve("apps/lanehost/src/main.ts")] };
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const port = (probe.address() as { port: number }).port; probe.close(() => resolve(port)); });
  });
  const url = `http://127.0.0.1:${port}`;
  const lanes: Lane[] = [];
  const api = async <T,>(path: string, data?: unknown): Promise<T> => {
    const response = await fetch(`${url}${path}`, data ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) } : {});
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  try {
    const repo = join(root, "repo");
    await runCommand("git", ["init", "-b", "main", repo]);
    await runCommand("git", ["-c", "user.name=ContextLanes", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Fixture"], { cwd: repo });
    const config = join(root, "config.toml");
    await writeFile(config, stringify({ access: { owner: "fixture@example.invalid" }, listen: { port }, paths: { data: join(root, "data"), lanes: join(root, "lanes") }, agents: { "claude-code": executable, codex: executable }, lanes: { host, launchHosts: true } }));
    await runCommand("systemd-run", ["--user", `--unit=${unit}`, "--collect", `--working-directory=${process.cwd()}`, `--setenv=CONTEXTLANES_CONFIG=${config}`,
      process.execPath, "--import", loader, "--conditions=source", resolve("apps/daemon/src/main.ts")]);
    await vi.waitFor(() => api("/api/health"), { timeout: 10_000 });
    await api("/api/projects", { path: repo, name: project });
    for (const agent of ["claude-code", "codex"]) lanes.push(await api<Lane>("/api/lanes", { project, task: "permission", agent }));
    await vi.waitFor(async () => expect(await api<unknown[]>("/api/inbox")).toHaveLength(2), { timeout: 10_000 });
    const pids = await Promise.all(lanes.map((lane) => runCommand("systemctl", ["--user", "show", `contextlanes-lane-${lane.id.replace("/", "-")}`, "--property=MainPID", "--value"])));
    for (const pid of pids) expect(Number(pid.stdout)).toBeGreaterThan(0);
    await runCommand("systemctl", ["--user", "restart", unit]);
    await vi.waitFor(() => api("/api/health"), { timeout: 10_000 });
    for (const [i, lane] of lanes.entries()) {
      const after = await runCommand("systemctl", ["--user", "show", `contextlanes-lane-${lane.id.replace("/", "-")}`, "--property=MainPID", "--value"]);
      expect(after.stdout).toBe(pids[i]!.stdout);
      const events = await api<LaneEvent[]>(`/api/lanes/${lane.id}/events`);
      const request = events.find((e) => e.type === "permission.requested");
      if (request?.type !== "permission.requested") throw new Error("missing permission");
      await api("/api/answers", { lane: lane.id, requestId: request.payload.requestId, optionId: "yes", via: "phone" });
      await vi.waitFor(async () => expect((await api<LaneEvent[]>(`/api/lanes/${lane.id}/events`)).some((e) => e.type === "agent.message" && e.payload.text.includes("Finished permission"))).toBe(true), { timeout: 10_000 });
    }
    expect(await api<unknown[]>("/api/inbox")).toHaveLength(0);
  } finally {
    for (const lane of lanes) {
      await runCommand("systemctl", ["--user", "stop", `contextlanes-lane-${lane.id.replace("/", "-")}`]).catch(() => {});
      await runCommand("tmux", ["kill-session", "-t", lane.terminal]).catch(() => {});
    }
    await runCommand("systemctl", ["--user", "stop", unit]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
