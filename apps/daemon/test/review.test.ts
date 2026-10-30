import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer, Config, EventBus, HostLinks, LaneManager, runCommand, Store, type Runner } from "@contextlanes/daemon";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

/** Real git against a throwaway bare remote; gh is the only fake, so nothing can leave this folder. */
async function fixture(opts: { ghFails?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "cl-review-"));
  roots.push(root);
  const remote = join(root, "remote.git"); const repo = join(root, "repo"); const worktree = join(root, "lane");
  const git = (cwd: string, ...args: string[]) => exec("git", ["-c", "user.name=CL", "-c", "user.email=cl@example.invalid", "-c", "core.editor=true", ...args], { cwd });
  await mkdir(repo); await mkdir(remote);
  await git(remote, "init", "--bare", "-b", "main");
  await git(repo, "init", "-b", "main");
  await git(repo, "remote", "add", "origin", remote);
  await writeFile(join(repo, "app.txt"), "one\n");
  await git(repo, "add", "."); await git(repo, "commit", "-m", "First"); await git(repo, "push", "origin", "main");
  await git(repo, "worktree", "add", "-b", "lane/01-billing", worktree);
  await git(worktree, "config", "user.name", "CL"); await git(worktree, "config", "user.email", "cl@example.invalid");
  await writeFile(join(worktree, "feature.txt"), "feature\n");
  await git(worktree, "add", "."); await git(worktree, "commit", "-m", "Feature");

  const calls: string[][] = [];
  const state = { ghFails: opts.ghFails ?? false, prs: 0, tmuxGone: false };
  const run: Runner = async (cmd, args, options) => {
    calls.push([cmd, ...args]);
    if (["tmux", "systemctl", "tailscale"].includes(cmd)) { if (cmd === "tmux" && state.tmuxGone) throw new Error("no session"); return { stdout: "" }; }
    if (cmd === "gh") {
      if (args[1] === "view") return { stdout: state.prs ? "https://github.invalid/pr/1\n" : "" };
      if (state.ghFails) throw new Error("not logged in");
      state.prs++;
      return { stdout: "https://github.invalid/pr/1\n" };
    }
    return runCommand(cmd, args, options);
  };
  const store = Store.open(":memory:");
  const bus = new EventBus();
  const config = Config.parse({ paths: { data: root, lanes: root } });
  const hosts = new HostLinks({ store, bus });
  const app = buildServer({ store, bus, lanes: new LaneManager({ store, bus, config, run }), hosts, config, version: "test", run });
  store.addProject({ id: "shop", name: "Shop", path: repo });
  store.insertLane({ id: "shop/01", n: 1, project: "shop", goal: null, task: "Billing", agent: "codex", model: null, mode: "ask", branch: "lane/01-billing", worktree, terminal: "t", hostUnit: null, base: "main", state: "working", colour: "lc1" });
  const head = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
  const base = (await git(worktree, "merge-base", "main", "HEAD")).stdout.trim();
  store.insertCheckpoint({ id: "c1", lane: "shop/01", base, head, summary: "Adds the feature", checks: [], screenshots: [], files: [], plan: [], unplanned: [], process: [], signal: "strong", decision: null, prUrl: null, createdAt: new Date().toISOString() });
  store.setLaneState("shop/01", "in_review", "checkpoint");
  const cookie = `cl-owner=${store.ownerSession()}`;
  const approve = (headers: Record<string, string> = { cookie }) => app.inject({ method: "POST", url: "/api/lanes/shop/01/approve", headers, payload: {} });
  const onRemote = async (ref: string) => (await git(remote, "rev-parse", ref)).stdout.trim();
  /** Someone else lands work on main, on the remote. */
  const moveMain = async (file: string, text: string) => {
    await writeFile(join(repo, file), text);
    await git(repo, "add", "."); await git(repo, "commit", "-m", "Main moved"); await git(repo, "push", "origin", "main");
  };
  return { git, remote, repo, worktree, store, app, calls, state, approve, onRemote, moveMain, head, cookie };
}

describe("approve and merge", () => {
  it("rebases, pushes the lane branch only, opens a PR and records the decision", async () => {
    const { git, worktree, store, calls, approve, onRemote, moveMain } = await fixture();
    await moveMain("other.txt", "from main\n");
    const main = await onRemote("main");
    const res = await approve();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prUrl: "https://github.invalid/pr/1" });

    expect(await onRemote("main")).toBe(main);
    const pushed = await onRemote("lane/01-billing");
    expect((await git(worktree, "rev-parse", "HEAD")).stdout.trim()).toBe(pushed);
    expect((await git(worktree, "merge-base", "--is-ancestor", main, pushed)).stdout).toBe("");
    expect(calls.find((c) => c[0] === "gh" && c[2] === "create")).toEqual(["gh", "pr", "create", "--base", "main", "--head", "lane/01-billing", "--title", "Billing", "--body", "Adds the feature"]);
    expect(calls.flat().join(" ")).not.toMatch(/--force|--force-with-lease| -f /);
    expect(store.getLane("shop/01")!.state).toBe("merged");
    expect(store.latestCheckpoint("shop/01")).toMatchObject({ decision: "approved", prUrl: "https://github.invalid/pr/1" });
    expect(store.events("shop/01").map((e) => e.type).slice(-2)).toEqual(["checkpoint.decided", "lane.state"]);
    expect(store.inbox()).toEqual([]);
  });

  it("refuses anything but the owner's session", async () => {
    const { approve, store, calls } = await fixture();
    expect((await approve({})).statusCode).toBe(403);
    expect((await approve({ "tailscale-user-login": "x@example.com" })).statusCode).toBe(403);
    expect(calls).toEqual([]);
    expect(store.getLane("shop/01")!.state).toBe("in_review");
  });

  it("stops on a conflict, leaves the lane and main alone and says what to do", async () => {
    const { git, worktree, store, approve, onRemote, moveMain, head } = await fixture();
    await moveMain("feature.txt", "other feature\n");
    const main = await onRemote("main");
    const res = await approve();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/conflicts with main/);
    expect((await git(worktree, "rev-parse", "HEAD")).stdout.trim()).toBe(head);
    expect((await git(worktree, "status", "--porcelain")).stdout).toBe("");
    await expect(git(worktree, "rev-parse", "--verify", "REBASE_HEAD")).rejects.toThrow();
    expect(await onRemote("main")).toBe(main);
    expect(store.getLane("shop/01")!.state).toBe("in_review");
  });

  it("refuses commits the review did not cover, and uncommitted work", async () => {
    const moved = await fixture();
    await writeFile(join(moved.worktree, "late.txt"), "late\n");
    await moved.git(moved.worktree, "add", "."); await moved.git(moved.worktree, "commit", "-m", "Late");
    expect((await moved.approve()).json().error).toMatch(/new commits since this checkpoint/);
    const dirty = await fixture();
    await writeFile(join(dirty.worktree, "app.txt"), "changed\n");
    expect((await dirty.approve()).json().error).toMatch(/uncommitted changes/);
  });

  it("merges instead of rebasing a branch already on the remote, so it never needs a force-push", async () => {
    const { git, worktree, calls, approve, onRemote, moveMain } = await fixture();
    await git(worktree, "push", "origin", "lane/01-billing");
    const first = await onRemote("lane/01-billing");
    await moveMain("other.txt", "from main\n");
    expect((await approve()).statusCode).toBe(200);
    expect(calls.some((c) => c[0] === "git" && c[1] === "rebase")).toBe(false);
    expect((await git(worktree, "merge-base", "--is-ancestor", first, await onRemote("lane/01-billing"))).stdout).toBe("");
  });

  it("finishes the job on a second approve even after the first one rebased onto a moved main", async () => {
    const { store, state, approve, moveMain } = await fixture({ ghFails: true });
    await moveMain("other.txt", "from main\n");
    expect((await approve()).statusCode).toBe(409);
    expect(store.events("shop/01").some((e) => e.type === "checkpoint.updated")).toBe(true);
    state.ghFails = false;
    const res = await approve();
    expect(res.statusCode).toBe(200);
    expect(store.getLane("shop/01")!.state).toBe("merged");
  });

  it("keeps the review open when gh fails, and approving again finishes the job", async () => {
    const { store, state, approve, onRemote } = await fixture({ ghFails: true });
    const res = await approve();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/gh auth login/);
    expect(await onRemote("lane/01-billing")).toBeTruthy();
    expect(store.getLane("shop/01")!.state).toBe("in_review");
    state.ghFails = false;
    expect((await approve()).statusCode).toBe(200);
    expect(store.getLane("shop/01")!.state).toBe("merged");
  });
});

describe("cleanup", () => {
  async function merged() {
    const f = await fixture();
    await f.approve();
    const clean = (headers: Record<string, string> = { cookie: f.cookie }) => f.app.inject({ method: "POST", url: "/api/lanes/shop/01/cleanup", headers, payload: {} });
    return { ...f, clean };
  }
  const exists = (path: string) => access(path).then(() => true, () => false);

  it("stops units, removes the checkout, keeps the branch and kills the tmux session last", async () => {
    const { git, repo, worktree, store, calls, clean, app } = await merged();
    expect((await app.inject({ url: "/api/projects/shop/environments" })).json().cleanup).toMatchObject([{ lane: "shop/01", unpushed: 0 }]);
    calls.length = 0;
    const res = await clean();
    expect(res.statusCode).toBe(200);
    expect(await exists(worktree)).toBe(false);
    expect((await git(repo, "branch", "--list", "lane/01-billing")).stdout).toContain("lane/01-billing");
    expect(store.getLane("shop/01")!.state).toBe("cleaned");
    expect(store.events("shop/01").at(-1)).toMatchObject({ type: "lane.state", payload: { from: "merged", to: "cleaned" } });
    expect(calls).toContainEqual(["systemctl", "--user", "stop", "contextlanes-lane-shop-01"]);
    expect(calls).toContainEqual(["tmux", "kill-session", "-t", "=t"]);
    expect(calls.flat().join(" ")).not.toMatch(/--force|branch -D|branch -d/);
  });

  it("refuses unpushed commits, says so and touches nothing", async () => {
    const { git, worktree, store, calls, clean } = await merged();
    await writeFile(join(worktree, "late.txt"), "late\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-m", "Late");
    calls.length = 0;
    const res = await clean();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/lane\/01-billing has 1 unpushed commit, so this lane was kept/);
    expect(await exists(worktree)).toBe(true);
    expect(store.getLane("shop/01")!.state).toBe("merged");
    expect(calls.filter((c) => c[0] === "tmux" || c[0] === "systemctl")).toEqual([]);
  });

  it("refuses uncommitted files, and ignored files do not block it", async () => {
    const dirty = await merged();
    await writeFile(join(dirty.worktree, "unsaved.txt"), "work\n");
    expect((await dirty.clean()).json().error).toMatch(/uncommitted changes/);
    expect(await exists(join(dirty.worktree, "unsaved.txt"))).toBe(true);

    const ignored = await merged();
    await writeFile(join(ignored.repo, ".git/info/exclude"), ".env*\n");
    await writeFile(join(ignored.worktree, ".env.local"), "SECRET=1\n");
    expect((await ignored.clean()).statusCode).toBe(200);
  });

  it("refuses a lane that is not merged, and anyone but the owner", async () => {
    const open = await fixture();
    const cookie = open.cookie;
    expect((await open.app.inject({ method: "POST", url: "/api/lanes/shop/01/cleanup", headers: { cookie }, payload: {} })).statusCode).toBe(409);
    const { clean, worktree } = await merged();
    expect((await clean({})).statusCode).toBe(403);
    expect(await exists(worktree)).toBe(true);
  });

  it("finishes when the checkout or session has already gone", async () => {
    const { worktree, store, state, clean } = await merged();
    await rm(worktree, { recursive: true });
    state.tmuxGone = true;
    expect((await clean()).statusCode).toBe(200);
    expect(store.getLane("shop/01")!.state).toBe("cleaned");
  });
});

describe("request changes", () => {
  it("sends the note to the same lane as a message and puts the lane back to work", async () => {
    const { app, store, cookie } = await fixture();
    const res = await app.inject({ method: "POST", url: "/api/lanes/shop/01/request-changes", headers: { cookie }, payload: { note: "Rename the table" } });
    expect(res.statusCode).toBe(202);
    expect(store.getLane("shop/01")!.state).toBe("working");
    expect(store.latestCheckpoint("shop/01")!.decision).toBe("changes");
    const events = store.events("shop/01");
    expect(events.find((e) => e.type === "agent.message")).toMatchObject({ payload: { text: "Rename the table", role: "user" } });
    expect(store.pendingCommands("shop/01")).toMatchObject([{ payload: { command: { kind: "prompt", text: "Rename the table" } } }]);
    expect((await app.inject({ method: "POST", url: "/api/lanes/shop/01/request-changes", headers: { cookie }, payload: { note: "Again" } })).statusCode).toBe(409);
  });

  it("refuses an empty note and anyone but the owner", async () => {
    const { app, cookie } = await fixture();
    expect((await app.inject({ method: "POST", url: "/api/lanes/shop/01/request-changes", headers: { cookie }, payload: { note: "  " } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/lanes/shop/01/request-changes", payload: { note: "Sneaky" } })).statusCode).toBe(403);
  });
});

