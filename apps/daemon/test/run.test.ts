import { describe, expect, it } from "vitest";
import { runCommand } from "../src/run.js";

describe("runCommand errors", () => {
  it("leads with the program and what it said, not the command line", async () => {
    const err = await runCommand("sh", ["-c", "echo nope >&2; exit 3", "--a-very-long-flag=/some/path"]).catch((e: Error & { stderr?: string; code?: number }) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("sh failed (exit 3): nope");
    expect((err as { stderr?: string }).stderr).toBe("nope\n");
    expect((err as { code?: number }).code).toBe(3);
  });

  it("says when a program is missing", async () => {
    const err = await runCommand("contextlanes-no-such-program", ["status"]).catch((e: Error) => e);
    expect((err as Error).message).toBe("contextlanes-no-such-program status is not installed");
  });
});
