import { readFileSync } from "node:fs";
import type { LogLine } from "@contextlanes/protocol";
import type { Runner } from "../run.js";
import { execArgv, type LaneTarget } from "../docker/exec.js";
import { LANE_DIR } from "../docker/names.js";
import { isLoopback, type OneshotResult, type OneshotSpec, type ServiceSpec, type Supervisor, type UnitStatus } from "./types.js";

const NAME = /^[\w.@-]{1,200}$/;

/**
 * The unit helper (apps/daemon/bin/unit.sh) every docker-driver call runs inside the lane, as
 * `sh -c UNIT_SH contextlanes-unit <action> …`, so nothing is installed in the image. POSIX
 * sh only (dash, bash, busybox ash), with nothing but /proc, setsid and coreutils: a project's image has
 * none of our tools on its own PATH. State lives in $CL_UNITS/<unit>/ inside the container:
 *   loop   pid of the watching loop       pid   "<pid> <starttime>" of the running service
 *   log    output, rotated at 5 MB         restart, stopping   flags
 * A pid counts only while /proc/<pid>/stat still shows the start time recorded with it, so a pid reused
 * after a container restart is never mistaken for the service. Each service runs in its own process
 * group (setsid), and stop and the one-shot timeout end the whole group.
 */
export const UNIT_SH = readFileSync(new URL("../../bin/unit.sh", import.meta.url), "utf8");

/** A /proc/net/tcp{,6} local address ("0100007F:1F90") as text ("127.0.0.1:8080", "[::1]:8080"). */
export function procAddress(hex: string): string | null {
  const [ip, port] = hex.split(":");
  if (!ip || !port) return null;
  const p = parseInt(port, 16);
  if (ip.length === 8) return `${[0, 1, 2, 3].map((i) => parseInt(ip.slice(6 - i * 2, 8 - i * 2), 16)).join(".")}:${p}`;
  if (ip.length !== 32) return null;
  // Four little-endian 32-bit words.
  const bytes = [0, 1, 2, 3].flatMap((w) => { const word = ip.slice(w * 8, w * 8 + 8); return [6, 4, 2, 0].map((o) => parseInt(word.slice(o, o + 2), 16)); });
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return `[::ffff:${bytes.slice(12).join(".")}]:${p}`;
  const groups = [0, 2, 4, 6, 8, 10, 12, 14].map((i) => ((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  const text = groups.join(":").replace(/(^|:)0(:0)+(:|$)/, "::").replace(/:{3,}/, "::");
  return `[${text}]:${p}`;
}

/** Listening sockets (state 0A) whose inode is among the processes' own, that reach beyond loopback. */
export function publicProcNet(output: string): string[] {
  const [fds = "", net = ""] = output.split("\n---\n");
  const inodes = new Set(fds.split("\n").map((l) => /^socket:\[(\d+)\]$/.exec(l.trim())?.[1]).filter((i): i is string => !!i));
  const found = new Set<string>();
  for (const line of net.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || cols[3] !== "0A" || !inodes.has(cols[9]!)) continue;
    const local = procAddress(cols[1]!);
    if (!local) continue;
    const host = local.slice(0, local.lastIndexOf(":"));
    if (!isLoopback(host)) found.add(local);
  }
  return [...found];
}

/**
 * Processes inside one lane's container, started with `docker exec` (docs/V4.md 3.4). The container is the
 * boundary, so there is no sandbox prefix. Units are watched by a small loop inside the container, not by
 * the control service, so they keep running and restarting while the control container is replaced.
 */
export class DockerSupervisor implements Supervisor {
  readonly name = "docker" as const;
  /** units: where unit state lives inside the container (the lane's own folder, never the checkout). */
  constructor(private readonly run: Runner, private readonly target: LaneTarget, private readonly units = `${LANE_DIR}/units`) {}

  private exec(argv: string[], opts: { dir?: string; env?: Record<string, string>; detach?: boolean } = {}) {
    return execArgv(this.target, argv, { ...opts, env: { ...opts.env, CL_UNITS: this.units } });
  }

  private unit(action: string, args: string[], opts: { dir?: string; env?: Record<string, string>; detach?: boolean; timeout?: number } = {}) {
    return this.run("docker", this.exec(["sh", "-c", UNIT_SH, "contextlanes-unit", action, ...args], opts), { timeout: opts.timeout ?? 30_000 });
  }

  async start(unit: string, spec: ServiceSpec): Promise<void> {
    if (!NAME.test(unit)) throw new Error(`Invalid unit name ${unit}`);
    if (!spec.argv.length) throw new Error("Nothing to run");
    await this.stop(unit).catch(() => {});
    await this.unit("start", [unit, spec.restart ? "1" : "0", ...spec.argv], { dir: spec.dir, env: spec.env, detach: true });
  }

  async stop(unit: string): Promise<void> {
    if (!NAME.test(unit)) throw new Error(`Invalid unit name ${unit}`);
    await this.unit("stop", [unit]);
  }

  async status(unit: string): Promise<UnitStatus> {
    const out = await this.unit("status", [unit]).then((r) => r.stdout, () => "");
    const [state = "inactive", ...pids] = out.split("\n").map((l) => l.trim()).filter(Boolean);
    if (state !== "active") return { active: false, state: state === "restarting" ? "restarting" : "inactive", pids: [] };
    return { active: true, state, pids: pids.map(Number).filter((n) => Number.isInteger(n) && n > 0) };
  }

  async logs(unit: string, lines: number): Promise<LogLine[]> {
    const out = await this.unit("logs", [unit, String(Math.max(1, Math.floor(lines)))]).then((r) => r.stdout, () => "");
    if (!out) return [];
    const [first, ...rest] = out.split("\n");
    // A plain file has no time per line; each line carries the file's last write, as the process driver does.
    const at = new Date(Number(first) * 1000 || Date.now()).toISOString();
    return rest.filter((l) => l.length).slice(-lines).map((text) => ({ at, text }));
  }

  async oneshot(spec: OneshotSpec): Promise<OneshotResult> {
    const started = Date.now();
    try {
      const { stdout } = await this.unit("oneshot", [String(spec.timeoutSeconds), ...spec.argv], { dir: spec.dir, env: spec.env, timeout: (spec.timeoutSeconds + 15) * 1000 });
      return { ok: true, output: stdout.slice(-4000), ms: Date.now() - started };
    } catch (err) {
      const { stdout = "", stderr = "", message } = err as Error & { stdout?: string; stderr?: string };
      return { ok: false, output: (`${stdout}${stderr}` || message).slice(-4000), ms: Date.now() - started };
    }
  }

  async publicListeners(pids: number[]): Promise<string[]> {
    if (!pids.length) return [];
    const out = await this.unit("listeners", pids.map(String)).then((r) => r.stdout, () => "");
    return publicProcNet(out);
  }

  /** tmux daemonizes its own server, and a `docker exec` ending does not stop what it left running. */
  async detached(_name: string, argv: string[]): Promise<void> {
    await this.run("docker", this.exec(argv), { timeout: 30_000 });
  }

  async list(prefix: string): Promise<string[]> {
    const out = await this.unit("list", []).then((r) => r.stdout, () => "");
    return out.split("\n").map((l) => l.trim()).filter((n) => n && n.startsWith(prefix));
  }
}
