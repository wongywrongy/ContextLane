import { ALL_FEATURES } from "./features.js";
import { signedIn } from "./signed-in.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { Review } from "../src/review.js";
import { Runtime } from "../src/runtime.js";
import { Sublanes } from "../src/sublanes.js";
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
  const state = { ghFails: opts.ghFails ?? false, prs: 0, tmuxGone: false, prState: "OPEN", mergeCommit: null as string | null, prHead: "", prBase: "main" };
  const run: Runner = async (cmd, args, options) => {
    calls.push([cmd, ...args]);
    if (["tmux", "systemctl", "tailscale"].includes(cmd)) { if (cmd === "tmux" && state.tmuxGone) throw new Error("no session"); return { stdout: "" }; }
    if (cmd === "gh") {
      if (args[1] === "view" && !state.prs) throw new Error("no pull request");
      if (args[1] === "view") return { stdout: args.includes("--jq") ? state.prs ? "https://github.invalid/pr/1\n" : "" : JSON.stringify({ url: "https://github.invalid/pr/1", state: state.prState, headRefOid: state.prHead, baseRefName: state.prBase, mergeCommit: state.mergeCommit ? { oid: state.mergeCommit } : null }) };
      if (state.ghFails) throw new Error("not logged in");
      state.prs++;
      return { stdout: "https://github.invalid/pr/1\n" };
    }
    return runCommand(cmd, args, options);
  };
  const store = Store.open(":memory:");
  const bus = new EventBus();
  const config = Config.parse({ features: ALL_FEATURES, paths: { data: root, lanes: root } });
  const hosts = new HostLinks({ store, bus });
  const app = signedIn(buildServer({ store, bus, lanes: new LaneManager({ store, bus, config, run }), hosts, config, version: "test", run }), store, config);
  store.addProject({ id: "shop", name: "Shop", path: repo });
  store.insertLane({ id: "shop/01", n: 1, project: "shop", goal: null, task: "Billing", agent: "codex", model: null, mode: "ask", branch: "lane/01-billing", worktree, terminal: "t", hostUnit: null, base: "main", state: "working", colour: "lc1" });
  const head = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
  const base = (await git(worktree, "merge-base", "main", "HEAD")).stdout.trim();
  state.prHead = head;
  store.insertCheckpoint({ id: "c1", lane: "shop/01", base, head, recipeHash: null, summary: "Adds the feature", checks: [], screenshots: [], files: [], plan: [], unplanned: [], process: [], signal: "strong", decision: null, prUrl: null, createdAt: new Date().toISOString() });
  store.setLaneState("shop/01", "in_review", "checkpoint");
  const approve = (headers: Record<string, string> = {}) => app.inject({ method: "POST", url: "/api/lanes/shop/01/approve", headers, payload: {} });
  const onRemote = async (ref: string) => (await git(remote, "rev-parse", ref)).stdout.trim();
  /** Someone else lands work on main, on the remote. */
  const moveMain = async (file: string, text: string) => {
    await writeFile(join(repo, file), text);
    await git(repo, "add", "."); await git(repo, "commit", "-m", "Main moved"); await git(repo, "push", "origin", "main");
  };
  const review = new Review({ store, bus, hosts, run, runtime: new Runtime({ store, bus, config, run }), sublanes: new Sublanes({ store, bus, hosts, run, lanes: new LaneManager({ store, bus, config, run }) }) });
  const mergePr = async () => {
    await git(repo, "merge", "--no-ff", "lane/01-billing", "-m", "Merge approved lane");
    await git(repo, "push", "origin", "main");
    state.mergeCommit = await onRemote("main"); state.prState = "MERGED";
    return review.sync("shop/01");
  };
  let serial = 1;
  const checkpoint = (changes: Partial<import("@contextlanes/protocol").Checkpoint> = {}) => {
    const latest = store.latestCheckpoint("shop/01")!;
    store.insertCheckpoint({ ...latest, id: `c${++serial}`, createdAt: new Date(Date.parse(latest.createdAt) + 1000).toISOString(), decision: null, ...changes });
  };
  return { git, remote, repo, worktree, store, app, calls, state, approve, onRemote, moveMain, head, base, review, mergePr, checkpoint };
}

describe("approve and verify merge", () => {
  it("pushes exactly the checked head, opens a PR and waits for an actual merge", async () => {
    const { git, worktree, store, calls, approve, onRemote } = await fixture();
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
    expect(store.getLane("shop/01")!.state).toBe("pr_open");
    expect(store.latestCheckpoint("shop/01")).toMatchObject({ decision: "approved", prUrl: "https://github.invalid/pr/1" });
    expect(store.events("shop/01").map((e) => e.type).slice(-2)).toEqual(["checkpoint.decided", "lane.state"]);
    expect(store.inbox()).toEqual([]);
  });

  it("exposes merge sync only to the owner, never a lane token", async () => {
    const f = await fixture(); await f.approve();
    const url = "/api/lanes/shop/01/review/sync";
    expect((await f.app.inject({ method: "POST", url, payload: {} })).json()).toMatchObject({ state: "pr_open" });
    expect((await f.app.inject({ method: "POST", url, headers: { authorization: "" }, payload: {} })).statusCode).toBe(401);
    expect((await f.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${f.store.mintLaneToken("shop/01")}` }, payload: {} })).statusCode).toBe(401);
  });

  it("refuses anything but the owner's session", async () => {
    const { approve, store, calls } = await fixture();
    expect((await approve({ authorization: "" })).statusCode).toBe(401);
    expect((await approve({ authorization: "", "tailscale-user-login": "x@example.com" })).statusCode).toBe(401);
    expect(calls).toEqual([]);
    expect(store.getLane("shop/01")!.state).toBe("in_review");
  });

  it("refuses a moved base before changing or pushing the approved branch", async () => {
    const { git, worktree, store, approve, onRemote, moveMain, head } = await fixture();
    await moveMain("feature.txt", "other feature\n");
    const main = await onRemote("main");
    const res = await approve();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/main changed since these checks/);
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

  it("refuses a moved base even when the lane branch is already published", async () => {
    const { git, worktree, calls, approve, onRemote, moveMain, head } = await fixture();
    await git(worktree, "push", "origin", "lane/01-billing");
    await moveMain("other.txt", "from main\n");
    expect((await approve()).statusCode).toBe(409);
    expect(await onRemote("lane/01-billing")).toBe(head);
    expect(calls.some(c => c[0] === "git" && ["rebase", "merge"].includes(c[1]!))).toBe(false);
  });

  it("never bypasses fresh evidence with a legacy checkpoint.updated event", async () => {
    const f = await fixture();
    await writeFile(join(f.worktree, "late.txt"), "unreviewed\n");
    await f.git(f.worktree, "add", "."); await f.git(f.worktree, "commit", "-m", "Late");
    const after = (await f.git(f.worktree, "rev-parse", "HEAD")).stdout.trim();
    f.store.appendEvent("shop/01", { type: "checkpoint.updated", payload: { checkpointId: "c1", head: after } });
    expect((await f.approve()).json().error).toMatch(/new commits since this checkpoint/);
  });

  it("rejects legacy checkpoints, failed checks, missing required checks and changed recipes", async () => {
    const legacy = await fixture(); legacy.checkpoint({ recipeHash: undefined });
    expect((await legacy.approve()).json().error).toMatch(/predates verified/);
    const f = await fixture();
    const recipe = JSON.stringify({ checks: [{ name: "Unit tests", command: ["node", "test.mjs"] }] });
    await writeFile(join(f.worktree, ".contextlanes.json"), recipe);
    await f.git(f.worktree, "add", "."); await f.git(f.worktree, "commit", "-m", "Recipe");
    const head = (await f.git(f.worktree, "rev-parse", "HEAD")).stdout.trim();
    const recipeHash = createHash("sha256").update(recipe).digest("hex");
    f.store.approveRecipe("shop", recipeHash);
    f.checkpoint({ head, recipeHash, checks: [] });
    expect((await f.approve()).json().error).toMatch(/missing required check/);
    f.checkpoint({ checks: [{ name: "Unit tests", passed: false, ms: 10, detail: "Failure" }] });
    expect((await f.approve()).json().error).toMatch(/Required checks failed/);
    f.checkpoint({ recipeHash: "0".repeat(64), checks: [{ name: "Unit tests", passed: true, ms: 10, detail: "Passed" }] });
    expect((await f.approve()).json().error).toMatch(/recipe changed/);
    expect(f.calls.some(c => c[0] === "git" && c[1] === "push")).toBe(false);
  });

  it("requires GitHub's merged head and merge commit to match before enabling cleanup", async () => {
    const f = await fixture(); await f.approve();
    expect(await f.review.sync("shop/01")).toMatchObject({ state: "pr_open" });
    await expect(f.review.cleanup("shop/01")).rejects.toThrow(/Only a merged lane/);
    f.state.prState = "MERGED"; f.state.mergeCommit = f.head;
    await expect(f.review.sync("shop/01")).rejects.toThrow(/not on the remote base/);
    f.state.prHead = "0".repeat(40);
    await expect(f.review.sync("shop/01")).rejects.toThrow(/different head or base/);
    f.state.prHead = f.head;
    expect(await f.mergePr()).toMatchObject({ state: "merged" });
    expect(f.store.eventsOfType(["checkpoint.merge_verified"])).toHaveLength(1);
    expect(f.calls.some(c => c[0] === "gh" && c[1] === "pr" && c[2] === "merge")).toBe(false);
  });

  it("corrects legacy merged rows whose PR is still open and refuses cleanup", async () => {
    const f = await fixture(); await f.approve(); f.store.setLaneState("shop/01", "merged");
    await expect(f.review.cleanup("shop/01")).rejects.toThrow(/not been merged/);
    expect(f.store.getLane("shop/01")!.state).toBe("pr_open");
    expect(await access(f.worktree).then(() => true, () => false)).toBe(true);
  });

  it("returns a closed unmerged PR to work without reporting a merge", async () => {
    const f = await fixture(); await f.approve(); f.state.prState = "CLOSED";
    expect(await f.review.sync("shop/01")).toMatchObject({ state: "working" });
    expect(f.store.latestCheckpoint("shop/01")!.decision).toBe("changes");
    expect(f.store.eventsOfType(["checkpoint.merge_verified"])).toHaveLength(0);
  });

  it("waits for a child commit to actually reach the parent, and integrates only its approved SHA", async () => {
    const f = await fixture();
    f.store.insertLane({ ...f.store.getLane("shop/01")!, id: "shop/02", n: 2, task: "Parent", branch: "main", worktree: f.repo, state: "working" });
    f.store.appendEvent("shop/01", { type: "lane.child", payload: { parent: "shop/02", requestId: "6e0c8a8e-8a1c-4a4b-9d7f-0f2b4a6b1c12", part: 0, title: "Child" } });
    // Approve through the real Review instance, which knows the parent link.
    await f.review.approve("shop/01");
    expect(f.store.getLane("shop/01")!.state).toBe("integration_pending");
    const command = f.store.pendingCommands("shop/02")[0]!.payload.command;
    expect(command).toMatchObject({ kind: "prompt", text: expect.stringContaining(`git merge --no-ff ${f.head}`) });
    expect(await f.review.sync("shop/01")).toMatchObject({ state: "integration_pending" });
    await writeFile(join(f.worktree, "later.txt"), "unapproved later work\n");
    await f.git(f.worktree, "add", "."); await f.git(f.worktree, "commit", "-m", "Not approved");
    await f.git(f.repo, "merge", "--no-ff", f.head, "-m", "Integrate approved SHA");
    expect(await f.review.sync("shop/01")).toMatchObject({ state: "merged" });
    expect(await access(join(f.repo, "later.txt")).then(() => true, () => false)).toBe(false);
    expect(f.calls.some(c => c[0] === "gh" || c[0] === "git" && c[1] === "push")).toBe(false);
  });

  it("reopens the parent's pending review before asking it to integrate an approved child", async () => {
    const f = await fixture();
    f.store.insertLane({ ...f.store.getLane("shop/01")!, id: "shop/02", n: 2, task: "Parent", branch: "main", worktree: f.repo, state: "in_review" });
    f.store.insertCheckpoint({ ...f.store.latestCheckpoint("shop/01")!, id: "parent-checkpoint", lane: "shop/02", head: f.base });
    f.store.appendEvent("shop/01", { type: "lane.child", payload: { parent: "shop/02", requestId: "6e0c8a8e-8a1c-4a4b-9d7f-0f2b4a6b1c12", part: 0, title: "Child" } });
    await f.review.approve("shop/01");
    expect(f.store.getLane("shop/02")!.state).toBe("working");
    expect(f.store.latestCheckpoint("shop/02")!.decision).toBe("changes");
    const events = f.store.events("shop/02");
    expect(events.find(e => e.type === "checkpoint.decided")).toMatchObject({ payload: { checkpointId: "parent-checkpoint", decision: "changes", note: expect.stringContaining("approved child shop/01") } });
    expect(events.find(e => e.type === "lane.state")!.seq).toBeLessThan(events.find(e => e.type === "agent.command")!.seq);
    expect(f.store.pendingCommands("shop/02")[0]!.payload.command).toMatchObject({ kind: "prompt", text: expect.stringContaining(f.head) });
    await expect(f.review.approve("shop/02")).rejects.toThrow(/no checkpoint waiting/);
  });

  it("requires a named pull-request target for pinned commit and tag bases", async () => {
    const f = await fixture();
    await f.git(f.repo, "tag", "v1", f.base);
    for (const base of [f.base, "refs/tags/v1", "v1"]) {
      f.store.db.prepare("UPDATE lane SET base = ? WHERE id = ?").run(base, "shop/01");
      await expect(f.review.approve("shop/01")).rejects.toThrow(/named target branch/);
    }
    expect(f.store.getLane("shop/01")!.state).toBe("in_review");
    expect(f.calls.some(c => c[0] === "gh" || c[0] === "git" && c[1] === "push")).toBe(false);
  });

  it("lets the owner return an open PR to work for a fresh checkpoint", async () => {
    const f = await fixture(); await f.approve();
    f.review.requestChanges("shop/01", "Address the review feedback");
    expect(f.store.getLane("shop/01")!.state).toBe("working");
    expect(f.store.latestCheckpoint("shop/01")!.decision).toBe("changes");
    expect(f.store.pendingCommands("shop/01")[0]!.payload.command).toMatchObject({ kind: "prompt", text: "Address the review feedback" });
    expect(f.state.prState).toBe("OPEN");
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
    expect(store.getLane("shop/01")!.state).toBe("pr_open");
  });
});

describe("cleanup", () => {
  async function merged() {
    const f = await fixture();
    await f.approve();
    await f.mergePr();
    const clean = (headers: Record<string, string> = {}) => f.app.inject({ method: "POST", url: "/api/lanes/shop/01/cleanup", headers, payload: {} });
    return { ...f, clean };
  }
  const exists = (path: string) => access(path).then(() => true, () => false);

  it("cleans verified squash merges after the remote lane branch was deleted", async () => {
    const f = await fixture(); await f.approve();
    await f.git(f.repo, "merge", "--squash", "lane/01-billing");
    await f.git(f.repo, "commit", "-m", "Squashed lane"); await f.git(f.repo, "push", "origin", "main");
    await f.git(f.repo, "push", "origin", "--delete", "lane/01-billing"); await f.git(f.repo, "fetch", "--prune", "origin");
    f.state.prState = "MERGED"; f.state.mergeCommit = await f.onRemote("main");
    expect(await f.review.sync("shop/01")).toMatchObject({ state: "merged" });
    await expect(f.git(f.repo, "merge-base", "--is-ancestor", f.head, "origin/main")).rejects.toThrow();
    expect(await f.review.cleanup("shop/01")).toEqual({ cleaned: true });
    expect(await exists(f.worktree)).toBe(false);
  });

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
    expect((await open.app.inject({ method: "POST", url: "/api/lanes/shop/01/cleanup", payload: {} })).statusCode).toBe(409);
    const { clean, worktree } = await merged();
    expect((await clean({ authorization: "" })).statusCode).toBe(401);
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
  it("records three comments and delivers one combined message to the fake agent queue", async () => {
    const { app, store } = await fixture();
    const comments = [1, 2, 3].map(line => ({ file: "feature.txt", line, side: "new", quote: `line ${line}`, text: `Change ${line}` }));
    const res = await app.inject({ method: "POST", url: "/api/lanes/shop/01/request-changes", payload: { comments } });
    expect(res.statusCode).toBe(202);
    expect(store.eventsOfType(["review.requested"])[0]?.payload.comments).toEqual(comments);
    const commands = store.pendingCommands("shop/01");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.payload.command).toMatchObject({ kind: "prompt", text: "feature.txt:1\n> line 1\nChange 1\n\nfeature.txt:2\n> line 2\nChange 2\n\nfeature.txt:3\n> line 3\nChange 3" });
  });
  it("accepts Work comments without a checkpoint and rejects oversized combined requests before mutation", async () => {
    const { app, store } = await fixture();
    const comment = { file: "feature.txt", line: 1, side: "old", quote: "before", text: "fix" };
    const large = await app.inject({ method: "POST", url: "/api/lanes/shop/01/request-changes", payload: { comments: Array.from({ length: 50 }, () => ({ ...comment, quote: "x".repeat(4000), text: "y".repeat(2000) })) } });
    expect(large.statusCode).toBe(400);
    expect(store.getLane("shop/01")?.state).toBe("in_review");
    store.setLaneState("shop/01", "working");
    expect((await app.inject({ method: "POST", url: "/api/lanes/shop/01/request-changes", payload: { comments: [comment] } })).statusCode).toBe(202);
    expect(store.pendingCommands("shop/01")[0]?.payload.command).toMatchObject({ text: expect.stringContaining("feature.txt:1 (before)") });
  });
  it("sends the note to the same lane as a message and puts the lane back to work", async () => {
    const { app, store } = await fixture();
    const res = await app.inject({ method: "POST", url: "/api/lanes/shop/01/request-changes", payload: { note: "Rename the table" } });
    expect(res.statusCode).toBe(202);
    expect(store.getLane("shop/01")!.state).toBe("working");
    expect(store.latestCheckpoint("shop/01")!.decision).toBe("changes");
    const events = store.events("shop/01");
    expect(events.find((e) => e.type === "agent.message")).toMatchObject({ payload: { text: "Rename the table", role: "user" } });
    expect(store.pendingCommands("shop/01")).toMatchObject([{ payload: { command: { kind: "prompt", text: "Rename the table" } } }]);
    expect((await app.inject({ method: "POST", url: "/api/lanes/shop/01/request-changes", payload: { note: "Again" } })).statusCode).toBe(409);
  });

  it("refuses an empty note and anyone but the owner", async () => {
    const { app } = await fixture();
    expect((await app.inject({ method: "POST", url: "/api/lanes/shop/01/request-changes", payload: { note: "  " } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/lanes/shop/01/request-changes", headers: { authorization: "" }, payload: { note: "Sneaky" } })).statusCode).toBe(401);
  });
});

