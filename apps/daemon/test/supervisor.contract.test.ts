import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runCommand } from "@contextlanes/daemon";
import { ProcessSupervisor, SystemdSupervisor, type Supervisor } from "../src/supervisor/index.js";

const node = process.execPath;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => Promise<boolean> | boolean, ms = 8000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await check()) return true;
  return false;
}

const roots: string[] = [];
afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }); });

/**
 * What every supervisor must do, against real processes. The process supervisor runs everywhere; the
 * systemd one needs a user session (CONTEXTLANES_REAL_HOSTS=1, as the other real-host tests).
 */
function contract(name: string, make: (data: string) => Supervisor, enabled: boolean) {
  describe.skipIf(!enabled)(`${name} supervisor`, () => {
    const setup = async () => {
      const root = await mkdtemp(join(tmpdir(), `cl-sup-${name}-`)); roots.push(root);
      return { root, supervisor: make(join(root, "data")), unit: `contextlanes-test-${randomBytes(4).toString("hex")}` };
    };

    it("starts a service in its folder with its environment, reports it and its logs, and stops its whole group", async () => {
      const { root, supervisor, unit } = await setup();
      const script = join(root, "svc.js");
      await writeFile(script, `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync("child.pid", String(child.pid));
console.log("hello " + process.env.GREETING + " from " + process.cwd());
setInterval(() => {}, 1000);`);
      await supervisor.start(unit, { dir: root, argv: [node, script], env: { GREETING: "lane", PATH: process.env.PATH! }, restart: true });
      expect(await until(async () => (await supervisor.status(unit)).active)).toBe(true);
      const status = await supervisor.status(unit);
      expect(status.pids.length).toBeGreaterThanOrEqual(1);
      expect(await until(async () => (await supervisor.logs(unit, 20)).some((l) => l.text.includes(`hello lane from ${root}`)))).toBe(true);
      const childPid = Number(await readFile(join(root, "child.pid"), "utf8"));
      expect(alive(childPid)).toBe(true);
      await supervisor.stop(unit);
      expect(await until(async () => !(await supervisor.status(unit)).active)).toBe(true);
      expect(await until(() => !alive(childPid))).toBe(true);
    }, 30_000);

    it("starts a service again after it exits", async () => {
      const { root, supervisor, unit } = await setup();
      await supervisor.start(unit, { dir: root, argv: [node, "-e", "setTimeout(() => process.exit(3), 300)"], env: { PATH: process.env.PATH! }, restart: true });
      expect(await until(async () => (await supervisor.status(unit)).active)).toBe(true);
      const first = (await supervisor.status(unit)).pids[0];
      expect(await until(async () => { const s = await supervisor.status(unit); return s.active && s.pids[0] !== first; }, 10_000)).toBe(true);
      await supervisor.stop(unit);
    }, 30_000);

    it("runs a one-shot to completion, says when it fails, and ends everything it started at the timeout", async () => {
      const { root, supervisor } = await setup();
      expect(await supervisor.oneshot({ dir: root, argv: [node, "-e", "console.log('built ' + process.env.X)"], env: { X: "ok", PATH: process.env.PATH! }, timeoutSeconds: 20 })).toMatchObject({ ok: true, output: expect.stringContaining("built ok") });
      expect((await supervisor.oneshot({ dir: root, argv: [node, "-e", "console.error('nope'); process.exit(2)"], env: { PATH: process.env.PATH! }, timeoutSeconds: 20 })).ok).toBe(false);
      const pidFile = join(root, "left.pid");
      const started = Date.now();
      const slow = await supervisor.oneshot({ dir: root, argv: [node, "-e", `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`], env: { PATH: process.env.PATH! }, timeoutSeconds: 2 });
      expect(slow.ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(await until(() => !alive(Number(readFileSync(pidFile, "utf8"))))).toBe(true);
    }, 30_000);

    it("finds a service listening beyond loopback, and not one on loopback", async () => {
      const { root, supervisor, unit } = await setup();
      const listen = (host: string) => `require("node:http").createServer((q, r) => r.end("x")).listen(0, ${JSON.stringify(host)}, () => console.log("up"))`;
      await supervisor.start(unit, { dir: root, argv: [node, "-e", listen("0.0.0.0")], env: { PATH: process.env.PATH! }, restart: false });
      expect(await until(async () => (await supervisor.publicListeners((await supervisor.status(unit)).pids)).length > 0)).toBe(true);
      await supervisor.stop(unit);
      const quiet = `${unit}-lo`;
      await supervisor.start(quiet, { dir: root, argv: [node, "-e", listen("127.0.0.1")], env: { PATH: process.env.PATH! }, restart: false });
      expect(await until(async () => (await supervisor.logs(quiet, 5)).some((l) => l.text === "up"))).toBe(true);
      expect(await supervisor.publicListeners((await supervisor.status(quiet)).pids)).toEqual([]);
      await supervisor.stop(quiet);
    }, 30_000);
  });
}

contract("process", (data) => new ProcessSupervisor(data), true);
contract("systemd", () => new SystemdSupervisor(runCommand), process.env.CONTEXTLANES_REAL_HOSTS === "1");

describe("process supervisor across a daemon restart", () => {
  it("finds a service that kept running, starts again one that died and restarts, and treats the rest as stopped", async () => {
    const root = await mkdtemp(join(tmpdir(), "cl-sup-adopt-")); roots.push(root);
    const data = join(root, "data");
    const before = new ProcessSupervisor(data);
    await before.start("contextlanes-env-a", { dir: root, argv: [node, "-e", "setInterval(() => {}, 1000)"], env: { PATH: process.env.PATH! }, restart: true });
    await before.start("contextlanes-env-b", { dir: root, argv: [node, "-e", "setInterval(() => {}, 1000)"], env: { PATH: process.env.PATH! }, restart: false });
    await before.start("contextlanes-env-d", { dir: root, argv: [node, "-e", "setInterval(() => {}, 1000)"], env: { PATH: process.env.PATH! }, restart: true });
    const dead = (await before.status("contextlanes-env-b")).pids[0]!;
    const crashed = (await before.status("contextlanes-env-d")).pids[0]!;
    // The daemon goes away (nothing of `before` is used again), then two services die while it is down.
    (before as unknown as { live: Map<string, unknown> }).live.clear();
    for (const pid of [dead, crashed]) process.kill(-pid, "SIGKILL");
    await until(() => !alive(dead) && !alive(crashed));

    const after = new ProcessSupervisor(data);
    expect(await after.list("contextlanes-env-")).toEqual(expect.arrayContaining(["contextlanes-env-a", "contextlanes-env-b"]));
    expect((await after.status("contextlanes-env-a")).active).toBe(true);
    expect((await after.status("contextlanes-env-b")).active).toBe(false);
    expect((await after.status("contextlanes-env-d")).state).toBe("restarting");
    expect(await until(async () => { const s = await after.status("contextlanes-env-d"); return s.active && s.pids[0] !== crashed; })).toBe(true);
    await after.stop("contextlanes-env-d");
    const pid = (await after.status("contextlanes-env-a")).pids[0]!;
    await after.stop("contextlanes-env-a");
    expect(await until(() => !alive(pid))).toBe(true);
    // A pid reused by an unrelated process is not mistaken for the service.
    await writeFile(join(data, "supervisor", "contextlanes-env-c.json"), JSON.stringify({ pid: process.pid, started: "Thu Jan  1 00:00:00 1970", log: "" }));
    expect((await after.status("contextlanes-env-c")).active).toBe(false);
    await after.stop("contextlanes-env-c");
    expect(alive(process.pid)).toBe(true);
  }, 30_000);
});
