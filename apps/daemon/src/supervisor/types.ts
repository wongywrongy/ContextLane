import type { LogLine } from "@contextlanes/protocol";

/** A long-running lane service. argv is final: the sandbox prefix and variable expansion are already applied. */
export type ServiceSpec = { dir: string; argv: string[]; env: Record<string, string>; restart: boolean };
/** A command run to completion (setup steps, checks, teardown); a timeout ends everything it started. */
export type OneshotSpec = { dir: string; argv: string[]; env: Record<string, string>; timeoutSeconds: number };
export type UnitStatus = { active: boolean; state: string; pids: number[] };
export type OneshotResult = { ok: boolean; output: string; ms: number };

/**
 * How ContextLanes runs processes that outlive a request: systemd user units where systemd is, plain
 * process groups the daemon watches everywhere else, and in the Docker runtime processes inside one
 * lane's container (`docker`). Units are named by the caller and are unique.
 */
export interface Supervisor {
  readonly name: "systemd" | "process" | "docker";
  start(unit: string, spec: ServiceSpec): Promise<void>;
  stop(unit: string): Promise<void>;
  status(unit: string): Promise<UnitStatus>;
  logs(unit: string, lines: number): Promise<LogLine[]>;
  oneshot(spec: OneshotSpec): Promise<OneshotResult>;
  /** Listening addresses of these processes that reach beyond loopback. */
  publicListeners(pids: number[]): Promise<string[]>;
  /** Runs a command whose children must outlive the daemon (tmux's server); `name` labels it. */
  detached(name: string, argv: string[]): Promise<void>;
  /** Units this supervisor knows whose names start with prefix, for clean-up at start. */
  list(prefix: string): Promise<string[]>;
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|\[::1\]|::1|\[::ffff:127\.\d+\.\d+\.\d+\]|localhost)$/;
export const isLoopback = (address: string) => LOOPBACK.test(address);

/** Addresses from `ss -H -ltnp` that belong to these processes and reach beyond loopback. */
export function publicBindings(ss: string, pids: Set<string>): string[] {
  const found = new Set<string>();
  for (const line of ss.split("\n")) {
    const [, , , local] = line.trim().split(/\s+/);
    if (!local || ![...line.matchAll(/pid=(\d+)/g)].some((m) => pids.has(m[1]!))) continue;
    const address = local.slice(0, local.lastIndexOf(":")).replace(/%.*$/, "");
    if (!isLoopback(address)) found.add(local);
  }
  return [...found];
}

/** Addresses from `lsof -nP -iTCP -sTCP:LISTEN -Fn` (macOS) that reach beyond loopback. */
export function publicLsof(lsof: string): string[] {
  const found = new Set<string>();
  for (const line of lsof.split("\n")) {
    if (!line.startsWith("n")) continue;
    const local = line.slice(1);
    const address = local.slice(0, local.lastIndexOf(":"));
    if (!isLoopback(address)) found.add(local);
  }
  return [...found];
}
