import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LogLine } from "@contextlanes/protocol";
import { runCommand, type Runner } from "../run.js";
import { publicBindings, publicLsof, type OneshotResult, type OneshotSpec, type ServiceSpec, type Supervisor, type UnitStatus } from "./types.js";

const LOG_CAP = 5 * 1024 * 1024;
const RESTART_MS = 2000;
const STOP_MS = 5000;
const NAME = /^[\w.@-]{1,200}$/;

/**
 * What survives a daemon restart: enough to find the process again, to know it is still the same one, and
 * to start it again if it died meanwhile. Kept under the data folder (0600), which lanes cannot see.
 */
type UnitRecord = { pid: number; started: string; log: string; spec?: ServiceSpec };
type Live = { child: ChildProcess | null; spec: ServiceSpec; stopping: boolean; timer: NodeJS.Timeout | null; record: UnitRecord };

/** The variables systemd's user manager would give a unit, so services find their home and locale. */
function baseEnv(): Record<string, string> {
  const keep = ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TZ"];
  return Object.fromEntries(keep.flatMap((k) => process.env[k] ? [[k, process.env[k]!]] : []));
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Lane services as detached process groups the daemon watches: for macOS and Linux without systemd.
 * A service that exits is started again after two seconds while the daemon runs; its output goes to a
 * size-capped file under <data>/logs. Each unit's pid, start time and spec are kept under <data>/supervisor,
 * so a restarted daemon finds services that kept running, and starts again those that died and restart,
 * as systemd would have. Only stop() removes a unit.
 */
export class ProcessSupervisor implements Supervisor {
  readonly name = "process" as const;
  private readonly live = new Map<string, Live>();
  private readonly records: string;
  private readonly logs_: string;

  constructor(data: string, private readonly run: Runner = runCommand, private readonly platform: NodeJS.Platform = process.platform) {
    this.records = join(data, "supervisor");
    this.logs_ = join(data, "logs");
    mkdirSync(this.records, { recursive: true, mode: 0o700 });
    mkdirSync(this.logs_, { recursive: true, mode: 0o700 });
  }

  private recordPath(unit: string) { return join(this.records, `${unit}.json`); }
  private logPath(unit: string) { return join(this.logs_, `${unit}.log`); }

  private readRecord(unit: string): UnitRecord | null {
    try { return JSON.parse(readFileSync(this.recordPath(unit), "utf8")) as UnitRecord; } catch { return null; }
  }

  /** The start time the OS reports, which tells a process from a later one that reused its pid. */
  private async startedAt(pid: number): Promise<string | null> {
    return this.run("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5000 }).then((r) => r.stdout.trim() || null, () => null);
  }

  private async same(record: UnitRecord): Promise<boolean> {
    return alive(record.pid) && (await this.startedAt(record.pid)) === record.started;
  }

  async start(unit: string, spec: ServiceSpec): Promise<void> {
    if (!NAME.test(unit)) throw new Error(`Invalid unit name ${unit}`);
    if (!spec.argv.length) throw new Error("Nothing to run");
    await this.stop(unit).catch(() => {});
    const entry: Live = { child: null, spec, stopping: false, timer: null, record: { pid: 0, started: "", log: this.logPath(unit) } };
    this.live.set(unit, entry);
    await this.spawn(unit, entry);
  }

  private async spawn(unit: string, entry: Live): Promise<void> {
    const log = this.logPath(unit);
    try { if (statSync(log).size > LOG_CAP) renameSync(log, `${log}.1`); } catch { /* no log yet */ }
    const fd = openSync(log, "a", 0o600);
    const { argv, dir, env } = entry.spec;
    const child = spawn(argv[0]!, argv.slice(1), { cwd: dir, env: { ...baseEnv(), ...env }, detached: true, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    entry.child = child;
    entry.record = { pid: child.pid!, started: (await this.startedAt(child.pid!)) ?? "", log, spec: entry.spec };
    writeFileSync(this.recordPath(unit), JSON.stringify(entry.record), { mode: 0o600 });
    child.once("exit", () => {
      if (entry.stopping || this.live.get(unit) !== entry || !entry.spec.restart) return;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (entry.stopping || this.live.get(unit) !== entry) return;
        this.spawn(unit, entry).catch((err) => console.error(`Restarting ${unit} failed:`, err));
      }, RESTART_MS);
      entry.timer.unref();
    });
  }

  async stop(unit: string): Promise<void> {
    const entry = this.live.get(unit);
    if (entry) { entry.stopping = true; if (entry.timer) clearTimeout(entry.timer); this.live.delete(unit); }
    const record = entry?.record.pid ? entry.record : this.readRecord(unit);
    rmSync(this.recordPath(unit), { force: true });
    if (!record?.pid || !(entry || await this.same(record))) return;
    // The whole group: a dev server's own children (bundlers, watchers) go with it.
    const signal = (s: NodeJS.Signals) => { try { process.kill(-record.pid, s); } catch { /* gone */ } };
    signal("SIGTERM");
    for (let waited = 0; waited < STOP_MS && alive(record.pid); waited += 100) await sleep(100);
    signal("SIGKILL");
  }

  async status(unit: string): Promise<UnitStatus> {
    const entry = this.live.get(unit);
    const record = entry?.record.pid ? entry.record : this.readRecord(unit);
    if (!record?.pid) return { active: false, state: entry ? "restarting" : "inactive", pids: [] };
    const running = entry ? alive(record.pid) : await this.same(record);
    if (!running && !entry && record.spec?.restart) {
      // Found dead after a daemon restart: take it over and start it again.
      const adopted: Live = { child: null, spec: record.spec, stopping: false, timer: null, record };
      this.live.set(unit, adopted);
      await this.spawn(unit, adopted).catch((err) => { this.live.delete(unit); console.error(`Restarting ${unit} failed:`, err); });
      return { active: false, state: "restarting", pids: [] };
    }
    if (!running) return { active: false, state: entry?.timer ? "restarting" : "inactive", pids: [] };
    const members = await this.run("pgrep", ["-g", String(record.pid)], { timeout: 5000 }).then((r) => r.stdout.split("\n").filter(Boolean).map(Number), () => []);
    return { active: true, state: "active", pids: members.length ? members : [record.pid] };
  }

  async logs(unit: string, lines: number): Promise<LogLine[]> {
    const path = this.logPath(unit);
    const [text, info] = await Promise.all([readFile(path, "utf8").catch(() => ""), stat(path).catch(() => null)]);
    // Plain files have no time per line; each line carries the file's last write.
    const at = (info?.mtime ?? new Date()).toISOString();
    return text.split("\n").filter((l) => l.length).slice(-lines).map((line) => ({ at, text: line }));
  }

  async oneshot(spec: OneshotSpec): Promise<OneshotResult> {
    const started = Date.now();
    return new Promise<OneshotResult>((resolve) => {
      let output = "";
      let timedOut = false;
      const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.dir, env: { ...baseEnv(), ...spec.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const add = (d: Buffer) => { output = (output + d.toString("utf8")).slice(-8000); };
      child.stdout!.on("data", add); child.stderr!.on("data", add);
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, spec.timeoutSeconds * 1000);
      child.once("error", (err) => { clearTimeout(timer); resolve({ ok: false, output: err.message, ms: Date.now() - started }); });
      child.once("close", (code) => {
        clearTimeout(timer);
        // Anything the command left running in its group goes too, as a unit's would.
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
        const tail = (timedOut ? `${output}\nStopped after ${spec.timeoutSeconds} seconds.` : output).slice(-4000);
        resolve({ ok: code === 0 && !timedOut, output: tail, ms: Date.now() - started });
      });
    });
  }

  async publicListeners(pids: number[]): Promise<string[]> {
    if (!pids.length) return [];
    const lsof = async () => publicLsof(await this.run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.join(","), "-Fn"]).then((r) => r.stdout, (e: { stdout?: string }) => e.stdout ?? ""));
    if (this.platform === "darwin") return lsof();
    // ss where iproute2 is installed; lsof on minimal systems without it.
    const ss = await this.run("ss", ["-H", "-ltnp"]).then((r) => r.stdout, () => null);
    return ss === null ? lsof() : publicBindings(ss, new Set(pids.map(String)));
  }

  /** tmux daemonizes its own server, so without systemd there is no cgroup to escape: just run it. */
  async detached(_name: string, argv: string[]): Promise<void> {
    await this.run(argv[0]!, argv.slice(1));
  }

  async list(prefix: string): Promise<string[]> {
    const names = await readdir(this.records).catch(() => []);
    return names.filter((n) => n.endsWith(".json") && n.startsWith(prefix)).map((n) => n.slice(0, -".json".length));
  }
}
