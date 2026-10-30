import { describe, expect, it } from "vitest";
import { attachArgs, branchName, hostCommand, slugify, terminalSession, worktreePath } from "@contextlanes/daemon";

describe("lane naming", () => {
  it("slugifies tasks", () => {
    expect(slugify("Billing phase 0: invoices!")).toBe("billing-phase-0-invoices");
    expect(slugify("***")).toBe("lane");
  });
  it("names branches, worktrees and terminals", () => {
    expect(branchName(1, "Billing phase 0")).toBe("lane/01-billing-phase-0");
    expect(worktreePath("/home/k/lanes", "shuttleworks", 2, "Solver tests")).toBe("/home/k/lanes/shuttleworks/02-solver-tests");
    expect(terminalSession("shuttleworks/01")).toBe("cl-shuttleworks-01");
    expect(attachArgs("cl-shuttleworks-01")).toEqual(["attach-session", "-t", "cl-shuttleworks-01"]);
  });
  it("runs lane hosts as their own systemd units", () => {
    expect(hostCommand("shuttleworks/01", "/w")).toContain("--unit=contextlanes-lane-shuttleworks-01");
  });
});
