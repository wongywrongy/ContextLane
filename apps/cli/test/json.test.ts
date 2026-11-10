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
    expect(help).toContain("cl new");
    expect(help).not.toContain("\u001b[");
  }, 30_000);

  it("reports wrong usage as JSON on stderr with exit 2 and nothing on stdout", () => {
    for (const args of [["bogus"], ["send"], ["answer"], ["lane"]]) {
      const { exit, out, err } = cli(...args, "--json");
      expect(exit, args.join(" ")).toBe(2);
      expect(out).toBe("");
      expect(JSON.parse(err)).toMatchObject({ code: "usage" });
    }
  }, 60_000);

  it("reports a daemon that is not answering as JSON with exit 3", () => {
    for (const args of [["status"], ["lanes"], ["setup"], ["inbox"]]) {
      const { exit, out, err } = cli(...args, "--json");
      expect(exit, args.join(" ")).toBe(3);
      expect(out).toBe("");
      expect(JSON.parse(err)).toMatchObject({ code: "unreachable" });
    }
  }, 60_000);
});

describe("no terminal, no questions", () => {
  it("prints help or a usage error at once instead of asking, as an agent or a script needs", () => {
    const bare = cli();
    expect(bare.exit).toBe(0);
    expect(bare.out).toContain("cl new");
    for (const args of [["new"], ["rm"], ["say"], ["sh"]]) {
      const { exit, out } = cli(...args);
      expect(exit, args.join(" ")).toBe(2);
      expect(out).toBe("");
    }
  }, 60_000);
});
