import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildServer, Config, EventBus, HostLinks, LaneManager, SetupManager, Store, type Runner } from "@contextlanes/daemon";
import { DataExport, MachineInfo, UpdateCheck } from "@contextlanes/protocol";
import { backupDatabase } from "../src/backup.js";
import { installBackupTimer } from "../src/install.js";
import { signedIn } from "./signed-in.js";
import { machineInfo, checkForUpdates } from "../src/machine.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const path = await mkdtemp(join(tmpdir(), "cl-machine-")); roots.push(path); return path; }

it("does not invent machine/backup facts when user services cannot be queried, and reports failed update checks", async () => {
  const unavailable: Runner = async () => { throw new Error("unavailable"); };
  const info = await machineInfo(Config.parse({}), "test", unavailable);
  expect(info).toMatchObject({ linger: null, service: null, backups: { scheduled: null, result: null, lastRun: null } });
  await expect(checkForUpdates(unavailable)).rejects.toThrow("SSH session");
});

it("backs up the live WAL database consistently, keeps seven private nightly copies and leaves updater copies alone", async () => {
  const path = await root(), file = join(path, "contextlanes.sqlite"), directory = join(path, "backups", "nightly");
  const store = Store.open(file);
  try {
    store.addProject({ id: "demo", name: "Demo", path: "/code/demo" });
    await mkdir(join(path, "backups"));
    await writeFile(join(path, "backups", "rollback.sqlite"), "rollback");
    for (let i = 0; i < 9; i++) {
      const backup = await backupDatabase(file, directory, "nightly", 7);
      const copy = new DatabaseSync(backup!.file, { readOnly: true });
      try { expect(copy.prepare("SELECT name FROM project").get()).toMatchObject({ name: "Demo" }); } finally { copy.close(); }
      expect((await stat(backup!.file)).mode & 0o777).toBe(0o600);
      expect(backup!.userVersion).toBe(store.schemaVersion());
    }
    expect(await readdir(directory)).toHaveLength(7);
    expect(await readFile(join(path, "backups", "rollback.sqlite"), "utf8")).toBe("rollback");
    expect(store.getProject("demo")?.name).toBe("Demo");
    expect(await backupDatabase(join(path, "missing.sqlite"), directory, "nightly", 7)).toBeNull();
    const corrupt = join(path, "corrupt.sqlite"); await writeFile(corrupt, "not a database");
    await expect(backupDatabase(corrupt, directory, "nightly", 7)).rejects.toThrow();
    expect(await readdir(directory)).toHaveLength(7);
  } finally { store.close(); }
});

it("installs an owned persistent user timer idempotently and refuses unrelated files", async () => {
  const home = await root(), calls: string[] = [];
  const run: Runner = async (command, args) => { calls.push([command, ...args].join(" ")); return { stdout: "" }; };
  const opts = { root: join(home, "current"), home, node: process.execPath, run };
  await installBackupTimer(opts); await installBackupTimer(opts);
  const directory = join(home, ".config/systemd/user");
  expect(await readFile(join(directory, "contextlanes-backup.timer"), "utf8")).toContain("Persistent=true");
  expect(await readFile(join(directory, "contextlanes-backup.service"), "utf8")).toContain("backup-main.js");
  expect(calls).toContain("systemctl --user enable --now contextlanes-backup.timer");
  await writeFile(join(directory, "contextlanes-backup.timer"), "my timer");
  await expect(installBackupTimer(opts)).rejects.toThrow("Refusing to overwrite");
  expect(await readFile(join(directory, "contextlanes-backup.timer"), "utf8")).toBe("my timer");
});

it("serves measured machine/backup facts, reuses the CLI check, and exports work with secrets masked", async () => {
  const path = await root(), calls: { command: string; args: string[] }[] = [];
  const run: Runner = async (command, args) => {
    calls.push({ command, args });
    if (command === "loginctl") return { stdout: "yes\n" };
    if (command === "systemctl") return { stdout: args.includes("MainPID") ? `MainPID=${process.pid}\n` : args.includes("is-enabled") ? "enabled\n" : "Result=success\nExecMainExitTimestamp=Fri 2026-10-30 03:10:00 UTC\n" };
    if (command === process.execPath) return { stdout: "1 new change on main:\n  abc123 New version\nRun contextlanes update to install them.\n" };
    return { stdout: "" };
  };
  const config = Config.parse({ paths: { data: path, lanes: join(path, "lanes") }, access: { shellOwner: "fixture" }, lanes: { launchHosts: false },
    agents: { codex: { command: "codex-acp", args: [], env: { API_TOKEN: "agent-secret-123" } } }, notifications: { telegram: { botToken: "bot-secret-456", chatId: "123", ownerId: "456" } } });
  const store = Store.open(":memory:"), bus = new EventBus(), hosts = new HostLinks({ store, bus });
  const lanes = new LaneManager({ store, bus, config, run }), setup = new SetupManager(config, store, run);
  store.addProject({ id: "demo", name: "Demo", path: "/code/demo", remote: "https://git-token-789@github.com/example/demo.git" });
  const lane = await lanes.start({ project: "demo", task: "Task" });
  store.mintLaneToken(lane.id);
  store.appendEvent(lane.id, { type: "agent.message", payload: { role: "agent", text: 'agent-secret-123 bot-secret-456' } });
  store.appendEvent(lane.id, { type: "agent.message", payload: { role: "agent", text: '{"password":"not-for-export"}' } });
  store.appendEvent(lane.id, { type: "usage", payload: { contextUsed: 10, contextSize: 100, source: "acp" } });
  store.appendEvent(lane.id, { type: "usage.turn", payload: { turnId: randomUUID(), sessionId: "test", source: "acp", inputTokens: 42, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  const app = signedIn(buildServer({ store, bus, hosts, lanes, config, setup, run, version: "abc123" }), store);
  try {
    const info = MachineInfo.parse((await app.inject({ url: "/api/machine" })).json());
    expect(info).toMatchObject({ version: "abc123", service: true, linger: true, address: "127.0.0.1:4600", backups: { scheduled: true, result: "success", lastRun: "2026-10-30T03:10:00.000Z" } });
    const updates = UpdateCheck.parse((await app.inject({ method: "POST", url: "/api/machine/updates", payload: {} })).json());
    expect(updates.lines).toContain("  abc123 New version");
    expect(calls.filter((c) => c.command === process.execPath)).toEqual([{ command: process.execPath, args: [expect.stringContaining("update-main.js"), "--check"] }]);
    const response = await app.inject({ url: "/api/data/export" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const data = DataExport.parse(response.json());
    const encoded = JSON.stringify(data);
    expect(encoded).not.toContain("agent-secret-123"); expect(encoded).not.toContain("bot-secret-456");
    expect(encoded).not.toContain("not-for-export");
    expect(encoded).not.toContain("git-token-789");
    expect(data.tables.project![0]).toMatchObject({ id: "demo", path: "/code/demo" });
    expect(data.tables.lane![0]?.token_hash).toBe("••••••••");
    expect(data.tables.owner_session![0]?.hash).toBe("••••••••");
    const event = data.tables.event!.find((e) => e.type === "usage")!;
    expect(JSON.parse(String(event.payload))).toMatchObject({ contextUsed: 10, contextSize: 100 });
    expect(JSON.parse(String(data.tables.event!.find((e) => e.type === "usage.turn")!.payload))).toMatchObject({ inputTokens: 42 });
  } finally { await app.close(); await hosts.close(); store.close(); }
});
