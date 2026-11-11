import { createLaneDatabase, databaseEnv, dropLaneDatabase, laneDatabaseName } from "./databases.js";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir } from "node:fs/promises";
import { mkdirInside } from "./safefs.js";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { EnvironmentView, Lane, LogLine, Project, Recipe, RecipeService, RecipeView, ServiceStatus } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Config } from "./config.js";
import type { Store } from "./db/store.js";
import { NotFound, Refused } from "./lanes/manager.js";
import { Previews } from "./previews.js";
import { dockerRecipes, hostRecipes, type RecipeReader } from "./recipes.js";
import type { DockerLanes } from "./docker/lanes.js";
import { DockerSupervisor, loopbackOnly } from "./supervisor/docker.js";
import type { Runner } from "./run.js";
import { sandbox } from "./sandbox.js";
import { supervisorFor, SystemdSupervisor, systemdServiceArgs, type Supervisor } from "./supervisor/index.js";
export { publicBindings } from "./supervisor/index.js";

const PROBES = 24;
const RUNS_IN = ["working", "needs_you", "in_review", "paused", "failed"];

/** docker: lane containers, in the Docker runtime; a lane's services then run inside its container (docs/V4.md 3.4). */
export type RuntimeDeps = { store: Store; bus: EventBus; config: Config; run: Runner; fetch?: typeof fetch; freePort?: () => Promise<number>; previews?: Previews; supervisor?: Supervisor; docker?: DockerLanes };

/** The first port a service gets in the Docker runtime when its recipe names none: 3000, then 3001… */
export const FIRST_PORT = 3000;

/**
 * Ports in the Docker runtime: every lane has its own network namespace, so a service keeps the same port
 * in every lane, the recipe's `port.number` or the next free one from 3000 in the order of the services.
 */
export function fixedPorts(services: RecipeService[]): Record<string, number> {
  const taken = new Set(services.flatMap((s) => s.port.number === undefined ? [] : [s.port.number]));
  const ports: Record<string, number> = {};
  let next = FIRST_PORT;
  for (const s of services) {
    if (s.port.number !== undefined) { ports[s.name] = s.port.number; continue; }
    while (taken.has(next)) next++;
    ports[s.name] = next;
    taken.add(next);
  }
  return ports;
}

/** What `app status` and doctor say when a service in a lane listens only on loopback. */
export function loopbackDetail(addresses: string[], port: number): string {
  return `It listens only on ${addresses.join(", ")} inside the lane, so nothing outside the lane (the router, a browser) can reach it. Make it listen on 0.0.0.0, port ${port}: HOST is set to 0.0.0.0 and PORT to ${port} for it. Vite: --host 0.0.0.0 (or server.host); Next.js: next dev -H 0.0.0.0.`;
}

/** Variables a recipe may use in command arguments and in a service's env values. */
const EXPANDED = /\$((?:PORT|LANE_URL|LANE_HOSTNAME)(?:_[A-Z0-9_]+)?|HOST)\b/g;
export const expand = (args: string[], env: Record<string, string>) => args.map((a) => a.replace(EXPANDED, (whole, name: string) => env[name] ?? whole));
const envKey = (name: string) => name.toUpperCase().replaceAll("-", "_");

/**
 * Where each service is reached from a browser: LANE_URL_<SERVICE> and LANE_HOSTNAME_<SERVICE> for every
 * service, so a web app can point at its API. Empty in serve mode, where a link is chosen only on publish.
 */
export function laneUrls(previews: Pick<Previews, "urlFor">, lane: Pick<Lane, "id">, services: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  services.forEach((name, i) => {
    const url = previews.urlFor(lane, name);
    if (!url) return;
    const host = new URL(url).hostname;
    Object.assign(env, { [`LANE_URL_${envKey(name)}`]: url, [`LANE_HOSTNAME_${envKey(name)}`]: host }, i === 0 ? { LANE_URL: url, LANE_HOSTNAME: host } : {});
  });
  return env;
}

/** One service's own address as LANE_URL and LANE_HOSTNAME, and its hostname allowed by Vite's dev server. */
export function ownUrl(env: Record<string, string>, service: string): Record<string, string> {
  const url = env[`LANE_URL_${envKey(service)}`];
  const host = env[`LANE_HOSTNAME_${envKey(service)}`];
  return url && host ? { LANE_URL: url, LANE_HOSTNAME: host, __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: host } : {};
}

/** A recipe service as the supervisor runs it: its env values and arguments expanded, inside the sandbox prefix. */
export function serviceSpec(service: RecipeService, env: Record<string, string>, wrap: string[]): { argv: string[]; env: Record<string, string> } {
  const own = Object.fromEntries(Object.entries(service.env).map(([key, value]) => [key, expand([value], env)[0]!]));
  return { argv: [...wrap, ...expand(service.command, env)], env: { ...own, ...env } };
}

/** systemd-run arguments for a recipe service. */
export function serviceArgs(unit: string, dir: string, service: RecipeService, env: Record<string, string>, wrap: string[]): string[] {
  return systemdServiceArgs(unit, { dir, ...serviceSpec(service, env, wrap), restart: true });
}

/** Run one command to completion in its own systemd unit, so a timeout ends everything it started. */
export function oneshot(run: Runner, dir: string, command: string[], env: Record<string, string>, timeoutSeconds: number, wrap: string[]): Promise<{ ok: boolean; output: string; ms: number }> {
  return new SystemdSupervisor(run).oneshot({ dir, argv: [...wrap, ...expand(command, env)], env, timeoutSeconds });
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
  readonly supervisor: Supervisor;
  /** Where recipes are read: the folders on the host, inside the lane (and a helper) in the Docker runtime. */
  readonly recipes: RecipeReader;

  constructor(private readonly deps: RuntimeDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.previews = deps.previews ?? new Previews(deps);
    this.supervisor = deps.supervisor ?? supervisorFor(deps.config, deps.run);
    this.recipes = this.dockerLanes ? dockerRecipes(deps.store, this.dockerLanes) : hostRecipes(deps.store);
  }

  /** The lane containers, when this is the Docker runtime. */
  private get dockerLanes(): DockerLanes | undefined { return this.deps.config.runtime.mode === "docker" ? this.deps.docker : undefined; }
  private get docker(): boolean { return this.deps.config.runtime.mode === "docker"; }

  /**
   * Where a lane's services run. The Docker runtime: inside the lane's own container, through its docker
   * driver, never on the control side (which cannot see the checkout). The host: the configured supervisor.
   */
  private supervisorOf(lane: Lane): Supervisor {
    if (!this.docker) return this.supervisor;
    const lanes = this.dockerLanes;
    if (!lanes) throw new Refused("The control service could not read its own container from Docker, so lanes' apps cannot run. Run contextlanes doctor.", 503, "docker_unreachable");
    if (!lanes.isDocker(lane)) throw new Refused(`${lane.id} was made before ContextLanes ran in Docker and has no container, so its app cannot run here. Start a new lane.`, 409, "no_container");
    return lanes.supervisor(lane);
  }

  /** The lane's container must be running for anything to start in it (restarting a stopped one is v4 phase 5). */
  private needRunning(lane: Lane): void {
    const state = this.dockerLanes?.state(lane);
    if (this.docker && state !== "running") throw new Refused(`The lane's container ${lane.terminal} is ${state ?? "not there"}, so its app cannot start. Starting a stopped lane container again arrives in a later v4 phase.`, 409, "container_not_running");
  }

  /** Where the router, health checks and doctor reach a service: the lane container by name in Docker. */
  private hostOf(lane: Lane): string {
    return this.docker ? this.dockerLanes?.target(lane)?.container ?? lane.terminal : "127.0.0.1";
  }

  /** The prefix for every command a recipe starts: bubblewrap on the host, nothing in a lane container. */
  private wrap(): string[] { return this.docker ? [] : sandbox(this.deps.config); }

  /** PATH for recipe commands: the daemon's on the host, the lane's own (tools first) in its container. */
  private pathOf(lane: Lane): string {
    return this.docker ? this.dockerLanes?.target(lane)?.path ?? "/usr/local/bin:/usr/bin:/bin" : process.env.PATH ?? "/usr/bin:/bin";
  }

  /** Each service's port: allocated per lane on the host, the recipe's own in Docker. Kept ports stay. */
  private async portsFor(recipe: Recipe, kept: ServiceStatus[]): Promise<Record<string, number>> {
    if (this.docker) return fixedPorts(recipe.services);
    return Object.fromEntries(await Promise.all(recipe.services.map(async (s) => [s.name, kept.find((x) => x.name === s.name)?.port ?? await (this.deps.freePort ?? freePort)()] as const)));
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
    const lane = this.lane(id);
    const env = this.deps.store.environment(id);
    if (!env) return null;
    const supervisor = env.services.some((s) => s.state !== "stopped") ? this.supervisorOf(lane) : this.supervisor;
    await Promise.allSettled(env.services.filter((s) => s.state !== "stopped").map((s) => supervisor.stop(s.unit)));
    await Promise.allSettled(env.services.flatMap((s) => s.url ? [this.previews.unpublish(s.url)] : []));
    for (const service of env.services) this.update(env, service, { state: "stopped", detail: null, ms: null, url: null });
    return this.deps.store.environment(id);
  }

  /** Restart everything, or only the named services (the rest keep running). */
  async restart(id: string, only?: string[]): Promise<EnvironmentView> {
    if (!only?.length) { await this.stop(id); return this.start(id); }
    const env = this.deps.store.environment(id);
    for (const service of env?.services.filter((s) => only.includes(s.name) && s.state !== "stopped") ?? []) {
      await this.supervisorOf(this.lane(id)).stop(service.unit).catch(() => {});
      this.update(this.deps.store.environment(id)!, service, { state: "stopped", detail: null, ms: null });
    }
    return this.start(id, only);
  }

  previewUrl(id: string, name: string): { service: string; url: string } {
    const lane = this.lane(id);
    const service = this.deps.store.environment(id)?.services.find((s) => s.name === name);
    if (!service) throw new Refused(`This lane has no service called ${name}. Start the environment first.`, 404);
    const live = service.state === "healthy" && (this.deps.config.previews.mode === "router" ? this.previews.routed(lane, name) : !!service.url);
    if (!service.url || !live) throw new Refused(`${name} has no working link yet (it is ${service.state}). Start it and wait until it is healthy.`);
    return { service: name, url: service.url };
  }

  /**
   * After a daemon restart the router's table is empty while services kept running. Healthy services get
   * their routes back before the HTTP server takes requests, instead of waiting for the next probe.
   */
  async restoreLinks(): Promise<number> {
    if (this.deps.config.previews.mode !== "router") return 0;
    await this.previews.start();
    let restored = 0;
    for (const env of this.deps.store.liveEnvironments()) {
      const lane = this.deps.store.getLane(env.lane);
      if (!lane) continue;
      if (this.docker && !this.dockerLanes?.target(lane)) continue;
      for (const service of env.services.filter((s) => s.state === "healthy")) {
        await this.previews.publish(lane, service.name, service.port, this.hostOf(lane));
        restored++;
      }
    }
    return restored;
  }

  /**
   * Clean up drops the lane's Postgres copy. The name is derived from the lane, so a copy made by a setup
   * that failed later is found too. A failure is reported rather than leaving the copy silently.
   */
  async dropDatabase(lane: Lane): Promise<void> {
    const made = this.deps.store.environment(lane.id)?.setup?.database;
    const recipe = made ? null : await this.recipeFor(lane).catch(() => null);
    const target = made ?? (recipe?.database?.kind === "postgres" ? { kind: "postgres" as const, name: laneDatabaseName(recipe.database.template, lane.id), template: recipe.database.template } : null);
    if (!target) return;
    await dropLaneDatabase(this.deps.run, this.deps.config, target).catch((err: { stderr?: string; message?: string }) => {
      throw new Refused(`The lane's database ${target.name} could not be dropped, so the lane was kept. ${String(err.stderr ?? err.message ?? "").trim().split("\n").at(-1) ?? ""}`);
    });
  }

  async logs(id: string, name: string, lines: number): Promise<LogLine[]> {
    const lane = this.lane(id);
    const service = this.deps.store.environment(id)?.services.find((s) => s.name === name);
    if (!service) throw new Refused(`This lane has no service called ${name}.`, 404);
    return this.supervisorOf(lane).logs(service.unit, lines);
  }

  /** An approved setup runs before the agent; unapproved recipes remain an owner decision. */
  async prepareWorkspace(lane: Lane): Promise<void> {
    const project = this.deps.store.getProject(lane.project)!;
    const view = await this.recipes.lane(project, lane);
    if (!view) return;
    if (!view.approved || !view.recipe) {
      if (!this.deps.store.recipeAlreadyRequested(lane.id, view.hash)) this.deps.bus.publish(this.deps.store.appendEvent(lane.id, { type: "recipe.requested", payload: { hash: view.hash } }));
      return;
    }
    const fixed = await this.portsFor(view.recipe, []);
    const services: ServiceStatus[] = view.recipe.services.map((s) => ({ name: s.name, unit: "", port: fixed[s.name]!, url: null, state: "stopped", detail: null, probes: [], ms: null, lastFailure: null, healthPath: s.health.path, healthStatus: s.health.status }));
    const ports = Object.fromEntries(services.map((s) => [`PORT_${s.name.toUpperCase().replaceAll("-", "_")}`, String(s.port)]));
    const setup = await this.prepare(lane, project, view.recipe, { PATH: this.pathOf(lane), HOST: this.docker ? "0.0.0.0" : "127.0.0.1", CONTEXTLANES_LANE: lane.id, ...ports, ...(services[0] ? { PORT: String(services[0].port) } : {}), ...laneUrls(this.previews, lane, services.map((s) => s.name)) });
    this.deps.store.saveEnvironment({ lane: lane.id, recipeHash: view.hash, services, setup, startedAt: null, error: null });
    this.deps.bus.publish(this.deps.store.appendEvent(lane.id, { type: "env.status", payload: { service: "setup", up: true, state: "healthy" } }));
  }

  async teardown(id: string): Promise<void> {
    const lane = this.lane(id);
    const view = await this.recipes.lane(this.deps.store.getProject(lane.project)!, lane);
    if (!view?.recipe?.scripts.teardown) return;
    const recipe = this.approved(lane, view);
    const env = { PATH: this.pathOf(lane), CONTEXTLANES_LANE: id };
    const result = await this.supervisorOf(lane).oneshot({ dir: lane.worktree, argv: [...this.wrap(), ...expand(scriptArgs(recipe.scripts.teardown!), env)], env, timeoutSeconds: 600 });
    this.deps.bus.publish(this.deps.store.appendEvent(id, { type: "env.status", payload: { service: "teardown", up: result.ok, state: result.ok ? "stopped" : "failed", detail: result.output.slice(-600) } }));
    if (!result.ok) throw new Refused(`Teardown failed; checkout kept. ${result.output}`);
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
    this.previews.close();
  }

  /** The preview links this runtime publishes; shared with whatever else needs the router. */
  get links(): Previews { return this.previews; }

  private lane(id: string): Lane {
    const lane = this.deps.store.getLane(id);
    if (!lane) throw new NotFound(`no lane ${id}`);
    return lane;
  }

  /** The lane's approved recipe, or null when the project has none. */
  async recipeFor(lane: Lane): Promise<Recipe | null> {
    const view = await this.recipes.lane(this.deps.store.getProject(lane.project)!, lane);
    return view ? this.approved(lane, view) : null;
  }

  /**
   * Run a service from a temporary checkout of another commit, for the "before" screenshot. The
   * checkout holds nothing of value, so it is removed by force whatever happens.
   */
  async fromCommit<T>(lane: Lane, recipe: Recipe, commit: string, use: (port: number) => Promise<T>): Promise<T> {
    if (this.docker) throw new Refused("Before screenshots run the app from another commit, which does not run in the Docker setup yet (a later v4 phase).", 501, "not_yet");
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
        await this.supervisor.start(unit, { dir, ...serviceSpec(each, { ...shared, [each.port.env]: String(ports[each.name]!), PORT: String(ports[each.name]!) }, sandbox(this.deps.config)), restart: true });
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
      await Promise.allSettled(units.map((unit) => this.supervisor.stop(unit)));
      await run("git", ["worktree", "remove", "--force", dir], { cwd: project.path }).catch(() => {});
    }
  }

  private approved(lane: Lane, view: RecipeView | null): Recipe {
    const { store, bus } = this.deps;
    if (!view) throw new Refused("This project has no .contextlanes.json yet, so there is nothing to start.", 409, "no_recipe");
    if (!view.recipe) throw new Refused(`The recipe cannot be used. ${view.error}`);
    if (!view.approved) {
      if (!store.recipeAlreadyRequested(lane.id, view.hash)) bus.publish(store.appendEvent(lane.id, { type: "recipe.requested", payload: { hash: view.hash } }));
      throw new Refused(`The recipe ${view.hash.slice(0, 7)} needs the owner's approval on the Run page before it can start (owner: contextlanes approve ${lane.id}).`, 409, "recipe_unapproved");
    }
    return view.recipe;
  }

  private async bringUp(id: string, only?: string[]): Promise<EnvironmentView> {
    const { store } = this.deps;
    const lane = this.lane(id);
    if (!RUNS_IN.includes(lane.state)) throw new Refused("This lane has finished, so its environment cannot start.");
    const supervisor = this.supervisorOf(lane);
    this.needRunning(lane);
    const project = store.getProject(lane.project)!;
    const view = await this.recipes.lane(project, lane);
    const recipe = this.approved(lane, view);
    const unknown = only?.find((name) => !recipe.services.some((s) => s.name === name));
    if (unknown) throw new Refused(`The recipe has no service called ${unknown}.`, 404);

    const previous = store.environment(id);
    // A newly approved recipe replaces what runs: stop the old units (keeping each service's port, so links stay the same) and drop services it no longer has.
    const changed = !!previous && previous.recipeHash !== view!.hash;
    if (changed) {
      for (const s of previous.services.filter((s) => s.state !== "stopped")) {
        await supervisor.stop(s.unit).catch(() => {});
        this.deps.bus.publish(store.appendEvent(id, { type: "env.status", payload: { service: s.name, up: false, port: s.port, state: "stopped", detail: "Stopped because the recipe changed." } }));
      }
    }
    const carried = changed ? previous.services.filter((s) => recipe.services.some((r) => r.name === s.name)).map((s) => ({ ...s, state: "stopped" as const })) : previous?.services ?? [];
    const env: EnvironmentView = previous && !changed ? { ...previous, error: null } : { lane: id, recipeHash: view!.hash, services: carried, setup: null, startedAt: null, error: null };
    const ports = await this.portsFor(recipe, env.services);
    // Docker: the service listens on every address inside the lane, which only the private network reaches.
    const shared: Record<string, string> = { PATH: this.pathOf(lane), HOST: this.docker ? "0.0.0.0" : "127.0.0.1", CONTEXTLANES_LANE: id, ...Object.fromEntries(Object.entries(ports).map(([name, port]) => [`PORT_${name.toUpperCase().replaceAll("-", "_")}`, String(port)])), ...laneUrls(this.previews, lane, recipe.services.map((s) => s.name)) };

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
    if (recipe.database && env.setup.database) Object.assign(shared, databaseEnv(this.deps.config, recipe.database, env.setup.database, lane.worktree));

    const chosen = recipe.services.filter((s) => (!only || only.includes(s.name)) && env.services.find((x) => x.name === s.name)?.state !== "healthy");
    for (const service of chosen) {
      const unit = `contextlanes-env-${id.replace("/", "-")}-${service.name}-${randomBytes(3).toString("hex")}`;
      const current = store.environment(id)!;
      const old = current.services.find((s) => s.name === service.name);
      if (old && old.state !== "stopped") await supervisor.stop(old.unit).catch(() => {});
      const port = ports[service.name]!;
      const row: ServiceStatus = { name: service.name, unit, port, url: this.previews.urlFor(lane, service.name), state: "starting", detail: null, probes: [], ms: null, lastFailure: old?.lastFailure ?? null, healthPath: service.health.path, healthStatus: service.health.status };
      store.saveEnvironment({ ...current, services: [...current.services.filter((s) => s.name !== service.name), row] });
      try { await supervisor.start(unit, { dir: lane.worktree, ...serviceSpec(service, { ...shared, ...ownUrl(shared, service.name), [service.port.env]: String(port), PORT: String(port) }, this.wrap()), restart: true }); }
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

  /** Copy selected ignored files, bring dependencies across, then run the recipe's setup steps. */
  private async prepare(lane: Lane, project: Project, recipe: Recipe, env: Record<string, string>): Promise<NonNullable<EnvironmentView["setup"]>> {
    if (this.docker) return this.prepareInLane(lane, project, recipe, env);
    const { run } = this.deps;
    const started = Date.now();
    const listed = recipe.copy.length ? await run("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...recipe.copy.map((pattern) => `:(glob)${pattern}`)], { cwd: project.path }) : { stdout: "" };
    const ignored: string[] = [];
    for (const file of listed.stdout.split("\0").filter(Boolean)) {
      const source = join(project.path, file);
      if (file.startsWith("/") || file.split("/").includes("..")) continue;
      let linked = false, at = project.path;
      for (const part of file.split("/")) { at = join(at, part); if ((await lstat(at)).isSymbolicLink()) { linked = true; break; } }
      if (linked || !(await lstat(source)).isFile()) continue;
      const target = join(lane.worktree, file);
      // The checkout is the agent's: never write through a folder it replaced with a link.
      await mkdirInside(lane.worktree, dirname(file));
      await copyFile(source, target, fsConstants.COPYFILE_EXCL).catch((err: NodeJS.ErrnoException) => { if (err.code !== "EEXIST") throw err; });
      ignored.push(file);
    }
    let cache: "none" | "linked" | "copied" = "none";
    for (const path of recipe.cache) {
      const source = join(project.path, path);
      const target = join(lane.worktree, path);
      const present = async (p: string) => lstat(p).then(() => true, () => false);
      if (!(await present(source)) || await present(target)) continue;
      await mkdirInside(lane.worktree, dirname(path));
      // Hard links are instant; another filesystem falls back to a copy.
      try { await run("cp", ["-al", source, target]); cache = cache === "copied" ? cache : "linked"; }
      catch { await run("cp", ["-a", "--reflink=auto", source, target]); cache = "copied"; }
    }
    // The database comes before setup steps, which often migrate it.
    const database = recipe.database ? await createLaneDatabase(run, this.deps.config, recipe.database, lane, project.path) : null;
    const stepEnv = recipe.database && database ? { ...env, ...databaseEnv(this.deps.config, recipe.database, database, lane.worktree) } : env;
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    const steps = [...recipe.setup, ...(recipe.scripts.setup ? [{ name: "Setup script", command: scriptArgs(recipe.scripts.setup), timeoutSeconds: 600 }] : [])];
    for (const step of steps) {
      const result = await this.supervisor.oneshot({ dir: lane.worktree, argv: [...sandbox(this.deps.config), ...expand(step.command, stepEnv)], env: stepEnv, timeoutSeconds: step.timeoutSeconds });
      if (!result.ok) throw new Error(`${step.name} failed: ${result.output.trim().slice(-600)}`);
    }
    const disk = await run("du", ["-sb", lane.worktree]).then((r) => Number(r.stdout.split(/\s/)[0]), () => null);
    return { ignored, cache, seconds, steps: steps.length, disk: Number.isFinite(disk) ? disk : null, database };
  }

  /**
   * The Docker runtime's setup: ignored files copied by a helper (the project read-only, the checkout
   * writable, nothing else), then the setup steps inside the lane. `cache` and `database` work from the main
   * checkout and the machine's own Postgres, which a lane cannot use: refused, with what to do instead.
   */
  private async prepareInLane(lane: Lane, project: Project, recipe: Recipe, env: Record<string, string>): Promise<NonNullable<EnvironmentView["setup"]>> {
    if (recipe.cache.length) throw new Refused(`The recipe's "cache" (${recipe.cache.join(", ")}) links folders from the main checkout, which lanes in Docker do not do: the lane's image may not match the host's. Remove "cache" and install dependencies in a setup step (for example ["npm", "ci"]).`, 400, "docker_unsupported");
    if (recipe.database) throw new Refused(`The recipe's "database" makes a copy through this machine's own database, which lanes in Docker cannot reach. Remove "database" and declare the database in the project's devcontainer.json (docs/V4.md 3.4).`, 400, "docker_unsupported");
    const started = Date.now();
    const lanes = this.dockerLanes!;
    const supervisor = this.supervisorOf(lane);
    const ignored = await lanes.copyIgnored(lane, project, recipe.copy);
    const steps = [...recipe.setup, ...(recipe.scripts.setup ? [{ name: "Setup script", command: scriptArgs(recipe.scripts.setup), timeoutSeconds: 600 }] : [])];
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    for (const step of steps) {
      const result = await supervisor.oneshot({ dir: lane.worktree, argv: expand(step.command, env), env, timeoutSeconds: step.timeoutSeconds });
      if (!result.ok) throw new Error(`${step.name} failed: ${result.output.trim().slice(-600)}`);
    }
    const target = lanes.target(lane);
    const disk = target ? await lanes.exec(target, ["du", "-sb", "."], { timeout: 60_000 }).then((r) => Number(r.stdout.split(/\s/)[0]), () => null) : null;
    return { ignored, cache: "none", seconds, steps: steps.length, disk: Number.isFinite(disk) ? disk : null, database: null };
  }

  private async probe(id: string, deadline?: number): Promise<void> {
    const env = this.deps.store.environment(id);
    if (!env) return;
    const lane = this.deps.store.getLane(id);
    if (!lane) return;
    let supervisor: Supervisor;
    try { supervisor = this.supervisorOf(lane); } catch { return; }
    // A service stopped for binding publicly stays stopped until someone restarts it.
    await Promise.all(env.services.filter((s) => s.state !== "stopped" && !s.detail?.startsWith("Stopped:")).map(async (service) => {
      const seen = await this.observe(lane, supervisor, service);
      const probes = [...service.probes, seen.ok].slice(-PROBES);
      const now = new Date().toISOString();
      if (seen.publicAddress) {
        await supervisor.stop(service.unit).catch(() => {});
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

  /**
   * The host: the unit runs, it listens only on loopback (else it is stopped), and its health path answers.
   * The Docker runtime: the same through the lane's own driver, health asked of the lane container by name
   * over the contextlanes network (as the router reaches it); listening beyond loopback is what a lane
   * should do, and listening only on loopback is said plainly, since nothing outside the lane can reach it.
   */
  private async observe(lane: Lane, supervisor: Supervisor, service: ServiceStatus): Promise<{ ok: boolean; ms: number; detail: string; publicAddress?: string }> {
    const status = await supervisor.status(service.unit);
    if (!status.active) return { ok: false, ms: 0, detail: `The service is not running (${status.state}). Check its logs.` };
    if (!this.docker) {
      const publicAddress = (await supervisor.publicListeners(status.pids))[0];
      if (publicAddress) return { ok: false, ms: 0, detail: "", publicAddress };
    }
    const started = Date.now();
    const host = this.hostOf(lane);
    try {
      const response = await this.fetch(`http://${host}:${service.port}${service.healthPath}`, { redirect: "manual", signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      return { ok: response.status === service.healthStatus, ms: Date.now() - started, detail: `${service.healthPath} answered ${response.status}, not ${service.healthStatus}.` };
    } catch {
      if (supervisor instanceof DockerSupervisor) {
        const listening = await supervisor.listening(status.pids).catch(() => []);
        if (loopbackOnly(listening)) return { ok: false, ms: 0, detail: loopbackDetail(listening, service.port) };
        if (listening.length && !listening.some((a) => a.endsWith(`:${service.port}`))) return { ok: false, ms: 0, detail: `Nothing answered on ${host}:${service.port}${service.healthPath}; it listens on ${listening.join(", ")}, not on port ${service.port}. Use $PORT (or the recipe's port.number).` };
      }
      return { ok: false, ms: 0, detail: this.docker ? `Nothing answered on ${host}:${service.port}${service.healthPath}.` : `Nothing answered on ${service.healthPath}.` };
    }
  }

  /**
   * Where a running service listens inside its lane, for doctor: the addresses, and true when every one is
   * loopback. Null on the host, or when the lane has no container or the service is not running.
   */
  async listening(id: string, name: string): Promise<{ addresses: string[]; loopbackOnly: boolean } | null> {
    const lane = this.deps.store.getLane(id);
    const service = this.deps.store.environment(id)?.services.find((s) => s.name === name);
    if (!lane || !service || !this.docker) return null;
    let supervisor: Supervisor;
    try { supervisor = this.supervisorOf(lane); } catch { return null; }
    if (!(supervisor instanceof DockerSupervisor)) return null;
    const status = await supervisor.status(service.unit);
    if (!status.active) return null;
    const addresses = await supervisor.listening(status.pids).catch(() => []);
    return { addresses, loopbackOnly: loopbackOnly(addresses) };
  }

  /** Where the router sends a lane's service now (host:port), for doctor and tests. */
  routeOf(lane: Lane, service: string): string | null { return this.previews.targetOf(lane, service); }

  /** The lane container's name and the port, for doctor: where a service is reached on the contextlanes network. */
  addressOf(lane: Lane, port: number): string { return `${this.hostOf(lane)}:${port}`; }

  /** A healthy service gets its link. A failed link never stops the app; it says why and retries. */
  private async link(id: string, service: ServiceStatus): Promise<void> {
    const { store, config } = this.deps;
    const lane = this.lane(id);
    if (config.previews.mode === "router") {
      // A table entry, not a network call: always set, so a route lost for any reason comes back within one probe.
      const url = await this.previews.publish(lane, service.name, service.port, this.hostOf(lane));
      if (service.url !== url) this.update(store.environment(id)!, service, { url });
      return;
    }
    if (this.docker) {
      const env = store.environment(id)!;
      const error = `Preview link for ${service.name}: Tailscale Serve links ([previews] mode = "serve") are not made in the Docker runtime. Use mode = "router" with your proxy (docs/PROXY.md).`;
      if (env.error !== error) store.saveEnvironment({ ...env, error });
      return;
    }
    if (service.url || Date.now() < (this.previewRetry.get(service.unit) ?? 0)) return;
    this.previewRetry.set(service.unit, Date.now() + 60_000);
    try {
      const url = await this.previews.publish(lane, service.name, service.port);
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

function scriptArgs(script: string | string[]): string[] { return Array.isArray(script) ? script : [`./${script.replace(/^\.\//, "")}`]; }
