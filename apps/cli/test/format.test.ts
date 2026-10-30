import { describe, expect, it } from "vitest";
import type { Lane } from "@contextlanes/protocol";
import { formatInbox, formatLanes } from "@contextlanes/cli";

const lane = (n: string, state: Lane["state"], task: string): Lane => ({
  id: `shuttleworks/${n}`, project: "shuttleworks", goal: null, task, agent: "claude-code", model: null, mode: "edits",
  branch: `lane/${n}`, worktree: `/lanes/${n}`, terminal: `cl-shuttleworks-${n}`, state, colour: "lc1", createdAt: "2026-10-29T13:00:00Z",
});

describe("cli output", () => {
  it("prints lanes with a glyph and a word for each state", () => {
    const out = formatLanes([lane("01", "needs_you", "Billing phase 0"), lane("02", "working", "Solver tests")]);
    expect(out.split("\n")[0]).toMatch(/^LANE\s+PROJECT\s+STATE\s+AGENT\s+TASK$/);
    expect(out).toContain("◆ needs you");
    expect(out).toContain("● working");
  });
  it("says so when nothing is waiting", () => {
    expect(formatInbox([])).toBe("Nothing is waiting on you.");
  });
});
