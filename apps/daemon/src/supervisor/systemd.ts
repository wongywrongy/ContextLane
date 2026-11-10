import type { LogLine } from "@contextlanes/protocol";
import type { Runner } from "../run.js";
import { publicBindings, type OneshotResult, type OneshotSpec, type ServiceSpec, type Supervisor, type UnitStatus } from "./types.js";

/** systemd reads $ in a command; recipes mean a literal one, after our own substitution. */
export const literal = (args: string[]) => args.map((a) => a.replaceAll("$", "$$$$"));
export const setenv = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`);

export function systemdServiceArgs(unit: string, spec: ServiceSpec): string[] {
  return ["--user", `--unit=${unit}`, "--collect", `--working-directory=${spec.dir}`, ...(spec.restart ? ["--property=Restart=on-failure", "--property=RestartSec=2"] : []), "--property=TimeoutStopSec=5",
    ...setenv(spec.env), "--", ...literal(spec.argv)];
}

export function systemdOneshotArgs(spec: OneshotSpec): string[] {
  return ["--user", "--wait", "--pipe", "--collect", "--quiet", `--working-directory=${spec.dir}`, `--property=RuntimeMaxSec=${spec.timeoutSeconds}s`, ...setenv(spec.env), "--", ...literal(spec.argv)];
}

/** Transient systemd user units: restart on failure, journald logs, cgroups for the process list. */
export class SystemdSupervisor implements Supervisor {
  readonly name = "systemd" as const;
  constructor(private readonly run: Runner) {}

  async start(unit: string, spec: ServiceSpec): Promise<void> {
    await this.run("systemd-run", systemdServiceArgs(unit, spec));
  }

  async stop(unit: string): Promise<void> {
    await this.run("systemctl", ["--user", "stop", unit]);
  }

  async status(unit: string): Promise<UnitStatus> {
    const shown = await this.run("systemctl", ["--user", "show", "--property=ActiveState", "--property=ControlGroup", unit]).then((r) => r.stdout, () => "");
    const field = (name: string) => shown.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1] ?? "";
    const state = field("ActiveState") || "gone";
    if (state !== "active") return { active: false, state, pids: [] };
    const pids = await this.run("cat", [`/sys/fs/cgroup${field("ControlGroup")}/cgroup.procs`]).then((r) => r.stdout.split("\n").filter(Boolean).map(Number), () => []);
    return { active: true, state, pids };
  }

  async logs(unit: string, lines: number): Promise<LogLine[]> {
    const { stdout } = await this.run("journalctl", ["--user", `--unit=${unit}`, "-n", String(lines), "--no-pager", "-o", "json", "--output-fields=MESSAGE"]);
    return stdout.split("\n").filter(Boolean).map((line) => {
      const entry = JSON.parse(line) as { __REALTIME_TIMESTAMP: string; MESSAGE: string | number[] | null };
      const text = typeof entry.MESSAGE === "string" ? entry.MESSAGE : Array.isArray(entry.MESSAGE) ? Buffer.from(entry.MESSAGE).toString("utf8") : "";
      return { at: new Date(Number(entry.__REALTIME_TIMESTAMP) / 1000).toISOString(), text };
    });
  }

  async oneshot(spec: OneshotSpec): Promise<OneshotResult> {
    const started = Date.now();
    try {
      const { stdout } = await this.run("systemd-run", systemdOneshotArgs(spec), { timeout: (spec.timeoutSeconds + 15) * 1000 });
      return { ok: true, output: stdout.slice(-4000), ms: Date.now() - started };
    } catch (err) {
      const { stdout = "", stderr = "", message } = err as Error & { stdout?: string; stderr?: string };
      return { ok: false, output: (`${stdout}${stderr}` || message).slice(-4000), ms: Date.now() - started };
    }
  }

  async publicListeners(pids: number[]): Promise<string[]> {
    if (!pids.length) return [];
    return publicBindings(await this.run("ss", ["-H", "-ltnp"]).then((r) => r.stdout, () => ""), new Set(pids.map(String)));
  }

  /** A newly created tmux server must outlive the daemon's cgroup, even on a fresh machine. */
  async detached(name: string, argv: string[]): Promise<void> {
    await this.run("systemd-run", ["--user", "--scope", `--unit=${name}`, "--collect", "--quiet", ...argv]);
  }

  async list(prefix: string): Promise<string[]> {
    const units = await this.run("systemctl", ["--user", "list-units", "--all", "--plain", "--no-legend", "--type=service", `${prefix}*`], { timeout: 10_000 }).then((r) => r.stdout, () => "");
    return units.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((u): u is string => !!u);
  }
}
