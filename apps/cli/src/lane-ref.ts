import type { Lane, Project } from "@contextlanes/protocol";
import type { Io } from "./lane.js";
import { UsageError } from "./client.js";

/** Flags that take a value, which is therefore never a lane. */
const VALUE_FLAGS = new Set(["-n", "--lines", "--agent", "--model", "--base", "--branch"]);

/** What `app` does; with one of these its name is two words (`app start`). */
const APP_VERBS = new Set(["start", "stop", "restart", "status"]);

/** Which arguments of a command may name a lane: every one of them, or only the first. */
function lanePlaces(cmd: string): "any" | "first" | null {
  if (cmd === "app" || cmd === "url" || cmd === "logs" || cmd === "recipe" || cmd === "approve") return "any";
  if (["status", "send", "open", "delete", "rename", "resume", "auto"].includes(cmd)) return "first";
  return null;
}

/** The project a bare lane number belongs to: this lane's, or the one whose folder or lane checkout holds this folder. */
export async function projectHere(io: Io): Promise<string | null> {
  if (io.env.CONTEXTLANES_LANE) return io.env.CONTEXTLANES_LANE.split("/")[0]!;
  const inside = (root: string) => io.cwd === root || io.cwd.startsWith(`${root}/`);
  const projects = await io.api<Project[]>("/api/projects");
  const project = projects.filter((p) => inside(p.path)).sort((a, b) => b.path.length - a.path.length)[0];
  if (project) return project.id;
  const lane = (await io.api<Lane[]>("/api/lanes")).find((l) => inside(l.worktree));
  if (lane) return lane.project;
  return projects.length === 1 ? projects[0]!.id : null;
}

/**
 * Fills in what a typed command leaves to where it is run: `new "task"` starts a lane in this project,
 * and a bare number where a lane is expected means that lane of this project (`delete 2` is
 * `delete shop/02`). Command names are never changed; anything else passes through as typed.
 */
export async function resolveLaneRefs(argv: string[], io: Io, here: (io: Io) => Promise<string | null> = projectHere): Promise<string[]> {
  const [verb, ...rest] = argv;
  if (!verb) return argv;
  let project: string | null | undefined;
  const find = async () => project === undefined ? (project = await here(io)) : project;

  if (verb === "new") {
    // One word after `new` is the task; the project is where you are. Projects come first: a folder is made one with `contextlanes add`.
    const words = positions(rest).map((i) => rest[i]!);
    if (words.length !== 1) return argv;
    const owner = await find();
    if (!owner) throw new UsageError('This folder is not a project yet. Make it one first: contextlanes add   (or name the project: contextlanes new <project> "<task>")');
    return ["new", owner, ...rest];
  }

  const places = lanePlaces(verb);
  if (!places) return argv;
  // Positional arguments after the command's name; `app start` takes two words.
  const skip = verb === "app" && APP_VERBS.has(rest[0] ?? "") ? 2 : 1;
  const tail = argv.slice(skip);
  for (const [n, i] of positions(tail).entries()) {
    if (places === "first" && n > 0) break;
    if (!/^\d{1,4}$/.test(tail[i]!)) continue;
    const owner = await find();
    if (!owner) continue;
    tail[i] = `${owner}/${tail[i]!.padStart(2, "0")}`;
  }
  return [...argv.slice(0, skip), ...tail];
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
