import type { Lane, Project } from "@contextlanes/protocol";
import type { Io } from "./lane.js";
import { UsageError } from "./client.js";

/** Short verbs, borrowed from git and docker compose, for the long commands they stand for. */
const VERBS: Record<string, string[]> = {
  ls: ["lanes"], ps: ["env"], up: ["env", "start"], down: ["env", "stop"], restart: ["env", "restart"],
  say: ["send"], sh: ["term"], rm: ["lane", "rm"], ok: ["answer"], rename: ["lane", "rename"], auto: ["lane", "auto"],
};

/** Flags that take a value, which is therefore never a lane. */
const VALUE_FLAGS = new Set(["-n", "--lines", "--agent", "--model", "--base", "--branch"]);

/** Which arguments of a command may name a lane: every one of them, or only the first. */
function lanePlaces(cmd: string, sub: string | undefined): "any" | "first" | null {
  if (cmd === "env" || cmd === "url" || cmd === "logs" || cmd === "recipe") return "any";
  if (cmd === "status" || cmd === "send" || cmd === "term") return "first";
  if (cmd === "lane" && sub && ["rm", "rename", "restart", "auto"].includes(sub)) return "first";
  return null;
}

/** The project a bare lane number belongs to: this lane's, or the one whose folder or lane checkout holds this folder. */
/**
 * In Docker, the folder the host command was run in when the container cannot see it: outside the
 * folders mounted into it. Says which folders it can see.
 */
export function unmounted(env: Record<string, string | undefined>): string | null {
  const where = env.CONTEXTLANES_UNMOUNTED;
  if (!where) return null;
  const seen = [env.CONTEXTLANES_CODE, env.CONTEXTLANES_LANES].filter(Boolean).join(" and ");
  return `${where} is outside what the ContextLanes container can see${seen ? ` (${seen})` : ""}. Set CONTEXTLANES_CODE in the stack's .env to a folder that contains it, update paths.code in data/config.toml to match, then: docker compose up -d`;
}

export async function projectHere(io: Io): Promise<string | null> {
  if (io.env.CONTEXTLANES_LANE) return io.env.CONTEXTLANES_LANE.split("/")[0]!;
  // The container is not in the folder the command was typed in, so nothing here says which project.
  if (io.env.CONTEXTLANES_UNMOUNTED) return null;
  const inside = (root: string) => io.cwd === root || io.cwd.startsWith(`${root}/`);
  const projects = await io.api<Project[]>("/api/projects");
  const project = projects.filter((p) => inside(p.path)).sort((a, b) => b.path.length - a.path.length)[0];
  if (project) return project.id;
  const lane = (await io.api<Lane[]>("/api/lanes")).find((l) => inside(l.worktree));
  if (lane) return lane.project;
  return projects.length === 1 ? projects[0]!.id : null;
}

/**
 * Turns the short form into the long one the rest of the CLI understands:
 * `new "task"` starts a lane in this project, short verbs expand (up, down, ls, rm…), and a bare
 * number where a lane is expected means that lane of this project (`rm 2` is `lane rm shop/02`).
 * Long commands pass through unchanged, so both spellings work everywhere.
 */
export async function expandShort(argv: string[], io: Io, here: (io: Io) => Promise<string | null> = projectHere): Promise<string[]> {
  const [verb, ...rest] = argv;
  if (!verb) return argv;
  let project: string | null | undefined;
  const find = async () => project === undefined ? (project = await here(io)) : project;

  if (verb === "new") {
    // One word after `new` is the task; the project is where you are. Projects come first: a folder is made one with `cl add`.
    const words = positions(rest).map((i) => rest[i]!);
    if (words.length !== 1) return ["lane", "start", ...rest];
    const owner = await find();
    if (!owner && unmounted(io.env)) throw new UsageError(unmounted(io.env)!);
    if (!owner) throw new UsageError('This folder is not a project yet. Make it one first: cl add   (or name the project: cl new <project> "<task>")');
    return ["lane", "start", owner, ...rest];
  }

  const out = VERBS[verb] ? [...VERBS[verb], ...rest] : [...argv];
  const places = lanePlaces(out[0]!, out[1]);
  if (!places) return out;
  // Positional arguments after the command words; `lane rm` and `env start` have two.
  const skip = out[0] === "lane" || (out[0] === "env" && ["start", "stop", "restart"].includes(out[1] ?? "")) ? 2 : 1;
  const tail = out.slice(skip);
  const spots = positions(tail);
  for (const [n, i] of spots.entries()) {
    if (places === "first" && n > 0) break;
    if (!/^\d{1,4}$/.test(tail[i]!)) continue;
    const owner = await find();
    if (!owner) continue;
    tail[i] = `${owner}/${tail[i]!.padStart(2, "0")}`;
  }
  return [...out.slice(0, skip), ...tail];
}

/** Indexes of the arguments that are not flags or a flag's value. */
function positions(args: string[]): number[] {
  const found: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (VALUE_FLAGS.has(arg)) { i++; continue; }
    if (arg.startsWith("-") && arg !== "-") continue;
    found.push(i);
  }
  return found;
}
