import type { InboxItem, Lane } from "@contextlanes/protocol";
import type { Io } from "./lane.js";

/** What a prompt returns when the person backs out (Esc or Ctrl-C). */
export const CANCEL = Symbol("cancel");
type Answer<T> = T | typeof CANCEL;
export type Choice<T> = { value: T; label: string; hint?: string };
/** The questions the terminal can ask. Injected, so tests answer them without a terminal. */
export type Ask = {
  select: <T>(message: string, options: Choice<T>[]) => Promise<Answer<T>>;
  text: (message: string, placeholder?: string) => Promise<Answer<string>>;
  confirm: (message: string) => Promise<Answer<boolean>>;
  note: (text: string) => void;
};

/**
 * Whether to ask at all: only a person at a terminal. An agent in a lane, a script, a pipe or --json
 * never gets a question; a missing argument stays a usage error (exit 2), so nothing can hang.
 */
export function canAsk(argv: string[], env: Record<string, string | undefined>, tty: { in: boolean; out: boolean }): boolean {
  return tty.in && tty.out && !argv.includes("--json") && !env.CONTEXTLANES_LANE_TOKEN && !env.CI;
}

const open = (lanes: Lane[]) => lanes.filter((l) => !["cleaned", "archived"].includes(l.state));
const laneChoice = (l: Lane): Choice<string> => ({ value: l.id, label: `${l.id}  ${l.task}`, hint: `${l.state.replace("_", " ")}${l.kind === "shell" ? " · no agent" : ` · ${l.agent}`}` });

async function pickLane(io: Io, ask: Ask, message: string): Promise<Answer<string> | null> {
  const lanes = open(await io.api<Lane[]>("/api/lanes"));
  if (!lanes.length) { ask.note('No open lanes. Start one: cl new "<task>"'); return null; }
  if (lanes.length === 1) return lanes[0]!.id;
  return ask.select(message, lanes.map(laneChoice));
}

/** One waiting request: choose its answer. A recipe is read first, then approved or left. */
async function answer(item: InboxItem, ask: Ask): Promise<Answer<string[]> | null> {
  if (item.kind === "approval") {
    const how = await ask.select(`${item.lane}: ${item.title}`, [{ value: "read", label: "Read the recipe" }, { value: "approve", label: "Approve it", hint: "its commands will run on this machine as you" }, { value: "leave", label: "Leave it" }]);
    if (how === CANCEL) return CANCEL;
    return how === "read" ? ["recipe", item.lane] : how === "approve" ? ["recipe", "approve", item.lane] : null;
  }
  if (!item.options.length) { ask.note(`${item.lane}: ${item.title}\nOpen it in the browser to answer.`); return null; }
  const option = await ask.select(`${item.lane}: ${item.title}`, item.options.map((o) => ({ value: o.id, label: o.label })));
  return option === CANCEL ? CANCEL : ["answer", item.id, option];
}

async function inbox(io: Io, ask: Ask): Promise<Answer<string[]> | null> {
  const items = await io.api<InboxItem[]>("/api/inbox");
  if (!items.length) return ["inbox"];
  const item = items.length === 1 ? items[0]! : await ask.select("Waiting on you", items.map((i) => ({ value: i, label: `${i.lane}  ${i.title}`, hint: i.kind })));
  return item === CANCEL ? CANCEL : answer(item, ask);
}

/** What can be done with one lane, as the command each choice runs. */
async function laneMenu(lane: Lane, ask: Ask): Promise<Answer<string[]> | "back"> {
  const agent = lane.kind !== "shell";
  const action = await ask.select(`${lane.id}  ${lane.task}`, [
    { value: "sh", label: agent ? "Open its terminal" : "Open its shell", hint: "detach with Ctrl-b d" },
    ...(agent ? [{ value: "say", label: "Send its agent a message" }] : []),
    { value: "up", label: "Start its app" }, { value: "ps", label: "Show its app and links" }, { value: "down", label: "Stop its app" },
    { value: "rename", label: "Rename it" }, { value: "rm", label: "Delete it" }, { value: "back", label: "Back" },
  ]);
  if (action === CANCEL || action === "back") return action;
  return complete(action === "sh" ? ["term", lane.id] : action === "say" ? ["send", lane.id] : action === "up" ? ["env", "start", lane.id] : action === "down" ? ["env", "stop", lane.id]
    : action === "ps" ? ["env", lane.id] : action === "rename" ? ["lane", "rename", lane.id] : ["lane", "rm", lane.id], ask, undefined, true);
}

/** `cl` on its own: the lanes, then what to do with the one chosen. */
async function menu(io: Io, ask: Ask): Promise<Answer<string[]> | null> {
  for (;;) {
    const [lanes, waiting] = await Promise.all([io.api<Lane[]>("/api/lanes").then(open), io.api<InboxItem[]>("/api/inbox").catch(() => [] as InboxItem[])]);
    const choice = await ask.select<string>(lanes.length ? "Lanes" : "No open lanes yet", [
      ...lanes.map(laneChoice),
      { value: "+new", label: "+ New lane" },
      ...(waiting.length ? [{ value: "+inbox", label: `Answer what is waiting on you`, hint: `${waiting.length}` }] : []),
      { value: "+help", label: "Every command" },
    ]);
    if (choice === CANCEL) return CANCEL;
    if (choice === "+help") return ["help"];
    if (choice === "+new") return complete(["lane", "start"], ask, io);
    if (choice === "+inbox") { const done = await inbox(io, ask); if (done !== null) return done; continue; }
    const next = await laneMenu(lanes.find((l) => l.id === choice)!, ask);
    if (next !== "back") return next;
  }
}

/** Asks for what a command still lacks: the task, the message, the new name, a yes before deleting. */
async function complete(argv: string[], ask: Ask, io?: Io, picked = false): Promise<Answer<string[]>> {
  const [cmd, sub] = argv;
  const words = argv.filter((a) => !a.startsWith("-"));
  if (cmd === "lane" && sub === "start" && words.length < 3) {
    const task = await ask.text("What should this lane do?", "Fix the double-booked court bug");
    if (task === CANCEL) return CANCEL;
    const who = await ask.select("Who works on it?", [{ value: "claude-code", label: "Claude Code" }, { value: "codex", label: "Codex" }, { value: "", label: "No agent", hint: "just the checkout, shell and app" }]);
    if (who === CANCEL) return CANCEL;
    const project = words[2] ?? (io ? await (await import("./short.js")).projectHere(io) : null) ?? ".";
    return ["lane", "start", project, task, ...(who ? ["--agent", who] : ["--no-agent"]), ...argv.filter((a) => a.startsWith("-"))];
  }
  if (cmd === "send" && words.length < 3) {
    const text = await ask.text(`Message for ${words[1]}'s agent`);
    return text === CANCEL ? CANCEL : [...argv, text];
  }
  if (cmd === "lane" && sub === "rename" && words.length < 4) {
    const task = await ask.text(`New name for ${words[2]}`);
    return task === CANCEL ? CANCEL : [...argv, task];
  }
  if (cmd === "lane" && sub === "auto" && words.length < 4) {
    const on = await ask.select(`Auto for ${words[2]}`, [{ value: "on", label: "On", hint: "safe requests are allowed once for you; dire ones still wait" }, { value: "off", label: "Off", hint: "every request waits for you" }]);
    return on === CANCEL ? CANCEL : [...argv, on];
  }
  // A lane chosen from a list gets one more question before it is deleted; one typed out was meant.
  if (cmd === "lane" && sub === "rm" && picked) {
    const sure = await ask.confirm(`Delete ${words[2]}? Its app stops and its checkout is removed. The branch is kept.`);
    return sure === true ? argv : CANCEL;
  }
  return argv;
}

/** Commands that act on one lane and cannot guess it: [command words, question]. */
const NEEDS_LANE: [string[], string][] = [
  [["term"], "Open which lane?"], [["send"], "Message which lane?"], [["lane", "rm"], "Delete which lane?"],
  [["lane", "rename"], "Rename which lane?"], [["lane", "restart"], "Restart which lane's agent?"], [["lane", "auto"], "Auto for which lane?"],
];

/**
 * Fills in a command a person left incomplete by asking, and returns the complete long command, which
 * then runs exactly as if it had been typed. CANCEL when they back out; the argv unchanged when
 * nothing is missing. Called only when canAsk says a person is there.
 */
export async function fillIn(argv: string[], io: Io, ask: Ask): Promise<Answer<string[]>> {
  const flags = argv.filter((a) => a.startsWith("-"));
  const words = argv.filter((a) => !a.startsWith("-"));
  if (!words.length && !flags.length) return (await menu(io, ask)) ?? CANCEL;
  if (words[0] === "inbox" && words.length === 1) return (await inbox(io, ask)) ?? CANCEL;
  if (words[0] === "answer" && words.length < 3) return (await inbox(io, ask)) ?? CANCEL;
  for (const [command, question] of NEEDS_LANE) {
    if (command.some((w, i) => words[i] !== w)) continue;
    if (words.length > command.length) return complete(argv, ask, io);
    const lane = await pickLane(io, ask, question);
    if (lane === null || lane === CANCEL) return CANCEL;
    return complete([...command, lane, ...flags], ask, io, true);
  }
  return complete(argv, ask, io);
}
