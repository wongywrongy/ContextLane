import { describe, expect, it } from "vitest";
import { attachArgs, branchName, Config, hostCommand, slugify, terminalSession, worktreePath } from "@contextlanes/daemon";

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
    const config = Config.parse({ agents: { codex: { command: "/bin/fake", args: ["--acp"] } } });
    const args = hostCommand({ id: "shuttleworks/01", worktree: "/w", task: "Task\nwith spaces", agent: "codex", model: "large", mode: "ask" } as Parameters<typeof hostCommand>[0], config);
    expect(args).toContain("--unit=contextlanes-lane-shuttleworks-01");
    expect(args.slice(args.indexOf("--task"), args.indexOf("--task") + 2)).toEqual(["--task", "Task\nwith spaces"]);
    expect(args).toContain("--socket");
    expect(args).toContain("--model");
    expect(JSON.parse(args[args.indexOf("--agent-spec") + 1]!)).toEqual({ command: "/bin/fake", args: ["--acp"] });
    expect(JSON.parse(args[args.indexOf("--toolbox") + 1]!)).toMatchObject({ name: "contextlanes", env: expect.arrayContaining([{ name: "CONTEXTLANES_LANE", value: "shuttleworks/01" }]) });
  });
});
