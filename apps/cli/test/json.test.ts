import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
/** The real command, as an agent runs it, against an address where nothing listens. */
const cli = (...args: string[]) => {
  const done = spawnSync(tsx, [main, ...args], { encoding: "utf8", env: { ...process.env, CONTEXTLANES_URL: "http://127.0.0.1:1", CONTEXTLANES_LANE: "", CONTEXTLANES_LANE_TOKEN: "" } });
  return { exit: done.status, out: done.stdout, err: done.stderr };
};

describe("--json on every command", () => {
  it("prints help as one JSON document without colour codes", () => {
    const { exit, out } = cli("help", "--json");
    expect(exit).toBe(0);
    const { help } = JSON.parse(out) as { help: string };
    expect(help).toContain('contextlanes new "<task>"');
    expect(help).toContain("contextlanes app start");
    expect(help).not.toMatch(/\bcl /);
    expect(help).not.toContain("\u001b[");
  }, 30_000);

  it("reports wrong usage as JSON on stderr with exit 2 and nothing on stdout", () => {
    for (const args of [["bogus"], ["send"], ["answer"], ["new"], ["app"], ["open"], ["delete"]]) {
      const { exit, out, err } = cli(...args, "--json");
      expect(exit, args.join(" ")).toBe(2);
      expect(out).toBe("");
      expect(JSON.parse(err)).toMatchObject({ code: "usage" });
    }
  }, 60_000);

  it("reports a daemon that is not answering as JSON with exit 3", () => {
    for (const args of [["status"], ["list"], ["setup"], ["inbox"]]) {
      const { exit, out, err } = cli(...args, "--json");
      expect(exit, args.join(" ")).toBe(3);
      expect(out).toBe("");
      expect(JSON.parse(err)).toMatchObject({ code: "unreachable" });
    }
  }, 60_000);
});

describe("one word per action", () => {
  /** Every second spelling there used to be. None is an alias now: each is refused before anything is asked of the daemon. */
  const removed = [["lane", "start", "shop", "Task"], ["lanes"], ["ls"], ["up"], ["down"], ["ps"], ["say", "shop/01", "hi"], ["sh", "shop/01"], ["rm", "shop/01"], ["ok", "shop/01#r1", "allow"],
    ["env"], ["env", "start"], ["env", "stop"], ["env", "restart"], ["term", "shop/01"], ["lane", "rm", "shop/01"], ["lane", "rename", "shop/01", "x"], ["lane", "restart", "shop/01"], ["lane", "auto", "shop/01", "on"], ["restart"], ["recipe", "approve", "shop/01"]];

  it("refuses each removed spelling as wrong usage, as JSON on stderr with exit 2", () => {
    for (const args of removed) {
      const { exit, out, err } = cli(...args, "--json");
      expect(exit, args.join(" ")).toBe(2);
      expect(out, args.join(" ")).toBe("");
      expect(JSON.parse(err), args.join(" ")).toMatchObject({ code: "usage" });
    }
  }, 120_000);

  it("says a removed spelling is unknown without --json too", () => {
    for (const args of [["ls"], ["up"], ["lane", "rm", "shop/01"], ["term", "shop/01"]]) {
      const { exit, out, err } = cli(...args);
      expect(exit, args.join(" ")).toBe(2);
      expect(out).toBe("");
      expect(err).toContain(`Unknown command: ${args[0]}`);
    }
  }, 60_000);
});

describe("no terminal, no questions", () => {
  it("prints help or a usage error at once instead of asking, as an agent or a script needs", () => {
    const bare = cli();
    expect(bare.exit).toBe(0);
    expect(bare.out).toContain("contextlanes new");
    for (const args of [["new"], ["delete"], ["send"], ["open"], ["rename"], ["resume"], ["auto"]]) {
      const { exit, out } = cli(...args);
      expect(exit, args.join(" ")).toBe(2);
      expect(out).toBe("");
    }
  }, 60_000);
});
