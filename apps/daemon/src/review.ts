import { access } from "node:fs/promises";
import { z } from "zod";
import { laneRecipe } from "./recipes.js";
import { reviewMessage, type ReviewComment, type Checkpoint, type Lane, type ProjectId } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Store } from "./db/store.js";
import type { HostLinks } from "./hosts.js";
import { NotFound, Refused } from "./lanes/manager.js";
import { hostUnit } from "./lanes/naming.js";
import type { Runner } from "./run.js";
import type { Runtime } from "./runtime.js";
import { Terminals } from "./terminal/tmux.js";
import type { Sublanes } from "./sublanes.js";

type Deps = { store: Store; bus: EventBus; hosts: HostLinks; run: Runner; runtime: Runtime; sublanes?: Sublanes };

/** The owner's decision on a checkpoint. Nothing here force-pushes or writes to the base branch. */
export class Review {
  private readonly busy = new Set<string>();

  constructor(private readonly deps: Deps) {}

  private pending(id: string): { lane: Lane; checkpoint: Checkpoint } {
    const lane = this.deps.store.getLane(id);
    if (!lane) throw new NotFound(`no lane ${id}`);
    const checkpoint = this.deps.store.latestCheckpoint(id);
    if (lane.state !== "in_review" || !checkpoint || checkpoint.decision) throw new Refused("This lane has no checkpoint waiting for a decision.");
    return { lane, checkpoint };
  }

  /** True while approve or clean up is working on the lane, so delete and request changes wait. */
  working(id: string): boolean { return this.busy.has(id); }

  private git(lane: Lane, ...args: string[]) {
    return this.deps.run("git", args, { cwd: lane.worktree, timeout: 120_000 });
  }

  /** Publish exactly the checked commit. Updating the base belongs before checkpoint checks, never here. */
  async approve(id: string): Promise<{ prUrl: string | null }> {
    const { lane, checkpoint } = this.pending(id);
    if (this.busy.has(id)) throw new Refused("This lane's review is already being updated.");
    this.busy.add(id);
    try {
      await this.validateEvidence(lane, checkpoint);
      const parent = this.deps.sublanes?.openParent(lane);
      if (parent) {
        const parentHead = (await this.git(parent, "rev-parse", "HEAD")).stdout.trim();
        if (parentHead !== checkpoint.base) throw new Refused("The parent lane changed since these checks. Request changes and ask for a new checkpoint against its latest commit.");
        for (const event of this.deps.sublanes!.approveIntoParent(lane, parent, checkpoint.id)) this.deps.bus.publish(event);
        return { prUrl: null };
      }
      const base = lane.base ?? "main";
      const pinned = "This lane starts from a pinned commit or tag. A pull request needs a named target branch; start a lane against that branch and create a new checkpoint.";
      if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(base) || base.startsWith("refs/tags/")) throw new Refused(pinned);
      if (lane.branch === base) throw new Refused(`This lane is on ${base} itself, so there is nothing to merge.`);
      await this.fetchBase(lane, base).catch(async (err: unknown) => {
        const tag = await this.git(lane, "rev-parse", "--verify", `refs/tags/${base}`).then(r => !!r.stdout.trim(), () => false);
        if (tag) throw new Refused(pinned);
        throw err;
      });
      const baseHead = (await this.git(lane, "rev-parse", `origin/${base}`)).stdout.trim();
      if (baseHead !== checkpoint.base) throw new Refused(`${base} changed since these checks. Request changes and ask for a new checkpoint against its latest commit.`);
      // A fixed SHA, rather than HEAD, prevents an agent's concurrent commit entering this approved push.
      await this.git(lane, "push", "--set-upstream", "origin", `${checkpoint.head}:refs/heads/${lane.branch}`).catch(() => { throw new Refused(`git push of ${lane.branch} was refused. Nothing was forced; check the remote and try again.`); });
      const prUrl = await this.openPullRequest(lane, base, checkpoint.summary, checkpoint.head);
      const { store, bus } = this.deps;
      const events = store.tx(() => {
        store.decideCheckpoint(checkpoint.id, "approved", prUrl);
        return [store.appendEvent(id, { type: "checkpoint.decided", payload: { checkpointId: checkpoint.id, decision: "approved", prUrl } }), store.setLaneState(id, "pr_open", "Pull request opened; merge on GitHub when ready")];
      });
      for (const event of events) bus.publish(event);
      return { prUrl };
    } finally { this.busy.delete(id); }
  }

  private async validateEvidence(lane: Lane, checkpoint: Checkpoint): Promise<void> {
    if (checkpoint.recipeHash === undefined) throw new Refused("This checkpoint predates verified recipe checks. Request changes and create a new checkpoint.");
    if ((await this.git(lane, "rev-parse", "HEAD")).stdout.trim() !== checkpoint.head) throw new Refused("The lane has new commits since this checkpoint. Ask for a new checkpoint so review covers them.");
    if ((await this.git(lane, "status", "--porcelain")).stdout.trim()) throw new Refused("The lane has uncommitted changes. Ask the agent to commit or discard them first.");
    const view = await laneRecipe(this.deps.store, this.deps.store.getProject(lane.project)!, lane);
    if ((view?.hash ?? null) !== checkpoint.recipeHash || view && (!view.approved || !view.recipe)) throw new Refused("The approved recipe changed since this checkpoint. Approve the current recipe and create a new checkpoint.");
    const required = view?.recipe?.checks ?? [];
    if (required.length !== checkpoint.checks.length || required.some((check, index) => check.name !== checkpoint.checks[index]?.name)) throw new Refused("This checkpoint is missing required check results. Create a new checkpoint before approving.");
    if (checkpoint.checks.some((check) => !check.passed)) throw new Refused("Required checks failed. Request changes and create a passing checkpoint before approving.");
  }

  private async fetchBase(lane: Lane, base: string): Promise<void> {
    await this.git(lane, "fetch", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`)
      .catch(() => { throw new Refused(`${base} could not be fetched from origin. Check that the branch exists there, then try again.`); });
  }

  /** Read-only external observation. No pull request is merged by this action. */
  async sync(id: string): Promise<{ state: Lane["state"]; prUrl: string | null }> {
    if (this.busy.has(id)) throw new Refused("This lane's review is already being updated.");
    this.busy.add(id);
    try { return await this.reconcile(id); } finally { this.busy.delete(id); }
  }

  /** Poll open decisions and legacy merged rows once; verified history needs no repeated GitHub calls. */
  async refresh(): Promise<void> {
    for (const lane of this.deps.store.listLanes()) {
      if (!["pr_open", "integration_pending", "merged"].includes(lane.state)) continue;
      if (lane.state === "merged" && this.deps.store.eventsOfType(["checkpoint.merge_verified"], { lanes: [lane.id] }).length) continue;
      if (this.busy.has(lane.id)) continue;
      await this.sync(lane.id).catch((err: unknown) => console.error(`Could not verify merge for ${lane.id}:`, err instanceof Error ? err.message : err));
    }
  }

  private async reconcile(id: string): Promise<{ state: Lane["state"]; prUrl: string | null }> {
    const { store, bus } = this.deps;
    const lane = store.getLane(id);
    if (!lane) throw new NotFound(`no lane ${id}`);
    if (!["pr_open", "integration_pending", "merged"].includes(lane.state)) throw new Refused("This lane has no approved change waiting for integration.");
    const checkpoint = store.latestCheckpoint(id);
    if (!checkpoint || checkpoint.decision !== "approved") throw new Refused("No approved checkpoint can be verified for this lane.");
    const state = (next: Lane["state"], note: string) => { if (store.getLane(id)!.state !== next) bus.publish(store.setLaneState(id, next, note)); };
    // Older releases used "merged" for approval alone. Correct that label before any network check.
    if (lane.state === "merged" && !store.eventsOfType(["checkpoint.merge_verified"], { lanes: [id] }).some(e => e.payload.checkpointId === checkpoint.id)) state(checkpoint.prUrl ? "pr_open" : "integration_pending", "Integration has not been verified yet");
    let mergeCommit: string;
    let target: string;
    if (!checkpoint.prUrl) {
      const parent = this.deps.sublanes?.parentOf(lane);
      if (!parent) throw new Refused("The parent lane for this approved change could not be found.");
      const repo = store.getProject(lane.project)!.path;
      const integrated = await this.deps.run("git", ["merge-base", "--is-ancestor", checkpoint.head, parent.branch], { cwd: repo }).then(() => true, () => false);
      if (!integrated) {
        state("integration_pending", "Approved commit has not reached the parent branch");
        return { state: "integration_pending", prUrl: null };
      }
      mergeCommit = (await this.deps.run("git", ["rev-parse", parent.branch], { cwd: repo })).stdout.trim();
      target = parent.id;
    } else {
      const result = await this.deps.run("gh", ["pr", "view", checkpoint.prUrl, "--json", "url,state,headRefOid,baseRefName,mergeCommit"], { cwd: store.getProject(lane.project)!.path, timeout: 60_000 });
      const pr = z.object({ url: z.string().url(), state: z.enum(["OPEN", "CLOSED", "MERGED"]), headRefOid: z.string(), baseRefName: z.string(), mergeCommit: z.object({ oid: z.string().min(1) }).nullable() }).parse(JSON.parse(result.stdout));
      if (pr.state === "CLOSED") {
        const events = store.tx(() => {
          store.decideCheckpoint(checkpoint.id, "changes", checkpoint.prUrl!);
          return [store.appendEvent(id, { type: "checkpoint.decided", payload: { checkpointId: checkpoint.id, decision: "changes", note: "Pull request closed without merging", prUrl: checkpoint.prUrl! } }), store.setLaneState(id, "working", "Pull request closed without merging; create a new checkpoint when ready")];
        });
        for (const event of events) bus.publish(event);
        return { state: "working", prUrl: checkpoint.prUrl };
      }
      if (pr.state !== "MERGED") {
        state("pr_open", "Pull request is still open on GitHub");
        return { state: "pr_open", prUrl: checkpoint.prUrl };
      }
      if (pr.headRefOid !== checkpoint.head || pr.baseRefName !== (lane.base ?? "main")) throw new Refused("GitHub merged a different head or base than this checkpoint. Keep this checkout and review the pull request before cleanup.");
      if (!pr.mergeCommit) throw new Refused("GitHub has not reported the merge commit yet. Try syncing again.");
      // Use the main checkout: a legacy merged lane's worktree may already be gone.
      const repoLane = { ...lane, worktree: store.getProject(lane.project)!.path };
      await this.fetchBase(repoLane, pr.baseRefName);
      const landed = await this.git(repoLane, "merge-base", "--is-ancestor", pr.mergeCommit.oid, `origin/${pr.baseRefName}`).then(() => true, () => false);
      if (!landed) throw new Refused("The reported merge commit is not on the remote base branch. Keep this checkout and check GitHub.");
      mergeCommit = pr.mergeCommit.oid;
      target = pr.url;
    }
    const previous = store.eventsOfType(["checkpoint.merge_verified"], { lanes: [id] }).findLast(e => e.payload.checkpointId === checkpoint.id);
    if (!previous || previous.payload.head !== checkpoint.head) bus.publish(store.appendEvent(id, { type: "checkpoint.merge_verified", payload: { checkpointId: checkpoint.id, head: checkpoint.head, target, mergeCommit } }));
    state("merged", `Integration verified at ${mergeCommit.slice(0, 8)}`);
    return { state: "merged", prUrl: checkpoint.prUrl };
  }

  private async openPullRequest(lane: Lane, base: string, summary: string, head: string): Promise<string> {
    const { run } = this.deps;
    const options = { cwd: lane.worktree, timeout: 60_000 };
    const schema = z.object({ url: z.string().url(), state: z.enum(["OPEN", "CLOSED", "MERGED"]), headRefOid: z.string(), baseRefName: z.string() });
    const inspect = async (ref: string) => schema.parse(JSON.parse((await run("gh", ["pr", "view", ref, "--json", "url,state,headRefOid,baseRefName"], options)).stdout));
    const validate = (pr: z.infer<typeof schema>) => {
      if (pr.state !== "OPEN" || pr.headRefOid !== head || pr.baseRefName !== base) throw new Refused("The pull request does not point to the checked head and base. Review it on GitHub before trying approval again.");
      return pr.url;
    };
    const existing = await inspect(lane.branch).catch(() => null);
    if (existing?.state === "OPEN") return validate(existing);
    const created = await run("gh", ["pr", "create", "--base", base, "--head", lane.branch, "--title", lane.task, "--body", summary], options).catch(() => { throw new Refused("The branch is pushed, but gh could not open the pull request. Run gh auth login on this machine, then approve again."); });
    const url = z.string().url().parse(created.stdout.trim().split("\n").at(-1));
    return validate(await inspect(url));
  }

  private async unpushed(lane: Lane, repo: string): Promise<number> {
    const checkpoint = this.deps.store.latestCheckpoint(lane.id);
    const verified = checkpoint?.decision === "approved" && this.deps.store.eventsOfType(["checkpoint.merge_verified"], { lanes: [lane.id] }).some(e => e.payload.checkpointId === checkpoint.id && e.payload.head === checkpoint.head);
    // GitHub squash/rebase merges need not retain the lane commit as an ancestor of origin/base.
    // Exempt only the exact verified checkpoint; later local work must still be pushed before cleanup.
    return Number((await this.deps.run("git", ["rev-list", "--count", lane.branch, "--not", "--remotes=origin", ...(verified ? [checkpoint.head] : [])], { cwd: repo })).stdout.trim());
  }

  /** What Clean up would do for each merged lane, for the Run page. A lane git cannot read counts as unsafe. */
  /** unpushed is null when git could not count, so the page says "could not be checked" instead of a made-up number. */
  async cleanable(project: ProjectId): Promise<{ lane: string; unpushed: number | null; disk: number | null }[]> {
    const { store } = this.deps;
    const repo = store.getProject(project)!.path;
    return Promise.all(store.listLanes(project).filter((l) => l.state === "merged" && store.eventsOfType(["checkpoint.merge_verified"], { lanes: [l.id] }).length > 0).map(async (lane) => ({ lane: lane.id, unpushed: await this.unpushed(lane, repo).catch(() => null), disk: store.environment(lane.id)?.setup?.disk ?? null })));
  }

  /** Stop the lane's units and remove its checkout; branches stay. Refuses before touching anything if work would be lost. */
  async cleanup(id: string): Promise<{ cleaned: true }> {
    const { store, bus, run, runtime } = this.deps;
    const lane = store.getLane(id);
    if (!lane) throw new NotFound(`no lane ${id}`);
    if (lane.state !== "merged") throw new Refused("Only a merged lane can be cleaned up.");
    if (this.busy.has(id)) throw new Refused("This lane is already being cleaned up.");
    this.busy.add(id);
    try {
      const verified = await this.reconcile(id);
      if (verified.state !== "merged") throw new Refused("This change has not been merged yet, so its checkout was kept.");
      const repo = store.getProject(lane.project)!.path;
      const unpushed = await this.unpushed(lane, repo);
      if (unpushed) throw new Refused(`${lane.branch} has ${unpushed} unpushed ${unpushed === 1 ? "commit" : "commits"}, so this lane was kept. Push them, then clean up again.`);
      const present = await access(lane.worktree).then(() => true, () => false);
      if (present && (await this.git(lane, "status", "--porcelain")).stdout.trim()) throw new Refused(`${lane.worktree} has uncommitted changes, so this lane was kept. Commit and push them, or remove them yourself.`);
      await runtime.stop(id);
      await runtime.teardown(id);
      if (!lane.direct) await runtime.dropDatabase(lane);
      await run("systemctl", ["--user", "stop", lane.hostUnit ?? hostUnit(id)]).catch(() => {});
      // Never --force: git itself refuses if anything unsaved appeared since the check above.
      if (present && !lane.direct) await run("git", ["worktree", "remove", lane.worktree], { cwd: repo });
      await new Terminals(run).kill(lane.terminal);
      bus.publish(store.setLaneState(id, "cleaned", lane.direct ? "Direct lane stopped; checkout and branch kept" : "units stopped, checkout removed, branch kept"));
      return { cleaned: true };
    } finally { this.busy.delete(id); }
  }

  /** The note goes to the same agent as a normal message, and the lane goes back to work. */
  requestChanges(id: string, note: string, comments: ReviewComment[] = []): { delivered: boolean } {
    const { store, bus, hosts } = this.deps;
    const lane = store.getLane(id);
    if (!lane) throw new NotFound(`no lane ${id}`);
    const checkpoint = lane.state === "in_review" ? this.pending(id).checkpoint : lane.state === "pr_open" ? store.latestCheckpoint(id) : null;
    if (!checkpoint && (!comments.length || !["working", "needs_you"].includes(lane.state))) throw new Refused("This lane has no checkpoint waiting for a decision.");
    if (this.busy.has(id)) throw new Refused("This lane is being merged right now. Wait for approve to finish or fail, then request changes.");
    const text = reviewMessage(note, comments);
    const events = store.tx(() => {
      const result = [store.appendEvent(id, { type: "review.requested", payload: { ...(checkpoint ? { checkpointId: checkpoint.id } : {}), note, comments } })];
      if (checkpoint) {
        store.decideCheckpoint(checkpoint.id, "changes");
        result.push(store.appendEvent(id, { type: "checkpoint.decided", payload: { checkpointId: checkpoint.id, decision: "changes", note: text } }), store.setLaneState(id, "working", "changes requested"));
      }
      result.push(store.appendEvent(id, { type: "agent.message", payload: { text, role: "user" } }));
      return result;
    });
    for (const event of events) bus.publish(event);
    return { delivered: hosts.command(id, { kind: "prompt", text, immediate: false, files: [], images: [] }).delivered };
  }
}
