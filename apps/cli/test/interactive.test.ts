import { describe, expect, it } from "vitest";
import { CANCEL, canAsk, fillIn, type Ask, type Choice } from "../src/interactive.js";
import type { Io } from "../src/lane.js";

const lane = (n: number, extra: object = {}) => ({ id: `shop/0${n}`, project: "shop", task: `Task ${n}`, state: "working", agent: "claude-code", kind: "cli", worktree: `/lanes/shop/0${n}`, ...extra });
const io = (data: Record<string, unknown>): Io => ({ env: {}, cwd: "/code/shop", out: () => {}, err: () => {}, api: (async (path: string) => data[path] ?? []) as Io["api"] });
/** Answers each question in turn; records what was asked. A select answer is the label to choose. */
function script(...answers: (string | boolean | typeof CANCEL)[]) {
  const asked: string[] = []; const notes: string[] = [];
  const next = () => { if (!answers.length) throw new Error(`unexpected question: ${asked.at(-1)}`); return answers.shift()!; };
  const ask: Ask = {
    select: async <T,>(message: string, options: Choice<T>[]) => { asked.push(message); const a = next(); if (a === CANCEL) return CANCEL; const found = options.find((o) => o.label.includes(String(a))); if (!found) throw new Error(`no option ${String(a)} in ${options.map((o) => o.label).join(" | ")}`); return found.value; },
    text: async (message) => { asked.push(message); return next() as string | typeof CANCEL; },
    confirm: async (message) => { asked.push(message); return next() as boolean | typeof CANCEL; },
    note: (text) => { notes.push(text); },
  };
  return { ask, asked, notes, left: answers };
}
const two = { "/api/lanes": [lane(1), lane(2, { kind: "shell", agent: "none" }), lane(3, { state: "archived" })], "/api/projects": [{ id: "shop", path: "/code/shop" }] };

describe("who gets asked", () => {
  const tty = { in: true, out: true };
  it("only a person at a terminal", () => {
    expect(canAsk([], {}, tty)).toBe(true);
    expect(canAsk(["new"], {}, tty)).toBe(true);
    expect(canAsk(["rm", "--json"], {}, tty)).toBe(false);
    expect(canAsk([], { CONTEXTLANES_LANE_TOKEN: "lane-secret" }, tty)).toBe(false);
    expect(canAsk([], { CI: "true" }, tty)).toBe(false);
    expect(canAsk([], {}, { in: false, out: true })).toBe(false);
    expect(canAsk([], {}, { in: true, out: false })).toBe(false);
  });
});

describe("cl on its own", () => {
  it("lists open lanes and opens the one chosen", async () => {
    const s = script("shop/01", "Open its terminal");
    expect(await fillIn([], io(two), s.ask)).toEqual(["term", "shop/01"]);
    expect(s.asked).toEqual(["Lanes", "shop/01  Task 1"]);
  });

  it("offers messaging only where there is an agent, and goes back", async () => {
    const s = script("shop/02", "Back", "shop/01", "Send its agent a message", "Use the v2 endpoint");
    expect(await fillIn([], io(two), s.ask)).toEqual(["send", "shop/01", "Use the v2 endpoint"]);
    await expect(fillIn([], io(two), script("shop/02", "Send its agent a message").ask)).rejects.toThrow("no option");
  });

  it("starts a lane: the task, then who works on it", async () => {
    expect(await fillIn([], io(two), script("New lane", "Add CSV export", "Codex").ask)).toEqual(["lane", "start", "shop", "Add CSV export", "--agent", "codex"]);
    expect(await fillIn([], io({}), script("New lane", "Try it", "No agent").ask)).toEqual(["lane", "start", ".", "Try it", "--no-agent"]);
  });

  it("asks before deleting a lane picked from the list", async () => {
    expect(await fillIn([], io(two), script("shop/02", "Delete it", true).ask)).toEqual(["lane", "rm", "shop/02"]);
    expect(await fillIn([], io(two), script("shop/02", "Delete it", false).ask)).toBe(CANCEL);
    expect(await fillIn([], io(two), script(CANCEL).ask)).toBe(CANCEL);
  });
});

describe("a command with something left out", () => {
  it("asks for the task of a new lane and keeps the flags", async () => {
    expect(await fillIn(["lane", "start", "--here"], io(two), script("Fix it", "Claude Code").ask)).toEqual(["lane", "start", "shop", "Fix it", "--agent", "claude-code", "--here"]);
  });

  it("asks which lane, then for the rest", async () => {
    expect(await fillIn(["term"], io(two), script("shop/02").ask)).toEqual(["term", "shop/02"]);
    expect(await fillIn(["send"], io(two), script("shop/01", "hello").ask)).toEqual(["send", "shop/01", "hello"]);
    expect(await fillIn(["lane", "rm", "--force"], io(two), script("shop/01", true).ask)).toEqual(["lane", "rm", "shop/01", "--force"]);
    expect(await fillIn(["lane", "auto"], io(two), script("shop/01", "On").ask)).toEqual(["lane", "auto", "shop/01", "on"]);
    expect(await fillIn(["lane", "rename", "shop/01"], io(two), script("Better name").ask)).toEqual(["lane", "rename", "shop/01", "Better name"]);
  });

  it("skips the list when there is one lane, and says so when there is none", async () => {
    expect(await fillIn(["term"], io({ "/api/lanes": [lane(1)] }), script().ask)).toEqual(["term", "shop/01"]);
    const none = script();
    expect(await fillIn(["term"], io({}), none.ask)).toBe(CANCEL);
    expect(none.notes[0]).toContain("No open lanes");
  });

  it("asks nothing when the command is complete", async () => {
    for (const argv of [["lane", "rm", "shop/01"], ["send", "shop/01", "hi"], ["lane", "start", "shop", "Task"], ["lanes"], ["env", "start"], ["status"], ["doctor"], ["--help"], ["answer", "shop/01#r1", "allow"]]) {
      expect(await fillIn(argv, io(two), script().ask), argv.join(" ")).toEqual(argv);
    }
  });
});

describe("what is waiting on you", () => {
  const permission = { id: "shop/01#r1", lane: "shop/01", kind: "permission", title: "Run pnpm install", options: [{ id: "allow", label: "Allow once", kind: "allow_once" }, { id: "deny", label: "Deny", kind: "reject_once" }] };
  const recipe = { id: "shop/02#recipe", lane: "shop/02", kind: "approval", title: "Recipe needs approval", options: [] };

  it("answers the one request without copying an id", async () => {
    expect(await fillIn(["inbox"], io({ "/api/inbox": [permission] }), script("Allow once").ask)).toEqual(["answer", "shop/01#r1", "allow"]);
    expect(await fillIn(["answer"], io({ "/api/inbox": [permission] }), script("Deny").ask)).toEqual(["answer", "shop/01#r1", "deny"]);
  });

  it("lets you pick among several, and reads a recipe before approving it", async () => {
    const data = { "/api/inbox": [permission, recipe] };
    expect(await fillIn(["inbox"], io(data), script("Recipe needs approval", "Read the recipe").ask)).toEqual(["recipe", "shop/02"]);
    expect(await fillIn(["inbox"], io(data), script("Recipe needs approval", "Approve it").ask)).toEqual(["recipe", "approve", "shop/02"]);
    expect(await fillIn(["inbox"], io(data), script("Recipe needs approval", "Leave it").ask)).toBe(CANCEL);
  });

  it("just prints the empty inbox when nothing waits", async () => {
    expect(await fillIn(["inbox"], io({}), script().ask)).toEqual(["inbox"]);
  });
});
