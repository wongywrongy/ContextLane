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
    expect(attachArgs("cl-shuttleworks-01")).toEqual(["attach-session", "-t", "=cl-shuttleworks-01"]);
  });
  it("runs lane hosts as their own systemd units", () => {
    const config = Config.parse({ agents: { codex: { command: "/bin/fake", args: ["--acp"], env: { TOKEN: "a$b" } } } });
    const args = hostCommand({ id: "shuttleworks/01", worktree: "/w", task: "- fix $HOME\nwith spaces", agent: "codex", model: "large", mode: "ask" } as Parameters<typeof hostCommand>[0], config);
    expect(args).toContain("--unit=contextlanes-lane-shuttleworks-01");
    const value = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    expect(value("task")).toBe("- fix $$HOME\nwith spaces");
    expect(value("socket")).toMatch(/lanes\.sock$/);
    expect(value("model")).toBe("large");
    expect(JSON.parse(value("agent-spec")!.replaceAll("$$", "$"))).toEqual({ command: "/bin/fake", args: ["--acp"], env: { TOKEN: "a$b" } });
    expect(JSON.parse(value("toolbox")!)).toMatchObject({ name: "contextlanes", env: expect.arrayContaining([{ name: "CONTEXTLANES_LANE", value: "shuttleworks/01" }]) });
  });
  it("lane host arguments survive a task that starts with a dash", async () => {
    const { parseArgs } = await import("node:util");
    const args = hostCommand({ id: "shop/01", worktree: "/w", task: "-- fix login", agent: "claude-code", model: null, mode: "ask" } as Parameters<typeof hostCommand>[0], Config.parse({}));
    const own = args.slice(args.findIndex((a) => a.startsWith("--lane=")));
    const { values } = parseArgs({ args: own, options: { lane: { type: "string" }, task: { type: "string" }, agent: { type: "string" }, socket: { type: "string" }, mode: { type: "string" }, toolbox: { type: "string" }, model: { type: "string" }, "agent-spec": { type: "string" } } });
    expect(values.task).toBe("-- fix login");
  });
});
