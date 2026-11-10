import { describe, expect, it } from "vitest";
import { CANCEL, canAsk, fillIn, session, type Ask, type Choice } from "../src/interactive.js";
import type { Io } from "../src/lane.js";

type Data = { projects: object[]; lanes: Record<string, unknown>[]; inbox: Record<string, unknown>[] };
const lane = (project: string, n: number, extra: object = {}) => ({ id: `${project}/0${n}`, project, task: `Task ${n}`, state: "working", agent: "claude-code", kind: "cli", branch: `lane/0${n}`, worktree: `/lanes/${project}/0${n}`, ...extra });
const shop = { id: "shop", name: "Shop", path: "/code/shop" }, ara = { id: "ara", name: "Ara", path: "/code/ara" };
const permission = { id: "shop/01#r1", lane: "shop/01", kind: "permission", title: "Run pnpm install", options: [{ id: "allow", label: "Allow once", kind: "allow_once" }, { id: "deny", label: "Deny", kind: "reject_once" }] };
const recipe = { id: "shop/02#recipe", lane: "shop/02", kind: "approval", title: "Recipe needs approval", options: [] };

/** A pretend machine: the API reads `data`, and `exec` records each command and applies what it would change. */
function machine(data: Partial<Data> = {}, cwd = "/code/shop") {
  const state: Data = { projects: [shop, ara], lanes: [lane("shop", 1), lane("shop", 2, { kind: "shell", agent: "none" }), lane("shop", 3, { state: "archived" }), lane("ara", 1)], inbox: [], ...data };
  const ran: string[][] = [];
  const io: Io = { env: {}, cwd, out: () => {}, err: () => {}, api: (async (path: string) => path === "/api/projects" ? state.projects : path === "/api/lanes" ? state.lanes : path === "/api/inbox" ? state.inbox : []) as Io["api"] };
  const exec = async (argv: string[]) => {
    ran.push(argv);
    if (argv[0] === "lane" && argv[1] === "rm") state.lanes = state.lanes.filter((l) => l.id !== argv[2]);
    if (argv[0] === "lane" && argv[1] === "start") state.lanes.push(lane(argv[2]!, 9, { task: argv[3] }));
    if (argv[0] === "answer") state.inbox = state.inbox.filter((i) => i.id !== argv[1]);
    if (argv[0] === "add") state.projects.push({ id: "fresh", name: "Fresh", path: cwd });
    if (argv[0] === "remove") state.projects = state.projects.filter((p) => (p as { id: string }).id !== argv[1]);
    return 0;
  };
  return { io, exec, ran, state };
}

/** Answers each question in turn and records every screen shown. A select answer is part of the label to choose. */
function script(...answers: (string | boolean | typeof CANCEL)[]) {
  const screens: { message: string; labels: string[] }[] = []; const notes: string[] = [];
  const next = (message: string) => { if (!answers.length) throw new Error(`unexpected question: ${message}`); return answers.shift()!; };
  const ask: Ask = {
    select: async <T,>(message: string, options: Choice<T>[]) => {
      screens.push({ message, labels: options.map((o) => o.label) });
      const a = next(message); if (a === CANCEL) return CANCEL;
      const found = options.find((o) => o.label.includes(String(a))); if (!found) throw new Error(`no option "${String(a)}" on "${message}": ${options.map((o) => o.label).join(" | ")}`);
      return found.value;
    },
    text: async (message, initial) => { screens.push({ message, labels: initial ? [initial] : [] }); return next(message) as string | typeof CANCEL; },
    confirm: async (message) => { screens.push({ message, labels: [] }); return next(message) as boolean | typeof CANCEL; },
    note: (text) => { notes.push(text); },
  };
  return { ask, screens, notes, left: answers };
}

describe("who gets asked", () => {
  const tty = { in: true, out: true };
  it("only a person at a terminal", () => {
    expect(canAsk([], {}, tty)).toBe(true);
    expect(canAsk(["rm", "--json"], {}, tty)).toBe(false);
    expect(canAsk([], { CONTEXTLANES_LANE_TOKEN: "lane-secret" }, tty)).toBe(false);
    expect(canAsk([], { CI: "true" }, tty)).toBe(false);
    expect(canAsk([], {}, { in: false, out: true })).toBe(false);
    expect(canAsk([], {}, { in: true, out: false })).toBe(false);
  });
});

describe("cl on its own: projects, then a project's lanes, then one lane", () => {
  it("starts at Projects outside every project, and each level has a way back", async () => {
    const m = machine({}, "/tmp/elsewhere");
    const s = script("Shop", "01", "Shop", "Projects", "Quit");
    expect(await session(m.io, s.ask, m.exec)).toBe(0);
    expect(s.screens.map((x) => x.message)).toEqual(["Projects", "Shop  ·  2 lanes", "Shop / 01  ·  Task 1", "Shop  ·  2 lanes", "Projects"]);
    expect(s.screens[0]!.labels.at(-1)).toBe("Quit");
    expect(s.screens[1]!.labels.at(-1)).toBe("← Projects");
    expect(s.screens[2]!.labels.at(-1)).toBe("← Shop");
    expect(m.ran).toEqual([]);
  });

  it("starts inside the project this folder belongs to, and Esc goes back one level at a time", async () => {
    const m = machine({}, "/lanes/shop/01/src");
    const s = script("02", CANCEL, CANCEL, CANCEL);
    expect(await session(m.io, s.ask, m.exec)).toBe(0);
    expect(s.screens.map((x) => x.message.split("  ·")[0])).toEqual(["Shop", "Shop / 02", "Shop", "Projects"]);
  });

  it("says how to move once, shortens home paths, and keeps the cursor on the last thing done", async () => {
    const m = machine({ projects: [{ id: "shop", name: "Shop", path: "/home/kyle/code/shop" }], lanes: [lane("shop", 1)] }, "/tmp/elsewhere");
    m.io.env.HOME = "/home/kyle";
    const hints: (string | undefined)[][] = []; const initials: unknown[] = [];
    const s = script("Shop", "01", "Start its app", "Shop", "Projects", "Quit");
    const select = s.ask.select;
    s.ask.select = (async (message: string, options: Choice<unknown>[], initial?: unknown) => { hints.push(options.map((o) => o.hint)); initials.push(initial); return select(message, options); }) as Ask["select"];
    await session(m.io, s.ask, m.exec);
    expect(s.notes).toEqual(["↑ ↓ move   ·   Enter opens   ·   Esc goes back a step"]);
    expect(hints[0]![0]).toBe("~/code/shop · 1 lane");
    expect(initials.slice(2, 4)).toEqual([undefined, "up"]);
  });

  it("lists only this project's open lanes", async () => {
    const s = script("Projects", "Quit");
    await session(machine().io, s.ask, async () => 0);
    expect(s.screens[0]!.labels.filter((l) => /^\d/.test(l))).toEqual(["01  Task 1", "02  Task 2"]);
  });

  it("stays on the lane after an action, so several can be done in a row", async () => {
    const m = machine();
    await session(m.io, script("01", "Start its app", "Show its app", "Send its agent a message", "Use v2", "Shop", "Projects", "Quit").ask, m.exec);
    expect(m.ran).toEqual([["env", "start", "shop/01"], ["env", "shop/01"], ["send", "shop/01", "Use v2"]]);
  });

  it("offers messaging only where there is an agent", async () => {
    const s = script("02", "Shop", "Projects", "Quit");
    await session(machine().io, s.ask, async () => 0);
    expect(s.screens[1]!.labels).toContain("Open its shell");
    expect(s.screens[1]!.labels).not.toContain("Send its agent a message");
  });

  it("makes a lane: the task, who works on it, then lands on the new lane; back keeps the task", async () => {
    const m = machine();
    const s = script("New lane", "Add CSV", "Change the task", "Add CSV export", "Codex", "Shop", "Projects", "Quit");
    await session(m.io, s.ask, m.exec);
    expect(m.ran).toEqual([["lane", "start", "shop", "Add CSV export", "--agent", "codex"]]);
    expect(s.screens[3]!.labels).toEqual(["Add CSV"]);
    expect(s.screens[5]!.message).toBe("Shop / 09  ·  Add CSV export");
  });

  it("backs out of a new lane with Esc without starting anything", async () => {
    const m = machine();
    await session(m.io, script("New lane", CANCEL, "Projects", "Quit").ask, m.exec);
    expect(m.ran).toEqual([]);
  });

  it("asks before deleting, and returns to the project once the lane is gone", async () => {
    const no = machine();
    await session(no.io, script("02", "Delete it", false, "Shop", "Projects", "Quit").ask, no.exec);
    expect(no.ran).toEqual([]);
    const yes = machine();
    const s = script("02", "Delete it", true, "Projects", "Quit");
    await session(yes.io, s.ask, yes.exec);
    expect(yes.ran).toEqual([["lane", "rm", "shop/02"]]);
    expect(s.screens.at(-2)!.message).toBe("Shop  ·  1 lane");
  });

  it("makes this folder a project first, then goes into it", async () => {
    const m = machine({ projects: [], lanes: [] }, "/code/fresh");
    const s = script("Make this folder a project", "Projects", "Quit");
    await session(m.io, s.ask, m.exec);
    expect(s.screens[0]!.message).toContain("No projects yet");
    expect(m.ran).toEqual([["add"]]);
    expect(s.screens[1]!.message).toBe("Fresh  ·  no lanes yet");
    expect(s.screens[2]!.labels).not.toContain("+ Make this folder a project");
  });

  it("answers what is waiting from the project or the lane, and reads a recipe before approving", async () => {
    const m = machine({ inbox: [permission, recipe] });
    await session(m.io, script("Answer what is waiting", "Run pnpm install", "Allow once", "Recipe needs approval", "Read the recipe", "Recipe needs approval", "Approve it", "Recipe needs approval", "Leave it", "Projects", "Quit").ask, m.exec);
    expect(m.ran).toEqual([["answer", "shop/01#r1", "allow"], ["recipe", "shop/02"], ["recipe", "approve", "shop/02"]]);
    const one = machine({ inbox: [permission] });
    await session(one.io, script("01", "Answer what it is waiting for", "Deny", "Shop", "Projects", "Quit").ask, one.exec);
    expect(one.ran).toEqual([["answer", "shop/01#r1", "deny"]]);
  });
});

describe("a typed command with something left out", () => {
  it("asks nothing when the command is complete", async () => {
    const m = machine();
    for (const argv of [["lane", "rm", "shop/01"], ["send", "shop/01", "hi"], ["lane", "start", "shop", "Task"], ["lanes"], ["env", "start"], ["status"], ["doctor"], ["--help"], ["answer", "shop/01#r1", "allow"], ["lane", "auto", "shop/01", "on"], ["term", "shop/01"], ["inbox"]]) {
      expect(await fillIn(argv, m.io, script().ask, m.exec), argv.join(" ")).toBeNull();
    }
    expect(m.ran).toEqual([]);
  });

  it("new: asks the task and who, in this project, keeping the flags", async () => {
    const m = machine();
    expect(await fillIn(["lane", "start", "--here"], m.io, script("Fix it", "Claude Code").ask, m.exec)).toBe(0);
    expect(m.ran).toEqual([["lane", "start", "shop", "Fix it", "--agent", "claude-code", "--here"]]);
  });

  it("new outside a project: which project first, or make this folder one", async () => {
    const m = machine({}, "/tmp/elsewhere");
    await fillIn(["lane", "start"], m.io, script("Ara", "Wake word", "No agent").ask, m.exec);
    expect(m.ran).toEqual([["lane", "start", "ara", "Wake word", "--no-agent"]]);
    const fresh = machine({ projects: [], lanes: [] }, "/code/fresh");
    await fillIn(["lane", "start"], fresh.io, script("Make this folder a project", "Try it", "No agent").ask, fresh.exec);
    expect(fresh.ran).toEqual([["add"], ["lane", "start", "fresh", "Try it", "--no-agent"]]);
  });

  it("asks which lane of this project, then for the rest", async () => {
    const m = machine();
    const s = script("02");
    await fillIn(["term"], m.io, s.ask, m.exec);
    expect(s.screens[0]!.labels).toEqual(["01  Task 1", "02  Task 2", "Cancel"]);
    await fillIn(["send"], m.io, script("01", "hello").ask, m.exec);
    await fillIn(["lane", "auto"], m.io, script("01", "On").ask, m.exec);
    await fillIn(["lane", "rename", "shop/01"], m.io, script("Better name").ask, m.exec);
    await fillIn(["lane", "rm", "--force"], m.io, script("01", true).ask, m.exec);
    expect(m.ran).toEqual([["term", "shop/02"], ["send", "shop/01", "hello"], ["lane", "auto", "shop/01", "on"], ["lane", "rename", "shop/01", "Better name"], ["lane", "rm", "shop/01", "--force"]]);
  });

  it("does nothing when the person cancels or says no", async () => {
    const m = machine();
    expect(await fillIn(["lane", "rm"], m.io, script("01", false).ask, m.exec)).toBe(0);
    expect(await fillIn(["lane", "rm"], m.io, script("Cancel").ask, m.exec)).toBe(0);
    expect(await fillIn(["send"], m.io, script("01", CANCEL).ask, m.exec)).toBe(0);
    expect(m.ran).toEqual([]);
  });

  it("skips the list when the project has one lane, and says so when it has none", async () => {
    const one = machine({ lanes: [lane("shop", 1)] });
    await fillIn(["term"], one.io, script().ask, one.exec);
    expect(one.ran).toEqual([["term", "shop/01"]]);
    const none = machine({ lanes: [] }); const s = script();
    expect(await fillIn(["term"], none.io, s.ask, none.exec)).toBe(0);
    expect(s.notes[0]).toContain("Shop has no open lanes");
  });

  it("inbox and ok answer without copying an id", async () => {
    const m = machine({ inbox: [permission] });
    await fillIn(["inbox"], m.io, script("Run pnpm install", "Allow once").ask, m.exec);
    expect(m.ran).toEqual([["answer", "shop/01#r1", "allow"]]);
    const again = machine({ inbox: [permission] });
    await fillIn(["answer"], again.io, script("Run pnpm install", "Deny").ask, again.exec);
    expect(again.ran).toEqual([["answer", "shop/01#r1", "deny"]]);
  });
});
