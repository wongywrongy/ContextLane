import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Config, EventBus, HostLinks, LaneManager, Store, buildServer, confineGit, runCommand, sandbox, type Runner } from "@contextlanes/daemon";
import { recover } from "../src/recover.js";
import { signedIn } from "./signed-in.js";

const bwrap = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--", "true"]).status === 0;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), "node_modules/.retention-test-"));
  const temporary = await mkdtemp(join(tmpdir(), "cl-retention-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }), () => rm(temporary, { recursive: true, force: true }));
  const repo = join(root, "repo"); const data = join(root, "data"); const lanes = join(data, "lanes");
  await mkdir(repo); await mkdir(lanes, { recursive: true });
  const git = (...args: string[]) => runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo });
  await git("init", "-qb", "main"); await writeFile(join(repo, "source"), "base\n"); await git("add", "."); await git("commit", "-qm", "base");
  const live = [join(lanes, "keep"), join(data, "external"), join(temporary, "outside-configured-roots"), join(root, "external")];
  const discarded = join(lanes, "discard"); const stale = join(root, "stale");
  for (const [index, path] of [...live, discarded, stale].entries()) await git("worktree", "add", "-b", `topic-${index}`, path);
  await rm(stale, { recursive: true });
  // Expired metadata reproduces both direct prune and GC's usual age-dependent pruning.
  for (const entry of await readdir(join(repo, ".git/worktrees"))) await utimes(join(repo, ".git/worktrees", entry, "gitdir"), new Date(0), new Date(0));
  await git("config", "gc.auto", "1"); await git("config", "maintenance.auto", "true");
  await git("config", "gc.worktreePruneExpire", "now"); await git("config", "gc.autoDetach", "false");
  const config = Config.parse({ paths: { data, lanes }, lanes: { launchHosts: false } });
  const store = Store.open(":memory:"); cleanups.push(async () => store.close());
  store.addProject({ id: "demo", name: "Demo", path: repo });
  store.insertLane({ id: "demo/01", n: 1, project: "demo", goal: null, task: "Discard only this checkout", agent: "claude-code", kind: "cli", model: null, mode: "ask", branch: "topic-4", worktree: discarded, terminal: "test", hostUnit: "test", base: "main", state: "working", colour: "lc1" } as never);
  const calls: string[][] = [];
  const inner: Runner = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" || cmd === "gh" || cmd === "bwrap") return runCommand(cmd, args, opts);
    return { stdout: "" };
  };
  const run = confineGit(inner, config, async () => true, () => repo);
  const registrations = async () => [...(await git("worktree", "list", "--porcelain")).stdout.matchAll(/^worktree (.+)$/gm)].map((match) => match[1]!).sort();
  return { root, repo, data, live, discarded, stale, config, store, run, git, calls, registrations };
}

describe.skipIf(!bwrap)("worktree registration retention in a restricted namespace", () => {
  it("startup and discarding one lane preserve every other live and stale registration", async () => {
    const f = await fixture(); const before = await f.registrations(); const bus = new EventBus();
    await recover({ ...f, bus });
    expect(await f.registrations()).toEqual(before);
    const hosts = new HostLinks({ store: f.store, bus });
    const lanes = new LaneManager({ ...f, bus });
    const app = signedIn(buildServer({ ...f, bus, hosts, lanes, version: "test" }), f.store);
    cleanups.push(() => app.close());
    const response = await app.inject({ method: "POST", url: "/api/lanes/demo/01/discard", payload: {} });
    expect(response.statusCode, response.body).toBe(200);
    expect(await f.registrations()).toEqual(before.filter((path) => path !== f.discarded));
    for (const path of f.live) expect(await readFile(join(path, "source"), "utf8")).toBe("base\n");
    expect(f.calls.some((args) => args.some((arg, index) => arg === "worktree" && args[index + 1] === "prune"))).toBe(false);
    // Deliberate cleanup from the full host view can distinguish stale registrations from live ones.
    await f.git("worktree", "prune", "--expire=now");
    expect(await f.registrations()).toEqual(before.filter((path) => path !== f.discarded && path !== f.stale));
  });

  it("refuses repository-wide cleanup, including global option forms, without touching registrations", async () => {
    const f = await fixture(); const before = await f.registrations();
    for (const args of [
      ["worktree", "prune"], ["-C", f.repo, "worktree", "prune", "--expire=now"],
      ["--git-dir", join(f.repo, ".git"), "worktree", "prune"], ["-c", "gc.worktreePruneExpire=now", "gc", "--auto"],
      ["--no-pager", "maintenance", "run", "--auto"], ["prune", "--expire=now"],
    ]) await expect(f.run("git", args, { cwd: f.repo })).rejects.toThrow(/full host view/);
    expect(f.calls).toHaveLength(0);
    expect(await f.registrations()).toEqual(before);
  });

  it("disables implicit cleanup for daemon and child Git despite repository and inherited runtime overrides", async () => {
    const f = await fixture(); const before = await f.registrations();
    const prefix = sandbox(f.config, { worktree: f.discarded, repository: f.repo });
    const env = {
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "gc.worktreePruneExpire", GIT_CONFIG_VALUE_0: "now",
      GIT_CONFIG_PARAMETERS: "'maintenance.auto=true' 'gc.auto=1' 'gc.worktreePruneExpire=now'",
    };
    const child = (...args: string[]) => runCommand(prefix[0]!, [...prefix.slice(1), "git", ...args], { cwd: f.discarded, env });
    for (const [key, value] of [["gc.auto", "0"], ["maintenance.auto", "false"], ["gc.worktreePruneExpire", "never"]]) {
      expect((await child("config", "--get", key!)).stdout.trim()).toBe(value);
      expect((await f.run("git", ["-c", `${key}=now`, "config", "--get", key!], { cwd: f.discarded, env })).stdout.trim()).toBe(value);
    }
    await child("fetch", join(f.repo, ".git"), "main");
    await child("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "child commit");
    await child("gc", "--auto");
    // Even explicitly invoked GC inherits the non-pruning setting; direct worktree prune remains
    // an owner-only operation outside the sandbox, not a complete hostile-agent security boundary.
    await child("gc");
    await f.run("git", ["-c", "gc.auto=1", "-c", "maintenance.auto=true", "-c", "gc.worktreePruneExpire=now", "fetch", join(f.repo, ".git"), "main"], { cwd: f.discarded, env });
    expect(await f.registrations()).toEqual(before);
  });
});
