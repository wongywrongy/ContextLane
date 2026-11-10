import { AGENT_NOTES, type EnvironmentView, type Lane, type LogLine, type Project, type RecipeView } from "@contextlanes/protocol";
import { ClientError, UsageError } from "./client.js";
import { table } from "./format.js";

export type Api = <T>(path: string, init?: { method?: string; body?: unknown; token?: string }) => Promise<T>;
export type Io = { api: Api; env: Record<string, string | undefined>; cwd: string; out: (text: string) => void; err: (text: string) => void };
export type Flags = { json?: boolean; lines?: string; force?: boolean; "delete-branch"?: boolean };

const isLane = (arg: string) => /^[a-z0-9][\w.-]*\/\d+$/i.test(arg);
const encodeLane = (id: string) => id.split("/").map(encodeURIComponent).join("/");

/**
 * Who is asking. Inside a CLI lane the agent has only its lane token, which reaches that lane's tool
 * routes and nothing else; everywhere else the owner's shell token reaches the full API.
 */
function token(io: Io): string | undefined { return io.env.CONTEXTLANES_LANE_TOKEN || undefined; }

/** The lane named, else this lane (CONTEXTLANES_LANE), else the lane whose checkout holds this folder. */
export async function resolveLane(given: string | undefined, io: Io): Promise<string> {
  if (given) return given;
  if (io.env.CONTEXTLANES_LANE) return io.env.CONTEXTLANES_LANE;
  const lanes = (await io.api<Lane[]>("/api/lanes")).filter((l) => !["cleaned", "archived"].includes(l.state));
  const here = lanes.filter((l) => io.cwd === l.worktree || io.cwd.startsWith(`${l.worktree}/`)).sort((a, b) => b.worktree.length - a.worktree.length || Number(!!a.direct) - Number(!!b.direct));
  if (here[0]) return here[0].id;
  throw new UsageError(lanes.length ? `Name a lane, or run this inside a lane's checkout. Open lanes: ${lanes.map((l) => l.id).join(", ")}` : "No open lanes. Start one with: contextlanes lane start <project> \"<task>\"");
}

/** A lane's tool route with its token, or the owner's route. */
async function call<T>(io: Io, lane: string, tool: string, owner: { path: string; method?: string; body?: unknown }, body: unknown = {}): Promise<T> {
  const laneToken = token(io);
  if (laneToken) return io.api<T>(`/api/lanes/${encodeLane(lane)}/tools/${tool}`, { method: "POST", body, token: laneToken });
  return io.api<T>(`/api/lanes/${encodeLane(lane)}${owner.path}`, { method: owner.method ?? "GET", ...(owner.body !== undefined ? { body: owner.body } : {}) });
}

function print(io: Io, flags: Flags, value: unknown, text: () => string): void {
  io.out(flags.json ? JSON.stringify(value, null, 2) : text());
}

export function formatEnv(env: EnvironmentView | null): string {
  if (!env || !env.services.length) return "No environment yet. Start it: contextlanes env start";
  const rows = env.services.map((s) => [s.name, `${STATE[s.state]} ${s.state}`, String(s.port), s.url ?? "-"]);
  const details = env.services.filter((s) => s.detail).map((s) => `${s.name}: ${s.detail}`);
  return [table(["SERVICE", "STATE", "PORT", "LINK"], rows), ...(env.error ? [env.error] : []), ...details].join("\n");
}
const STATE: Record<EnvironmentView["services"][number]["state"], string> = { starting: "◌", healthy: "●", failed: "■", stopped: "○" };

const formatLogs = (lines: LogLine[]) => lines.length ? lines.map((l) => `${l.at}  ${l.text}`).join("\n") : "No log lines yet.";

/** Services that were asked for and did not come up, with their last log lines, for the error stream. */
async function failures(io: Io, lane: string, env: EnvironmentView, asked?: string[]): Promise<string[]> {
  const bad = env.services.filter((s) => (!asked?.length || asked.includes(s.name)) && s.state !== "healthy");
  const out: string[] = [];
  for (const s of bad) {
    out.push(`${s.name} is ${s.state}${s.detail ? `: ${s.detail}` : ""}`);
    const lines = await call<LogLine[]>(io, lane, "get_logs", { path: `/logs?service=${encodeURIComponent(s.name)}&lines=20` }, { service: s.name, lines: 20 }).catch(() => []);
    if (lines.length) out.push(`last ${lines.length} log lines of ${s.name}:`, ...lines.map((l) => `  ${l.text}`));
  }
  if (env.error) out.unshift(env.error);
  return out;
}

async function projectFor(given: string | undefined, io: Io): Promise<string> {
  if (given) return given;
  const lane = io.env.CONTEXTLANES_LANE ?? await resolveLane(undefined, io).catch(() => undefined);
  if (lane) return lane.split("/")[0]!;
  const projects = await io.api<Project[]>("/api/projects");
  const here = projects.filter((p) => io.cwd === p.path || io.cwd.startsWith(`${p.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  if (here) return here.id;
  throw new UsageError("Name a project, or run this inside one.");
}

/**
 * The lane commands an agent uses: env, logs, url, recipe, lane rm, agent-notes. Returns null for any
 * other command. Every command takes --json and then prints exactly one JSON document on stdout.
 */
export async function laneCommand(cmd: string | undefined, args: string[], flags: Flags, io: Io): Promise<number | null> {
  switch (cmd) {
    case "agent-notes":
      print(io, flags, { notes: AGENT_NOTES }, () => AGENT_NOTES);
      return 0;

    case "env": {
      const action = ["start", "stop", "restart", "status"].includes(args[0] ?? "") ? args.shift()! : "status";
      const lane = await resolveLane(args.find(isLane), io);
      const services = args.filter((a) => !isLane(a));
      if (action === "status") {
        const env = await call<EnvironmentView | null>(io, lane, "env_status", { path: "/env" });
        print(io, flags, env, () => formatEnv(env));
        return 0;
      }
      if (action === "stop") {
        const env = await call<EnvironmentView | null>(io, lane, "env_stop", { path: "/env/stop", method: "POST", body: {} });
        print(io, flags, env, () => formatEnv(env));
        return 0;
      }
      const body = services.length ? { services } : {};
      // The daemon waits for every service to be healthy or to fail before it answers.
      const env = action === "start"
        ? await call<EnvironmentView>(io, lane, "env_start", { path: "/env/start", method: "POST", body }, body)
        : await call<EnvironmentView>(io, lane, "env_restart", { path: "/env/restart", method: "POST", body }, body);
      print(io, flags, env, () => formatEnv(env));
      const failed = await failures(io, lane, env, services);
      if (!failed.length) return 0;
      io.err(failed.join("\n"));
      return 1;
    }

    case "logs": {
      const service = args.find((a) => !isLane(a));
      if (!service) throw new UsageError("Name a service: contextlanes logs <service> [lane] [-n 100]");
      const lines = Number(flags.lines ?? 100);
      if (!Number.isInteger(lines) || lines < 1 || lines > 500) throw new UsageError("-n takes a number from 1 to 500.");
      const lane = await resolveLane(args.find(isLane), io);
      const result = await call<LogLine[]>(io, lane, "get_logs", { path: `/logs?service=${encodeURIComponent(service)}&lines=${lines}` }, { service, lines });
      print(io, flags, result, () => formatLogs(result));
      return 0;
    }

    case "url": {
      const service = args.find((a) => !isLane(a)) ?? "web";
      const lane = await resolveLane(args.find(isLane), io);
      const result = await call<{ service: string; url: string }>(io, lane, "preview_url", { path: `/url?service=${encodeURIComponent(service)}` }, { service });
      print(io, flags, result, () => result.url);
      return 0;
    }

    case "recipe": {
      const approve = args[0] === "approve";
      if (approve) args.shift();
      if (approve && token(io)) throw new ClientError("Only the owner can approve a recipe. Ask them to approve it on the Run page, or with contextlanes recipe approve.", { exit: 4, code: "owner_only" });
      if (token(io)) {
        const view = await call<RecipeView | null>(io, await resolveLane(undefined, io), "recipe_status", { path: "" });
        print(io, flags, view, () => formatRecipe(view));
        return 0;
      }
      const project = await projectFor(args[0], io);
      const view = await io.api<RecipeView | null>(`/api/projects/${encodeURIComponent(project)}/recipe`);
      if (!approve) { print(io, flags, view, () => formatRecipe(view)); return 0; }
      if (!view) throw new ClientError(`${project} has no .contextlanes.json in its main checkout.`, { exit: 1, code: "no_recipe" });
      if (!view.recipe) throw new ClientError(`The recipe cannot be used: ${view.error}`, { exit: 1, code: "invalid_recipe" });
      const result = await io.api<{ approved: true; hash: string }>(`/api/projects/${encodeURIComponent(project)}/recipe/approve`, { method: "POST", body: { hash: view.hash } });
      print(io, flags, result, () => `Approved recipe ${result.hash.slice(0, 7)} for ${project}.`);
      return 0;
    }

    case "lane": {
      if (args[0] === "rename" || args[0] === "restart" || args[0] === "auto") {
        const [verb, lane, value] = args;
        const shape = { rename: 'contextlanes lane rename <project/NN> "<new task>"', restart: "contextlanes lane restart <project/NN>", auto: "contextlanes lane auto <project/NN> on|off" }[verb];
        if (!lane || !isLane(lane) || (verb === "rename" && !value) || (verb === "auto" && value !== "on" && value !== "off")) throw new UsageError(`Usage: ${shape}`);
        // These change a lane for its owner; a lane's own agent may not rename it, restart it or loosen its approvals.
        if (token(io)) throw new ClientError(`Only the owner can ${verb === "auto" ? "turn Auto on or off" : `${verb} a lane`}.`, { exit: 4, code: "owner_only" });
        if (verb === "rename") {
          const result = await io.api<Lane>(`/api/lanes/${encodeLane(lane)}`, { method: "PATCH", body: { task: args.slice(2).join(" ") } });
          print(io, flags, result, () => `Renamed ${lane}: ${result.task}`);
        } else if (verb === "restart") {
          const result = await io.api<unknown>(`/api/lanes/${encodeLane(lane)}/restart`, { method: "POST", body: {} });
          print(io, flags, result ?? { restarted: true, lane }, () => `Restarted the agent in ${lane}.`);
        } else {
          const on = value === "on";
          const result = await io.api<{ answered?: number }>(`/api/lanes/${encodeLane(lane)}/auto`, { method: "POST", body: { on } });
          print(io, flags, { lane, auto: on, ...result }, () => on ? `Auto is on for ${lane}: safe requests are allowed once; dire ones still wait for you.` : `Auto is off for ${lane}.`);
        }
        return 0;
      }
      if (args[0] !== "rm") return null;
      const lane = args[1];
      if (!lane || !isLane(lane)) throw new UsageError("Name the lane: contextlanes lane rm <project/NN> [--force] [--delete-branch]");
      if (token(io)) throw new ClientError("Only the owner can delete a lane.", { exit: 4, code: "owner_only" });
      const preview = await io.api<{ uncommitted: number; commits: number; branch: string; present: boolean }>(`/api/lanes/${encodeLane(lane)}/discard`);
      if (preview.uncommitted && !flags.force) throw new ClientError(`${lane} has ${preview.uncommitted} uncommitted ${preview.uncommitted === 1 ? "change" : "changes"}; nothing was deleted. Commit them, or add --force to delete them with the lane.`, { exit: 1, code: "uncommitted" });
      const result = await io.api<Lane>(`/api/lanes/${encodeLane(lane)}/discard`, { method: "POST", body: { deleteBranch: !!flags["delete-branch"] } });
      print(io, flags, result, () => `Deleted ${lane}: services stopped and checkout removed${flags["delete-branch"] ? ", branch deleted" : `; branch ${preview.branch} kept`}.`);
      return 0;
    }

    default:
      return null;
  }
}

function formatRecipe(view: RecipeView | null): string {
  if (!view) return "No .contextlanes.json yet. See docs/RECIPES.md for how to write one.";
  const state = view.error ? `invalid: ${view.error}` : view.approved ? "approved" : "waiting for the owner's approval";
  const services = view.recipe?.services.map((s) => `  ${s.name}: ${s.command.join(" ")}`) ?? [];
  return [`${view.file} · sha ${view.hash.slice(0, 7)} · ${state}`, ...(services.length ? ["services:", ...services] : [])].join("\n");
}
