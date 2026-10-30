import { connect } from "node:tls";
import { isAbsolute, relative } from "node:path";
import { Gpu, OutsideService, type ResourcesOverview, type RunFacts, type ProjectId } from "@contextlanes/protocol";
import type { Store } from "./db/store.js";
import type { Runner } from "./run.js";
import { NotFound } from "./lanes/manager.js";

export function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith("../");
}

export function listeningSockets(text: string) {
  return text.split("\n").flatMap((line) => {
    const local = line.trim().split(/\s+/)[3];
    const address = local?.match(/^(.*):(\d+)$/);
    if (!address) return [];
    const port = Number(address[2]);
    if (port < 1 || port > 65535) return [];
    return [...line.matchAll(/"([^"]+)",pid=(\d+)/g)].map((match) => ({ name: match[1]!, pid: Number(match[2]), port, address: address[1]!.replace(/^\[|\]$/g, "") }));
  });
}

export function parseGpus(text: string): Gpu[] {
  return text.split("\n").flatMap((line) => {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 4) return [];
    const values = parts.slice(-3).map((s) => s && Number.isFinite(Number(s)) && Number(s) >= 0 ? Number(s) : null);
    const parsed = Gpu.safeParse({ name: parts.slice(0, -3).join(", ").replace(/^"|"$/g, ""), usePct: values[0], memoryUsedMiB: values[1], memoryTotalMiB: values[2] });
    return parsed.success ? [parsed.data] : [];
  });
}

export async function certificateDays(url: string): Promise<number | null> {
  let address: URL;
  try { address = new URL(url); } catch { return null; }
  if (address.protocol !== "https:") return null;
  return new Promise((resolve) => {
    const finish = (days: number | null) => { socket.destroy(); resolve(days); };
    const socket = connect({ host: address.hostname, port: Number(address.port || 443), servername: address.hostname }, () => {
      const expires = Date.parse(socket.getPeerCertificate().valid_to);
      finish(Number.isFinite(expires) ? Math.floor((expires - Date.now()) / 86_400_000) : null);
    });
    socket.setTimeout(3000, () => finish(null));
    socket.once("error", () => finish(null)); socket.once("close", () => resolve(null));
  });
}

/** Measurements are observations, not lifecycle changes. Slow disk/TLS/GPU probes are cached for three minutes. */
export class Resources {
  private cache = new Map<string, { until: number; value: Promise<unknown> }>();
  constructor(private store: Store, private run: Runner, private certificate = certificateDays) {}

  private cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    for (const [name, entry] of this.cache) if (entry.until <= Date.now()) this.cache.delete(name);
    const previous = this.cache.get(key);
    if (previous && previous.until > Date.now()) return previous.value as Promise<T>;
    const value = read().catch((err) => { this.cache.delete(key); throw err; });
    this.cache.set(key, { until: Date.now() + 180_000, value });
    return value;
  }

  async overview(): Promise<ResourcesOverview> {
    const gpus = await this.cached("gpus", () => this.run("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], { timeout: 5000 }).then((r) => parseGpus(r.stdout), () => null));
    const projects = this.store.listProjects().map((project) => {
      const services = this.store.listLanes(project.id).flatMap((lane) => this.store.environment(lane.id)?.services ?? []);
      const up = services.filter((s) => s.state === "healthy").length;
      return { project: project.id, up, down: services.length - up };
    });
    return { projects, gpus };
  }

  async project(id: ProjectId): Promise<RunFacts> {
    if (!this.store.getProject(id)) throw new NotFound("no such project");
    const lanes = await Promise.all(this.store.listLanes(id).filter((l) => !["cleaned", "archived"].includes(l.state)).map(async (lane) => {
      const [diskBytes, certificates] = await Promise.all([
        this.cached(`disk:${lane.worktree}`, () => this.run("du", ["-sb", "--", lane.worktree], { timeout: 10_000 }).then((r) => {
          const word = r.stdout.trim().split(/\s+/)[0]!;
          if (!/^\d+$/.test(word)) return null;
          const size = Number(word);
          return Number.isSafeInteger(size) && size >= 0 ? size : null;
        }, () => null)),
        Promise.all((this.store.environment(lane.id)?.services ?? []).flatMap((s) => s.url ? [this.cached(`tls:${s.url}`, () => this.certificate(s.url!))] : [])),
      ]);
      const known = certificates.filter((days): days is number => days !== null);
      return { lane: lane.id, diskBytes, certificateDays: known.length && known.length === certificates.length ? Math.min(...known) : null };
    }));
    return { lanes, outside: await this.outside(id) };
  }

  private async outside(id: ProjectId): Promise<OutsideService[] | null> {
    const [text, bootId] = await Promise.all([this.run("ss", ["-ltnpH"], { timeout: 5000 }).then((r) => r.stdout, () => null),
      this.cached("boot", () => this.run("cat", ["/proc/sys/kernel/random/boot_id"], { timeout: 2000 }).then((r) => r.stdout.trim(), () => null))]);
    if (text === null || !bootId) return null;
    const lanes = this.store.listLanes(id), roots = [this.store.getProject(id)!.path, ...lanes.map((l) => l.worktree)];
    const owned = lanes.flatMap((lane) => [lane.hostUnit, ...(this.store.environment(lane.id)?.services.map((s) => s.unit) ?? [])]).filter((unit): unit is string => !!unit);
    const sockets = listeningSockets(text), processes = [...new Set(sockets.map((s) => s.pid))];
    const result: OutsideService[] = [];
    // Bound concurrent /proc commands even when a project has many listeners.
    for (let i = 0; i < processes.length; i += 16) await Promise.all(processes.slice(i, i + 16).map(async (pid) => {
      try {
        const cwd = (await this.run("readlink", ["-e", `/proc/${pid}/cwd`], { timeout: 2000 })).stdout.trim();
        if (!roots.some((root) => inside(root, cwd))) return;
        const [group, stat, argv] = await Promise.all(["cgroup", "stat", "cmdline"].map((file) => this.run("cat", [`/proc/${pid}/${file}`], { timeout: 2000 }).then((r) => r.stdout)));
        if (owned.some((unit) => group!.includes(`/${unit.replace(/\.service$/, "")}.service`))) return;
        const startTicks = stat!.slice(stat!.lastIndexOf(")") + 2).split(/\s+/)[19];
        const command = argv!.split("\0"); if (command.at(-1) === "") command.pop();
        for (const socket of sockets.filter((s) => s.pid === pid)) {
          const bind = socket.address === "::1" || socket.address.startsWith("127.") || socket.address.startsWith("::ffff:127.") ? "localhost only" : ["0.0.0.0", "::", "*"].includes(socket.address) ? "all addresses" : "specific address";
          const parsed = OutsideService.safeParse({ ...socket, cwd, bootId, startTicks, command, bind, adoptedLane: startTicks ? this.store.serviceAdoption(id, pid, startTicks, socket.port, bootId) : null });
          if (parsed.success) result.push(parsed.data);
        }
      } catch { /* An observed process may exit before its /proc files are read. */ }
    }));
    return result.sort((a, b) => a.port - b.port || a.pid - b.pid);
  }
}
