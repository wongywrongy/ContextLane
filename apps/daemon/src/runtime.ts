import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { EnvironmentView, Lane, LogLine, Project, Recipe, RecipeService, RecipeView, ServiceStatus } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Config } from "./config.js";
import type { Store } from "./db/store.js";
import { NotFound, Refused } from "./lanes/manager.js";
import { Previews } from "./previews.js";
import { laneRecipe } from "./recipes.js";
import type { Runner } from "./run.js";
import { sandbox } from "./sandbox.js";

const PROBES = 24;
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|\[::1\]|\[::ffff:127\.\d+\.\d+\.\d+\])$/;
const RUNS_IN = ["working", "needs_you", "in_review", "paused", "failed"];

export type RuntimeDeps = { store: Store; bus: EventBus; config: Config; run: Runner; fetch?: typeof fetch; freePort?: () => Promise<number>; previews?: Previews };

/** systemd reads $ in a command; recipes mean a literal one, after our own substitution. */
const literal = (args: string[]) => args.map((a) => a.replaceAll("$", "$$$$"));
const setenv = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`);
const expand = (args: string[], env: Record<string, string>) => args.map((a) => a.replace(/\$(PORT(?:_[A-Z0-9_]+)?|HOST)\b/g, (whole, name: string) => env[name] ?? whole));

export function serviceArgs(unit: string, dir: string, service: RecipeService, env: Record<string, string>, wrap: string[]): string[] {
  return ["--user", `--unit=${unit}`, "--collect", `--working-directory=${dir}`, "--property=Restart=on-failure", "--property=RestartSec=2", "--property=TimeoutStopSec=5",
    ...setenv({ ...service.env, ...env }), "--", ...literal([...wrap, ...expand(service.command, env)])];
}

/** Run one command to completion in its own unit, so a timeout ends everything it started. */
export async function oneshot(run: Runner, dir: string, command: string[], env: Record<string, string>, timeoutSeconds: number, wrap: string[]): Promise<{ ok: boolean; output: string; ms: number }> {
  const started = Date.now();
  const args = ["--user", "--wait", "--pipe", "--collect", "--quiet", `--working-directory=${dir}`, `--property=RuntimeMaxSec=${timeoutSeconds}s`, ...setenv(env), "--", ...literal([...wrap, ...expand(command, env)])];
  try {
    const { stdout } = await run("systemd-run", args, { timeout: (timeoutSeconds + 15) * 1000 });
    return { ok: true, output: stdout.slice(-4000), ms: Date.now() - started };
  } catch (err) {
    const { stdout = "", stderr = "", message } = err as Error & { stdout?: string; stderr?: string };
    return { ok: false, output: (`${stdout}${stderr}` || message).slice(-4000), ms: Date.now() - started };
  }
}

/** Addresses from `ss -H -ltnp` that belong to these processes and reach beyond loopback. */
export function publicBindings(ss: string, pids: Set<string>): string[] {
  const found = new Set<string>();
  for (const line of ss.split("\n")) {
    const [, , , local] = line.trim().split(/\s+/);
    if (!local || ![...line.matchAll(/pid=(\d+)/g)].some((m) => pids.has(m[1]!))) continue;
    const address = local.slice(0, local.lastIndexOf(":")).replace(/%.*$/, "");
    if (!LOOPBACK.test(address)) found.add(local);
  }
  return [...found];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
  });
}

/**
 * A lane's running copy of the app: setup from the approved recipe, one systemd user unit per
 * service, health from the unit, its listeners and an HTTP probe. The units outlive the daemon;
 * the environment row is how a restarted daemon finds them again.
 */
export class Runtime {
  private readonly starting = new Map<string, Promise<EnvironmentView>>();
  private readonly fetch: typeof fetch;
  private timer: NodeJS.Timeout | null = null;
  private readonly previews: Previews;
  private readonly previewRetry = new Map<string, number>();

  constructor(private readonly deps: RuntimeDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.previews = deps.previews ?? new Previews(deps);
  }

  status(id: string): EnvironmentView | null {
    this.lane(id);
    return this.deps.store.environment(id);
  }

  /** Waits for health, so the agent can use the app as soon as this returns. Concurrent starts share one run. */
  start(id: string, only?: string[]): Promise<EnvironmentView> {
    const running = this.starting.get(id);
    if (running) return running;
    const started = this.bringUp(id, only).finally(() => this.starting.delete(id));
    this.starting.set(id, started);
    return started;
  }

  async stop(id: string): Promise<EnvironmentView | null> {
    this.lane(id);
    const env = this.deps.store.environment(id);
    if (!env) return null;
    await Promise.allSettled(env.services.filter((s) => s.state !== "stopped").map((s) => this.deps.run("systemctl", ["--user", "stop", s.unit])));
    await Promise.allSettled(env.services.flatMap((s) => s.url ? [this.previews.unpublish(s.url)] : []));
    for (const service of env.services) this.update(env, service, { state: "stopped", detail: null, ms: null, url: null });
    return this.deps.store.environment(id);
  }

  previewUrl(id: string, name: string): { service: string; url: string } {
    this.lane(id);
    const service = this.deps.store.environment(id)?.services.find((s) => s.name === name);
    if (!service?.url) throw new Refused(`${name} has no link yet. Start it with env_start and wait until it is healthy.`);
    return { service: name, url: service.url };
  }

  async logs(id: string, name: string, lines: number): Promise<LogLine[]> {
    this.lane(id);
    const service = this.deps.store.environment(id)?.services.find((s) => s.name === name);
    if (!service) throw new Refused(`This lane has no service called ${name}.`, 404);
    const { stdout } = await this.deps.run("journalctl", ["--user", `--unit=${service.unit}`, "-n", String(lines), "--no-pager", "-o", "json", "--output-fields=MESSAGE"]);
    return stdout.split("\n").filter(Boolean).map((line) => {
      const entry = JSON.parse(line) as { __REALTIME_TIMESTAMP: string; MESSAGE: string | number[] | null };
      const text = typeof entry.MESSAGE === "string" ? entry.MESSAGE : Array.isArray(entry.MESSAGE) ? Buffer.from(entry.MESSAGE).toString("utf8") : "";
      return { at: new Date(Number(entry.__REALTIME_TIMESTAMP) / 1000).toISOString(), text };
    });
  }

  /** One pass of the health loop. */
  async poll(): Promise<void> {
    await Promise.all(this.deps.store.liveEnvironments().map((env) => this.probe(env.lane)));
  }

  watch(intervalMs = 5000): void {
    let busy = false;
    this.timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void this.poll().catch(() => {}).finally(() => { busy = false; });
    }, intervalMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private lane(id: string): Lane {
    const lane = this.deps.store.getLane(id);
    if (!lane) throw new NotFound(`no lane ${id}`);
    return lane;
  }

  /** The lane's approved recipe, or null when the project has none. */
  async recipeFor(lane: Lane): Promise<Recipe | null> {
    const view = await laneRecipe(this.deps.store, this.deps.store.getProject(lane.project)!, lane);
    return view ? this.approved(lane, view) : null;
  }

  /**
   * Run a service from a temporary checkout of another commit, for the "before" screenshot. The
   * checkout holds nothing of value, so it is removed by force whatever happens.
   */
  async fromCommit<T>(lane: Lane, recipe: Recipe, commit: string, use: (port: number) => Promise<T>): Promise<T> {
    const { run, store, config } = this.deps;
    const project = store.getProject(lane.project)!;
    const service = recipe.services.find((s) => s.name === "web") ?? recipe.services[0]!;
    // Beside the lanes: services for this checkout run in the sandbox, which hides the data folder.
    const dir = join(config.paths.lanes, ".before", randomBytes(6).toString("hex"));
    const units: string[] = [];
    await mkdir(dirname(dir), { recursive: true });
    await run("git", ["worktree", "add", "--detach", dir, commit], { cwd: project.path });
    try {
      const ports = Object.fromEntries(await Promise.all(recipe.services.map(async (s) => [s.name, await (this.deps.freePort ?? freePort)()] as const)));
      const shared = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOST: "127.0.0.1", ...Object.fromEntries(Object.entries(ports).map(([name, port]) => [`PORT_${name.toUpperCase().replaceAll("-", "_")}`, String(port)])) };
      await this.prepare({ ...lane, worktree: dir }, project, recipe, shared);
      for (const each of recipe.services) {
        const unit = `contextlanes-env-before-${randomBytes(4).toString("hex")}`;
        await run("systemd-run", serviceArgs(unit, dir, each, { ...shared, [each.port.env]: String(ports[each.name]!), PORT: String(ports[each.name]!) }, sandbox(this.deps.config)));
        units.push(unit);
      }
      const deadline = Date.now() + service.health.timeoutSeconds * 1000;
      for (;;) {
        const status = await this.fetch(`http://127.0.0.1:${ports[service.name]}${service.health.path}`, { redirect: "manual", signal: AbortSignal.timeout(2000) }).then(async (r) => { await r.body?.cancel(); return r.status; }, () => 0);
        if (status === service.health.status) break;
        if (Date.now() >= deadline) throw new Error(`${service.name} did not become healthy from ${commit.slice(0, 7)}.`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return await use(ports[service.name]!);
    } finally {
      await Promise.allSettled(units.map((unit) => run("systemctl", ["--user", "stop", unit])));
      await run("git", ["worktree", "remove", "--force", dir], { cwd: project.path }).catch(() => {});
    }
  }

  private approved(lane: Lane, view: RecipeView | null): Recipe {
    const { store, bus } = this.deps;
    if (!view) throw new Refused("This project has no .contextlanes.json yet, so there is nothing to start.");
    if (!view.recipe) throw new Refused(`The recipe cannot be used. ${view.error}`);
    if (!view.approved) {
      if (!store.recipeAlreadyRequested(lane.id, view.hash)) bus.publish(store.appendEvent(lane.id, { type: "recipe.requested", payload: { hash: view.hash } }));
      throw new Refused(`The recipe ${view.hash.slice(0, 7)} needs the owner's approval on the Run page before it can start.`);
    }
    return view.recipe;
  }

  private async bringUp(id: string, only?: string[]): Promise<EnvironmentView> {
    const { store } = this.deps;
    const lane = this.lane(id);
    if (!RUNS_IN.includes(lane.state)) throw new Refused("This lane has finished, so its environment cannot start.");
    const project = store.getProject(lane.project)!;
    const view = await laneRecipe(store, project, lane);
    const recipe = this.approved(lane, view);
    const unknown = only?.find((name) => !recipe.services.some((s) => s.name === name));
    if (unknown) throw new Refused(`The recipe has no service called ${unknown}.`, 404);

    const previous = store.environment(id);
    // A newly approved recipe replaces what runs: stop the old units (keeping each service's port, so links stay the same) and drop services it no longer has.
    const changed = !!previous && previous.recipeHash !== view!.hash;
    if (changed) {
      for (const s of previous.services.filter((s) => s.state !== "stopped")) {
        await this.deps.run("systemctl", ["--user", "stop", s.unit]).catch(() => {});
        this.deps.bus.publish(store.appendEvent(id, { type: "env.status", payload: { service: s.name, up: false, port: s.port, state: "stopped", detail: "Stopped because the recipe changed." } }));
      }
    }
    const carried = changed ? previous.services.filter((s) => recipe.services.some((r) => r.name === s.name)).map((s) => ({ ...s, state: "stopped" as const })) : previous?.services ?? [];
    const env: EnvironmentView = previous && !changed ? { ...previous, error: null } : { lane: id, recipeHash: view!.hash, services: carried, setup: null, startedAt: null, error: null };
    const ports = Object.fromEntries(await Promise.all(recipe.services.map(async (s) => [s.name, env.services.find((x) => x.name === s.name)?.port ?? await (this.deps.freePort ?? freePort)()] as const)));
    const shared = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOST: "127.0.0.1", CONTEXTLANES_LANE: id, ...Object.fromEntries(Object.entries(ports).map(([name, port]) => [`PORT_${name.toUpperCase().replaceAll("-", "_")}`, String(port)])) };

    if (!env.setup) {
      try { env.setup = await this.prepare(lane, project, recipe, shared); }
      catch (err) {
        env.error = err instanceof Error ? err.message : String(err);
        store.saveEnvironment(env);
        this.deps.bus.publish(store.appendEvent(id, { type: "env.status", payload: { service: "setup", up: false, state: "failed", detail: env.error } }));
        throw new Refused(`Setup stopped. ${env.error}`);
      }
    }
    env.startedAt ??= new Date().toISOString();
    store.saveEnvironment(env);

    const chosen = recipe.services.filter((s) => (!only || only.includes(s.name)) && env.services.find((x) => x.name === s.name)?.state !== "healthy");
    for (const service of chosen) {
      const unit = `contextlanes-env-${id.replace("/", "-")}-${service.name}-${randomBytes(3).toString("hex")}`;
      const current = store.environment(id)!;
      const old = current.services.find((s) => s.name === service.name);
      if (old && old.state !== "stopped") await this.deps.run("systemctl", ["--user", "stop", old.unit]).catch(() => {});
      const port = ports[service.name]!;
      const row: ServiceStatus = { name: service.name, unit, port, url: null, state: "starting", detail: null, probes: [], ms: null, lastFailure: old?.lastFailure ?? null, healthPath: service.health.path, healthStatus: service.health.status };
      store.saveEnvironment({ ...current, services: [...current.services.filter((s) => s.name !== service.name), row] });
      try { await this.deps.run("systemd-run", serviceArgs(unit, lane.worktree, service, { ...shared, [service.port.env]: String(port), PORT: String(port) }, sandbox(this.deps.config))); }
      catch (err) { this.update(env, row, { state: "failed", detail: err instanceof Error ? err.message.slice(0, 300) : "The service unit could not start." }); continue; }
      this.deps.bus.publish(store.appendEvent(id, { type: "env.status", payload: { service: service.name, up: false, port, state: "starting" } }));
    }

    const deadline = Date.now() + Math.max(0, ...chosen.map((s) => s.health.timeoutSeconds)) * 1000;
    for (;;) {
      await this.probe(id, deadline);
      const now = store.environment(id)!;
      if (!now.services.some((s) => s.state === "starting") || Date.now() >= deadline) return now;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /** Copy ignored .env files, bring dependencies across, then run the recipe's setup steps. */
  private async prepare(lane: Lane, project: Project, recipe: Recipe, env: Record<string, string>): Promise<NonNullable<EnvironmentView["setup"]>> {
    const { run } = this.deps;
    const started = Date.now();
    const listed = await run("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ":(glob)**/.env*"], { cwd: project.path });
    const ignored: string[] = [];
    for (const file of listed.stdout.split("\0").filter(Boolean)) {
      const source = join(project.path, file);
      if (!(await lstat(source)).isFile()) continue;
      const target = join(lane.worktree, file);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target, fsConstants.COPYFILE_EXCL).catch((err: NodeJS.ErrnoException) => { if (err.code !== "EEXIST") throw err; });
      ignored.push(file);
    }
    let cache: "none" | "linked" | "copied" = "none";
    for (const path of recipe.cache) {
      const source = join(project.path, path);
      const target = join(lane.worktree, path);
      const present = async (p: string) => lstat(p).then(() => true, () => false);
      if (!(await present(source)) || await present(target)) continue;
      await mkdir(dirname(target), { recursive: true });
      // Hard links are instant; another filesystem falls back to a copy.
      try { await run("cp", ["-al", source, target]); cache = cache === "copied" ? cache : "linked"; }
      catch { await run("cp", ["-a", "--reflink=auto", source, target]); cache = "copied"; }
    }
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    for (const step of recipe.setup) {
      const result = await oneshot(run, lane.worktree, step.command, env, step.timeoutSeconds, sandbox(this.deps.config));
      if (!result.ok) throw new Error(`${step.name} failed: ${result.output.trim().slice(-600)}`);
    }
    const disk = await run("du", ["-sb", lane.worktree]).then((r) => Number(r.stdout.split(/\s/)[0]), () => null);
    return { ignored, cache, seconds, steps: recipe.setup.length, disk: Number.isFinite(disk) ? disk : null };
  }

  private async probe(id: string, deadline?: number): Promise<void> {
    const env = this.deps.store.environment(id);
    if (!env) return;
    // A service stopped for binding publicly stays stopped until someone restarts it.
    await Promise.all(env.services.filter((s) => s.state !== "stopped" && !s.detail?.startsWith("Stopped:")).map(async (service) => {
      const seen = await this.observe(service);
      const probes = [...service.probes, seen.ok].slice(-PROBES);
      const now = new Date().toISOString();
      if (seen.publicAddress) {
        await this.deps.run("systemctl", ["--user", "stop", service.unit]).catch(() => {});
        this.update(env, service, { state: "failed", probes, lastFailure: now, detail: `Stopped: it listened on ${seen.publicAddress}. Services must bind 127.0.0.1 ($HOST).` });
      } else if (seen.ok) {
        this.update(env, service, { state: "healthy", probes, ms: seen.ms, detail: null });
        await this.link(id, service);
      } else if (service.state === "starting") {
        if (!deadline || Date.now() >= deadline) this.update(env, service, { state: "failed", probes, lastFailure: now, detail: seen.detail });
      } else {
        this.update(env, service, { state: "failed", probes, lastFailure: service.state === "healthy" ? now : service.lastFailure, ms: null, detail: seen.detail });
      }
    }));
  }

  private async observe(service: ServiceStatus): Promise<{ ok: boolean; ms: number; detail: string; publicAddress?: string }> {
    const { run } = this.deps;
    const shown = (await run("systemctl", ["--user", "show", "--property=ActiveState", "--property=ControlGroup", service.unit]).then((r) => r.stdout, () => ""));
    const field = (name: string) => shown.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1] ?? "";
    if (field("ActiveState") !== "active") return { ok: false, ms: 0, detail: `The service is not running (${field("ActiveState") || "gone"}). Check its logs.` };
    const pids = await run("cat", [`/sys/fs/cgroup${field("ControlGroup")}/cgroup.procs`]).then((r) => new Set(r.stdout.split("\n").filter(Boolean)), () => new Set<string>());
    const publicAddress = publicBindings(await run("ss", ["-H", "-ltnp"]).then((r) => r.stdout, () => ""), pids)[0];
    if (publicAddress) return { ok: false, ms: 0, detail: "", publicAddress };
    const started = Date.now();
    try {
      const response = await this.fetch(`http://127.0.0.1:${service.port}${service.healthPath}`, { redirect: "manual", signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      return { ok: response.status === service.healthStatus, ms: Date.now() - started, detail: `${service.healthPath} answered ${response.status}, not ${service.healthStatus}.` };
    } catch { return { ok: false, ms: 0, detail: `Nothing answered on ${service.healthPath}.` }; }
  }

  /** A healthy service gets its link. A failed link never stops the app; it says why and retries. */
  private async link(id: string, service: ServiceStatus): Promise<void> {
    if (service.url || Date.now() < (this.previewRetry.get(service.unit) ?? 0)) return;
    const { store } = this.deps;
    this.previewRetry.set(service.unit, Date.now() + 60_000);
    try {
      const url = await this.previews.publish(this.lane(id), service.name, service.port);
      this.update(store.environment(id)!, service, { url });
      const env = store.environment(id)!;
      if (env.error?.startsWith(`Preview link for ${service.name}`)) store.saveEnvironment({ ...env, error: null });
    } catch (err) {
      const env = store.environment(id)!;
      store.saveEnvironment({ ...env, error: `Preview link for ${service.name} failed. ${err instanceof Refused ? err.message : "Check that Tailscale is signed in and this user may use Serve."}` });
    }
  }

  /** Save a service's new status; say so in the event log only when its state really changed. */
  private update(env: EnvironmentView, service: ServiceStatus, change: Partial<ServiceStatus>): void {
    const { store, bus } = this.deps;
    const before = store.environment(env.lane) ?? env;
    const current = before.services.find((s) => s.name === service.name) ?? service;
    const next = { ...current, ...change };
    store.saveEnvironment({ ...before, services: before.services.map((s) => s.name === service.name ? next : s) });
    if (current.state !== next.state || current.detail !== next.detail || current.url !== next.url) bus.publish(store.appendEvent(env.lane, { type: "env.status", payload: { service: next.name, up: next.state === "healthy", port: next.port, ...(next.url ? { url: next.url } : {}), state: next.state, ...(next.detail ? { detail: next.detail } : {}) } }));
  }
}
