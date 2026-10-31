import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Config, EventBus, LaneManager, Store, runCommand, type HostLinks, type Runner } from "@contextlanes/daemon";
import { Handoffs } from "../src/handoff.js";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

async function fixture(connected = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cl-handoff-"))); roots.push(root);
  const repo = join(root, "shop"); await mkdir(repo);
  const git = (cwd: string, ...a: string[]) => runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...a], { cwd });
  await git(repo, "init", "-q"); await writeFile(join(repo, "a.txt"), "one\n"); await git(repo, "add", "-A"); await git(repo, "commit", "-qm", "one");
  const store = Store.open(":memory:"); const bus = new EventBus();
  store.addProject({ id: "shop", name: "Shop", path: repo });
  const calls: string[][] = [];
  const run: Runner = async (cmd, args, opts) => { if (cmd === "git") return runCommand(cmd, args, opts); calls.push([cmd, ...args]); return { stdout: "" }; };
  const config = Config.parse({ paths: { data: join(root, "data"), lanes: join(root, "lanes") }, lanes: { launchHosts: false } });
  const lanes = new LaneManager({ store, bus, config, run });
  const lane = await lanes.start({ project: "shop", task: "Billing", agent: "claude-code", base: "main" });
  const hosts = { command: (id: string, c: { kind: string }) => {
    const commandId = "6e0c8a8e-8a1c-4a4b-9d7f-0f2b4a6b1c11";
    if (connected && c.kind === "prompt") setTimeout(() => {
      store.appendEvent(id, { type: "agent.turn", payload: { active: true, commandId } });
      store.appendEvent(id, { type: "agent.message", payload: { text: "Done: invoice table. Left: webhook stub. Rule: times are UTC.", role: "agent" } });
      store.appendEvent(id, { type: "agent.turn", payload: { active: false, commandId } });
    }, 20);
    return { commandId, delivered: connected };
  } } as unknown as HostLinks;
  return { store, lanes, lane, calls, handoffs: new Handoffs({ config, store, bus, hosts, lanes, run, waitMs: 2000 }), root };
}
const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); };

describe("hand off, fresh session and fork", () => {
  it("hands the lane to another agent from a handoff its current agent wrote, in the same checkout", async () => {
    const f = await fixture();
    await f.handoffs.replace(f.lane.id, { agent: "codex", note: "Keep payments out." });
    // The handoff is recorded, then the new host starts: wait for both.
    await until(() => f.store.events(f.lane.id).some((e) => e.type === "lane.handoff") && f.calls.some((c) => c[0] === "systemd-run"));
    const e = f.store.events(f.lane.id).find((x) => x.type === "lane.handoff")!;
    expect(e.payload).toMatchObject({ from: "claude-code", to: "codex", model: null });
    expect(await readFile((e.payload as { file: string }).file, "utf8")).toContain("Rule: times are UTC.\n\nFrom the owner: Keep payments out.");
    expect(f.store.getLane(f.lane.id)).toMatchObject({ agent: "codex", worktree: f.lane.worktree });
    expect(f.calls.map((c) => c.slice(0, 3).join(" "))).toContain("systemctl --user stop");
    const start = f.calls.find((c) => c[0] === "systemd-run")!;
    expect(start.find((a) => a.startsWith("--agent="))).toBe("--agent=codex");
    // The first message goes in a file, not an argument.
    const file = start.find((a) => a.startsWith("--task-file="))!.slice("--task-file=".length);
    expect(await (await import("node:fs/promises")).readFile(file, "utf8")).toContain("from a handoff written by the previous session (claude-code)");
    expect(start.some((a) => a.startsWith("--task="))).toBe(false);
  });

  it("never hands a lane to an agent that acts without asking, or to one it does not know", async () => {
    const f = await fixture();
    await expect(f.handoffs.replace(f.lane.id, { agent: "auggie" })).rejects.toThrow(/Auggie cannot run in a lane/);
    await expect(f.handoffs.replace(f.lane.id, { agent: "invented" })).rejects.toThrow(/no agent called invented/);
    expect(f.store.getLane(f.lane.id)!.agent).toBe("claude-code");
  });

  it("says why when the agent is not connected", async () => {
    const f = await fixture(false);
    await f.handoffs.replace(f.lane.id, {});
    await until(() => f.store.events(f.lane.id).some((e) => e.type === "agent.error"));
    expect(f.store.events(f.lane.id).find((e) => e.type === "agent.error")!.payload).toMatchObject({ message: expect.stringContaining("Use Fork instead") });
  });

  it("forks a new lane from this lane's branch with its uncommitted changes", async () => {
    const f = await fixture();
    await writeFile(join(f.lane.worktree, "a.txt"), "one\ntwo\n"); await writeFile(join(f.lane.worktree, "new.txt"), "fresh\n");
    f.store.appendEvent(f.lane.id, { type: "agent.message", payload: { text: "Added the second line.", role: "agent" } });
    const fork = await f.handoffs.fork(f.lane.id, {});
    expect(fork).toMatchObject({ task: "Fork of 01: Billing", base: f.lane.branch, agent: "claude-code" });
    expect(await readFile(join(fork.worktree, "a.txt"), "utf8")).toBe("one\ntwo\n");
    expect(await readFile(join(fork.worktree, "new.txt"), "utf8")).toBe("fresh\n");
    expect(f.store.events(f.lane.id).at(-1)).toMatchObject({ type: "lane.forked", payload: { to: fork.id } });
  });
});
