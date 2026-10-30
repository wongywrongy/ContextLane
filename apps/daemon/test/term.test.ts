import { describe, expect, it } from "vitest";
import { elapsed, Steps } from "../src/term.js";

const stream = (tty: boolean) => { const out: string[] = []; return { out, s: { isTTY: tty, write: (t: string) => { out.push(t); return true; } } as unknown as NodeJS.WriteStream }; };

describe("terminal steps", () => {
  it("prints plain lines when not on a terminal", () => {
    const { out, s } = stream(false);
    const steps = new Steps(s);
    for (const l of ["Checking for updates…", "2 new changes on main:", "  abc Faster lanes", "The new version did not start, so ContextLanes is going back to abc.", "Open ContextLanes: http://127.0.0.1:4600 (this machine only)"]) steps.log(l);
    expect(out.join("")).toBe("  Checking for updates…\n  ✓ 2 new changes on main:\n    abc Faster lanes\n  ! The new version did not start, so ContextLanes is going back to abc.\n\n  Open ContextLanes  http://127.0.0.1:4600 (this machine only)\n");
  });
  it("spins on a terminal and marks the step done with its time", () => {
    const { out, s } = stream(true);
    let now = 0;
    const steps = new Steps(s, () => now);
    steps.log("Building abc…"); now = 75_000; steps.log("Saved a copy of the database.");
    const text = out.join("");
    expect(text).toContain("Building abc");
    expect(text).toMatch(/✓.*Building abc.*1m 15s/);
    expect(text).toMatch(/✓.*Saved a copy of the database\./);
    expect(elapsed(4_000)).toBe("4s");
  });
});
