import type { InboxItem, Lane, Project } from "@contextlanes/protocol";
import type { Io } from "./lane.js";
import { unmounted } from "./short.js";

/** What a prompt returns when the person presses Esc: one step back, or out at the top. */
export const CANCEL = Symbol("cancel");
type Answer<T> = T | typeof CANCEL;
export type Choice<T> = { value: T; label: string; hint?: string };
/** The questions the terminal can ask. Injected, so tests answer them without a terminal. */
export type Ask = {
  /** `initial` is the value the cursor starts on, so a screen that comes back keeps its place. */
  select: <T>(message: string, options: Choice<T>[], initial?: T) => Promise<Answer<T>>;
  text: (message: string, initial?: string) => Promise<Answer<string>>;
  confirm: (message: string) => Promise<Answer<boolean>>;
  note: (text: string) => void;
};
/** Runs one complete long command exactly as if it had been typed, and returns its exit code. */
export type Exec = (argv: string[]) => Promise<number>;

/**
 * Whether to ask at all: only a person at a terminal. An agent in a lane, a script, a pipe or --json
 * never gets a question; a missing argument stays a usage error (exit 2), so nothing can hang.
 */
export function canAsk(argv: string[], env: Record<string, string | undefined>, tty: { in: boolean; out: boolean }): boolean {
  return tty.in && tty.out && !argv.includes("--json") && !env.CONTEXTLANES_LANE_TOKEN && !env.CI;
}

const BACK = "←back";
const back = (to: string): Choice<string> => ({ value: BACK, label: `← ${to}` });
const gone = <T>(answer: Answer<T> | typeof BACK): answer is typeof CANCEL | typeof BACK => answer === CANCEL || answer === BACK;
const isOpen = (l: Lane) => !["cleaned", "archived"].includes(l.state);
const number = (id: string) => id.slice(id.lastIndexOf("/") + 1);
const inside = (cwd: string, root: string) => cwd === root || cwd.startsWith(`${root}/`);
const tilde = (path: string, io: Io) => io.env.HOME && inside(path, io.env.HOME) ? `~${path.slice(io.env.HOME.length)}` : path;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const laneChoice = (l: Lane, waiting: InboxItem[]): Choice<string> => ({
  value: l.id, label: `${number(l.id)}  ${l.task}`,
  hint: [waiting.some((i) => i.lane === l.id) ? "needs you" : l.state.replace("_", " "), l.kind === "shell" ? "no agent" : l.agent].join(" · "),
});

type World = { projects: Project[]; lanes: Lane[]; waiting: InboxItem[] };
async function world(io: Io): Promise<World> {
  const [projects, lanes, waiting] = await Promise.all([io.api<Project[]>("/api/projects"), io.api<Lane[]>("/api/lanes"), io.api<InboxItem[]>("/api/inbox").catch(() => [] as InboxItem[])]);
  return { projects, lanes: lanes.filter(isOpen), waiting };
}

/** The project whose folder, or one of whose lane checkouts, holds this folder. */
function projectAt(cwd: string, w: World, env: Record<string, string | undefined> = {}): Project | null {
  // In Docker, a folder the container cannot see: the command is not really "in" any project.
  if (env.CONTEXTLANES_UNMOUNTED) return null;
  const byFolder = w.projects.filter((p) => inside(cwd, p.path)).sort((a, b) => b.path.length - a.path.length)[0];
  if (byFolder) return byFolder;
  const lane = w.lanes.find((l) => inside(cwd, l.worktree));
  return lane ? w.projects.find((p) => p.id === lane.project) ?? null : null;
}

/**
 * `cl` on its own. Three levels, each one step from the next:
 *   Projects  →  one project and its lanes  →  one lane and what to do with it.
 * Every list ends with a way back (the top one with Quit), and Esc does the same. After an action the
 * same screen comes back, so several things can be done in a row. Starts inside the project this
 * folder belongs to, if there is one.
 */
export async function session(io: Io, ask: Ask, exec: Exec): Promise<number> {
  ask.note("↑ ↓ move   ·   Enter opens   ·   Esc goes back a step");
  let project: string | null = projectAt(io.cwd, await world(io), io.env)?.id ?? null;
  for (;;) {
    if (project === null) {
      const chosen = await projectsScreen(io, ask, exec);
      if (chosen === null) return 0;
      project = chosen;
    } else { await projectScreen(project, io, ask, exec); project = null; }
  }
}

/** Level 1: every project. Returns the one chosen, or null to quit. */
async function projectsScreen(io: Io, ask: Ask, exec: Exec): Promise<string | null> {
  for (;;) {
    const w = await world(io);
    const here = projectAt(io.cwd, w, io.env);
    const hidden = unmounted(io.env);
    const choice = await ask.select<string>(w.projects.length ? "Projects" : "No projects yet · a project is a repository folder", [
      ...w.projects.map((p) => {
        const lanes = w.lanes.filter((l) => l.project === p.id), need = w.waiting.filter((i) => i.lane.startsWith(`${p.id}/`)).length;
        return { value: `p:${p.id}`, label: p.name, hint: [tilde(p.path, io), lanes.length ? plural(lanes.length, "lane") : "no lanes", ...(need ? [`${need} need you`] : [])].join(" · ") };
      }),
      ...(here ? [] : hidden ? [{ value: "+hidden", label: "Why is this folder not listed?", hint: io.env.CONTEXTLANES_UNMOUNTED }] : [{ value: "+add", label: "+ Make this folder a project", hint: tilde(io.cwd, io) }]),
      ...(w.waiting.length ? [{ value: "+inbox", label: "Answer what is waiting on you", hint: `${w.waiting.length}` }] : []),
      { value: "+help", label: "Every command" },
      { value: BACK, label: "Quit" },
    ]);
    if (gone(choice)) return null;
    if (choice === "+help") { await exec(["help"]); return null; }
    if (choice === "+inbox") { await inboxScreen(io, ask, exec, "Projects"); continue; }
    if (choice === "+hidden") { ask.note(hidden!); continue; }
    if (choice === "+add") {
      if (await exec(["add"]) !== 0) continue;
      const added = projectAt(io.cwd, await world(io), io.env);
      if (added) return added.id;
      continue;
    }
    return choice.slice(2);
  }
}

/** Level 2: one project and its lanes. Returns when the person goes back up to Projects. */
async function projectScreen(id: string, io: Io, ask: Ask, exec: Exec): Promise<"projects"> {
  for (;;) {
    const w = await world(io);
    const project = w.projects.find((p) => p.id === id);
    if (!project) return "projects";
    const lanes = w.lanes.filter((l) => l.project === id), waiting = w.waiting.filter((i) => i.lane.startsWith(`${id}/`));
    const choice = await ask.select<string>(`${project.name}  ·  ${lanes.length ? plural(lanes.length, "lane") : "no lanes yet"}`, [
      ...lanes.map((l) => laneChoice(l, waiting)),
      { value: "+new", label: "+ New lane", hint: "one task: its own branch, checkout, terminal and app" },
      ...(waiting.length ? [{ value: "+inbox", label: "Answer what is waiting on you", hint: `${waiting.length}` }] : []),
      { value: "+recipe", label: "Show how its app runs", hint: "the recipe" },
      { value: "+remove", label: "Stop tracking this project", hint: "the folder is untouched" },
      back("Projects"),
    ]);
    if (choice === CANCEL || choice === BACK) return "projects";
    if (choice === "+new") { const made = await newLane(id, io, ask, exec); if (made) await laneScreen(made, project.name, io, ask, exec); continue; }
    if (choice === "+inbox") { await inboxScreen(io, ask, exec, project.name, id); continue; }
    if (choice === "+recipe") { await exec(["recipe", id]); continue; }
    if (choice === "+remove") {
      if (await ask.confirm(`Stop tracking ${project.name}? The folder ${project.path} and its branches stay as they are.`) === true && await exec(["remove", id]) === 0) return "projects";
      continue;
    }
    await laneScreen(choice, project.name, io, ask, exec);
  }
}

/** New lane: the task, then who works on it. Back from the second question returns to the first with the task kept. */
async function newLane(project: string, io: Io, ask: Ask, exec: Exec, flags: string[] = []): Promise<string | null> {
  let task = "";
  for (;;) {
    const typed = await ask.text("What should this lane do?  (Esc to go back)", task);
    if (typed === CANCEL) return null;
    task = typed.trim();
    const who = await ask.select<string>("Who works on it?", [
      { value: "claude-code", label: "Claude Code" }, { value: "codex", label: "Codex" },
      { value: "", label: "No agent", hint: "just the checkout, your own shell and the app" },
      back("Change the task"),
    ]);
    if (gone(who)) continue;
    const branch = await whichBranch(project, io, ask);
    if (branch === CANCEL) continue;
    const before = new Set((await io.api<Lane[]>("/api/lanes")).map((l) => l.id));
    if (await exec(["lane", "start", project, task, ...(who ? ["--agent", who] : ["--no-agent"]), ...(branch ? ["--branch", branch] : []), ...flags]) !== 0) return null;
    return (await io.api<Lane[]>("/api/lanes")).find((l) => l.project === project && !before.has(l.id))?.id ?? null;
  }
}

/**
 * Where the lane's work goes: a new branch of its own (the default), or a branch that already exists.
 * Returns the existing branch's name, "" for a new one, or CANCEL to go back.
 */
async function whichBranch(project: string, io: Io, ask: Ask): Promise<Answer<string>> {
  const info = await io.api<{ branches: string[]; defaultBranch: string | null; current?: string | null }>(`/api/projects/${encodeURIComponent(project)}/branches`).catch(() => null);
  // Branches a lane could take: not ones lanes made, and not the one open in the project folder itself.
  const others = (info?.branches ?? []).filter((b) => !b.startsWith("lane/") && b !== info?.current);
  if (!others.length) return "";
  for (;;) {
    const how = await ask.select<string>("On which branch?", [
      { value: "new", label: "A new branch for this lane", hint: `from ${info?.defaultBranch ?? "the default branch"}` },
      { value: "pick", label: "A branch that already exists", hint: `${others.length} ${others.length === 1 ? "branch" : "branches"}` },
      back("Who works on it"),
    ]);
    if (gone(how)) return CANCEL;
    if (how === "new") return "";
    const picked = await ask.select<string>("Which branch?", [...others.map((b) => ({ value: b, label: b })), back("Back")]);
    if (!gone(picked)) return picked;
  }
}

/** Level 3: one lane. Stays here after each action, until Back or the lane is deleted. */
async function laneScreen(id: string, projectName: string, io: Io, ask: Ask, exec: Exec): Promise<void> {
  let last: string | undefined;
  for (;;) {
    const w = await world(io);
    const lane = w.lanes.find((l) => l.id === id);
    if (!lane) return;
    const agent = lane.kind !== "shell", waiting = w.waiting.filter((i) => i.lane === id);
    const action = await ask.select<string>(`${projectName} / ${number(id)}  ·  ${lane.task}`, [
      ...(waiting.length ? [{ value: "inbox", label: "Answer what it is waiting for", hint: waiting[0]!.title }] : []),
      { value: "sh", label: agent ? "Open its terminal" : "Open its shell", hint: "come back here with Ctrl-b d" },
      ...(agent ? [{ value: "say", label: "Send its agent a message" }] : []),
      { value: "up", label: "Start its app" }, { value: "ps", label: "Show its app and links" }, { value: "down", label: "Stop its app" },
      { value: "rename", label: "Rename it" }, { value: "rm", label: "Delete it" },
      back(projectName),
    ], last);
    if (gone(action)) return;
    last = action;
    if (action === "inbox") { await inboxScreen(io, ask, exec, `lane ${number(id)}`, undefined, id); continue; }
    if (action === "sh") { await exec(["term", id]); continue; }
    if (action === "up") { await exec(["env", "start", id]); continue; }
    if (action === "down") { await exec(["env", "stop", id]); continue; }
    if (action === "ps") { await exec(["env", id]); continue; }
    if (action === "say") { const text = await ask.text(`Message for lane ${number(id)}'s agent  (Esc to go back)`); if (text !== CANCEL) await exec(["send", id, text]); continue; }
    if (action === "rename") { const task = await ask.text(`New name for lane ${number(id)}  (Esc to go back)`, lane.task); if (task !== CANCEL) await exec(["lane", "rename", id, task]); continue; }
    if (await ask.confirm(`Delete lane ${number(id)}? Its app stops and its checkout is removed. The branch ${lane.branch} is kept.`) === true && await exec(["lane", "rm", id]) === 0) return;
  }
}

/** What is waiting on the owner, for everything, one project or one lane. Loops until it is empty or Back. */
async function inboxScreen(io: Io, ask: Ask, exec: Exec, from: string, project?: string, lane?: string): Promise<void> {
  for (;;) {
    const items = (await io.api<InboxItem[]>("/api/inbox")).filter((i) => lane ? i.lane === lane : project ? i.lane.startsWith(`${project}/`) : true);
    if (!items.length) { ask.note("Nothing is waiting on you."); return; }
    const item = items.length === 1 && lane ? items[0]! : await ask.select<InboxItem | typeof BACK>("Waiting on you", [...items.map((i) => ({ value: i as InboxItem | typeof BACK, label: `${i.lane}  ${i.title}`, hint: i.kind })), { value: BACK, label: `← ${from}` }]);
    if (gone(item)) return;
    const argv = await answerFor(item, ask);
    if (argv) await exec(argv);
    else if (items.length === 1) return;
  }
}

/** One waiting request: the command that answers it, or null when left alone. A recipe is read before it is approved. */
async function answerFor(item: InboxItem, ask: Ask): Promise<string[] | null> {
  if (item.kind === "approval") {
    const how = await ask.select<string>(`${item.lane}: ${item.title}`, [
      { value: "read", label: "Read the recipe" }, { value: "approve", label: "Approve it", hint: "its commands will run on this machine as you" }, back("Leave it for now"),
    ]);
    return how === "read" ? ["recipe", item.lane] : how === "approve" ? ["recipe", "approve", item.lane] : null;
  }
  if (!item.options.length) { ask.note(`${item.lane}: ${item.title}\nOpen it in the browser to answer.`); return null; }
  const option = await ask.select<string>(`${item.lane}: ${item.title}`, [...item.options.map((o) => ({ value: o.id, label: o.label })), back("Leave it for now")]);
  return gone(option) ? null : ["answer", item.id, option];
}

/** Commands that act on one lane and cannot guess it: [command words, question]. */
const NEEDS_LANE: [string[], string][] = [
  [["term"], "Open which lane?"], [["send"], "Message which lane?"], [["lane", "rm"], "Delete which lane?"],
  [["lane", "rename"], "Rename which lane?"], [["lane", "restart"], "Restart which lane's agent?"], [["lane", "auto"], "Auto for which lane?"],
];

/**
 * A typed command with something left out (`cl new`, `cl rm`, `cl say`…): asks for the missing part,
 * runs it and is done. Returns null when nothing was missing, so the command runs as typed.
 */
export async function fillIn(argv: string[], io: Io, ask: Ask, exec: Exec): Promise<number | null> {
  const flags = argv.filter((a) => a.startsWith("-"));
  const words = argv.filter((a) => !a.startsWith("-"));
  if (words[0] === "inbox" && words.length === 1) {
    if (!(await io.api<InboxItem[]>("/api/inbox")).length) return null;
    await inboxScreen(io, ask, exec, "Quit");
    return 0;
  }
  if (words[0] === "answer" && words.length < 3) { await inboxScreen(io, ask, exec, "Quit"); return 0; }
  if (words[0] === "lane" && words[1] === "start" && words.length < 4) {
    const w = await world(io);
    // `cl new` works inside a project; anywhere else, which project comes first.
    const project = words[2] && w.projects.some((p) => p.id === words[2]) ? words[2] : projectAt(io.cwd, w, io.env)?.id ?? await pickProject(w, io, ask, exec);
    if (!project) return 0;
    await newLane(project, io, ask, exec, flags);
    return 0;
  }
  for (const [command, question] of NEEDS_LANE) {
    if (command.some((word, i) => words[i] !== word)) continue;
    const given = words[command.length];
    const w = await world(io);
    const here = projectAt(io.cwd, w, io.env);
    const lanes = here ? w.lanes.filter((l) => l.project === here.id) : w.lanes;
    let lane = given;
    if (!lane) {
      if (!lanes.length) { ask.note(here ? `${here.name} has no open lanes. Start one: cl new` : "No open lanes. Start one inside a project: cl new"); return 0; }
      const picked = lanes.length === 1 ? lanes[0]!.id : await ask.select<string>(question, [...lanes.map((l) => ({ ...laneChoice(l, w.waiting), label: here ? `${number(l.id)}  ${l.task}` : `${l.id}  ${l.task}` })), { value: BACK, label: "Cancel" }]);
      if (gone(picked)) return 0;
      lane = picked;
    }
    const rest = words.slice(command.length + 1);
    const verb = command.join(" ");
    const typed = rest.length;
    if (verb === "send" && !rest.length) { const text = await ask.text(`Message for ${lane}'s agent  (Esc to cancel)`); if (text === CANCEL) return 0; rest.push(text); }
    if (verb === "lane rename" && !rest.length) { const task = await ask.text(`New name for ${lane}  (Esc to cancel)`, w.lanes.find((l) => l.id === lane)?.task); if (task === CANCEL) return 0; rest.push(task); }
    if (verb === "lane auto" && !rest.length) {
      const on = await ask.select<string>(`Auto for ${lane}`, [{ value: "on", label: "On", hint: "safe requests are allowed once for you; dire ones still wait" }, { value: "off", label: "Off", hint: "every request waits for you" }, { value: BACK, label: "Cancel" }]);
      if (gone(on)) return 0;
      rest.push(on);
    }
    // A lane chosen from a list gets one more question before it is deleted; one typed out was meant.
    if (verb === "lane rm" && !given && await ask.confirm(`Delete ${lane}? Its app stops and its checkout is removed. The branch is kept.`) !== true) return 0;
    if (given && rest.length === typed) return null;
    return exec([...command, lane, ...rest, ...flags]);
  }
  return null;
}

/** Outside every project: choose one, or make this folder one. */
async function pickProject(w: World, io: Io, ask: Ask, exec: Exec): Promise<string | null> {
  const choice = await ask.select<string>(w.projects.length ? "This folder is not a project. Start the lane in which one?" : "This folder is not a project yet", [
    ...w.projects.map((p) => ({ value: `p:${p.id}`, label: p.name, hint: p.path })),
    { value: "+add", label: "+ Make this folder a project", hint: tilde(io.cwd, io) },
    { value: BACK, label: "Cancel" },
  ]);
  if (gone(choice)) return null;
  if (choice !== "+add") return choice.slice(2);
  if (await exec(["add"]) !== 0) return null;
  return projectAt(io.cwd, await world(io), io.env)?.id ?? null;
}
