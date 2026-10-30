import { access } from "node:fs/promises";
import type { Checkpoint, Lane, ProjectId } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Store } from "./db/store.js";
import type { HostLinks } from "./hosts.js";
import { NotFound, Refused } from "./lanes/manager.js";
import { hostUnit } from "./lanes/naming.js";
import type { Runner } from "./run.js";
import type { Runtime } from "./runtime.js";
import { Terminals } from "./terminal/tmux.js";

type Deps = { store: Store; bus: EventBus; hosts: HostLinks; run: Runner; runtime: Runtime };

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

  private git(lane: Lane, ...args: string[]) {
    return this.deps.run("git", args, { cwd: lane.worktree, timeout: 120_000 });
  }

  /** Rebase, push, open a PR. Each step can run again, so a failure part way is fixed by trying again. */
  async approve(id: string): Promise<{ prUrl: string }> {
    const { lane, checkpoint } = this.pending(id);
    if (this.busy.has(id)) throw new Refused("This lane is already being merged.");
    this.busy.add(id);
    try {
      const base = lane.base ?? "main";
      if (lane.branch === base) throw new Refused(`This lane is on ${base} itself, so there is nothing to merge.`);
      // A retry after a failed push or gh starts from the head the earlier attempt rebased to.
      const updated = this.deps.store.events(id).findLast((e) => e.type === "checkpoint.updated" && e.payload.checkpointId === checkpoint.id);
      const head = (await this.git(lane, "rev-parse", "HEAD")).stdout.trim();
      const resumed = updated?.type === "checkpoint.updated" && updated.payload.head === head;
      if (head !== checkpoint.head && !resumed) throw new Refused("The lane has new commits since this checkpoint. Ask for a new checkpoint so review covers them.");
      if ((await this.git(lane, "status", "--porcelain")).stdout.trim()) throw new Refused("The lane has uncommitted changes. Ask the agent to commit or discard them first.");
      await this.git(lane, "remote", "get-url", "origin").catch(() => { throw new Refused("This repository has no origin remote to push to."); });
      if (!resumed) {
        await this.git(lane, "fetch", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`)
          .catch(() => { throw new Refused(`${base} could not be fetched from origin. Check that the branch exists there, then approve again.`); });
        await this.update(lane, base);
        const after = (await this.git(lane, "rev-parse", "HEAD")).stdout.trim();
        if (after !== checkpoint.head) this.deps.bus.publish(this.deps.store.appendEvent(id, { type: "checkpoint.updated", payload: { checkpointId: checkpoint.id, head: after } }));
      }
      await this.git(lane, "push", "--set-upstream", "origin", `HEAD:refs/heads/${lane.branch}`).catch(() => { throw new Refused(`git push of ${lane.branch} was refused. Nothing was forced; check the remote and try again.`); });
      const prUrl = await this.openPullRequest(lane, base, checkpoint.summary);
      const { store, bus } = this.deps;
      const events = store.tx(() => {
        store.decideCheckpoint(checkpoint.id, "approved", prUrl);
        return [store.appendEvent(id, { type: "checkpoint.decided", payload: { checkpointId: checkpoint.id, decision: "approved", prUrl } }), store.setLaneState(id, "merged", prUrl)];
      });
      for (const event of events) bus.publish(event);
      return { prUrl };
    } finally { this.busy.delete(id); }
  }

  /** A branch already on the remote is merged instead of rebased, because rebasing it would need a force-push. */
  private async update(lane: Lane, base: string): Promise<void> {
    const published = (await this.git(lane, "ls-remote", "--heads", "origin", `refs/heads/${lane.branch}`)).stdout.trim();
    const verb = published ? "merge" : "rebase";
    await this.git(lane, ...(published ? ["merge", "--no-edit", `origin/${base}`] : ["rebase", `origin/${base}`])).catch(async () => {
      await this.git(lane, verb, "--abort").catch(() => {});
      throw new Refused(`This lane conflicts with ${base}. Request changes so the agent can resolve it; the lane was left as it was.`);
    });
  }

  private async openPullRequest(lane: Lane, base: string, summary: string): Promise<string> {
    const { run } = this.deps;
    const options = { cwd: lane.worktree, timeout: 60_000 };
    const existing = await run("gh", ["pr", "view", lane.branch, "--json", "url,state", "--jq", "select(.state == \"OPEN\") | .url"], options).then((r) => r.stdout.trim(), () => "");
    if (existing) return existing;
    const created = await run("gh", ["pr", "create", "--base", base, "--head", lane.branch, "--title", lane.task, "--body", summary], options).catch(() => { throw new Refused("The branch is pushed, but gh could not open the pull request. Run gh auth login on this machine, then approve again."); });
    return created.stdout.trim().split("\n").at(-1)!;
  }

  private async unpushed(lane: Lane, repo: string): Promise<number> {
    return Number((await this.deps.run("git", ["rev-list", "--count", lane.branch, "--not", "--remotes=origin"], { cwd: repo })).stdout.trim());
  }

  /** What Clean up would do for each merged lane, for the Run page. A lane git cannot read counts as unsafe. */
  /** unpushed is null when git could not count, so the page says "could not be checked" instead of a made-up number. */
  async cleanable(project: ProjectId): Promise<{ lane: string; unpushed: number | null; disk: number | null }[]> {
    const { store } = this.deps;
    const repo = store.getProject(project)!.path;
    return Promise.all(store.listLanes(project).filter((l) => l.state === "merged").map(async (lane) => ({ lane: lane.id, unpushed: await this.unpushed(lane, repo).catch(() => null), disk: store.environment(lane.id)?.setup?.disk ?? null })));
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
      const repo = store.getProject(lane.project)!.path;
      const unpushed = await this.unpushed(lane, repo);
      if (unpushed) throw new Refused(`${lane.branch} has ${unpushed} unpushed ${unpushed === 1 ? "commit" : "commits"}, so this lane was kept. Push them, then clean up again.`);
      const present = await access(lane.worktree).then(() => true, () => false);
      if (present && (await this.git(lane, "status", "--porcelain")).stdout.trim()) throw new Refused(`${lane.worktree} has uncommitted changes, so this lane was kept. Commit and push them, or remove them yourself.`);
      await runtime.stop(id);
      await runtime.dropDatabase(lane);
      await run("systemctl", ["--user", "stop", lane.hostUnit ?? hostUnit(id)]).catch(() => {});
      // Never --force: git itself refuses if anything unsaved appeared since the check above.
      if (present) await run("git", ["worktree", "remove", lane.worktree], { cwd: repo });
      await new Terminals(run).kill(lane.terminal);
      bus.publish(store.setLaneState(id, "cleaned", "units stopped, checkout removed, branch kept"));
      return { cleaned: true };
    } finally { this.busy.delete(id); }
  }

  /** The note goes to the same agent as a normal message, and the lane goes back to work. */
  requestChanges(id: string, note: string): { delivered: boolean } {
    const { checkpoint } = this.pending(id);
    const { store, bus, hosts } = this.deps;
    const events = store.tx(() => {
      store.decideCheckpoint(checkpoint.id, "changes");
      return [store.appendEvent(id, { type: "checkpoint.decided", payload: { checkpointId: checkpoint.id, decision: "changes", note } }), store.setLaneState(id, "working", "changes requested"), store.appendEvent(id, { type: "agent.message", payload: { text: note, role: "user" } })];
    });
    for (const event of events) bus.publish(event);
    return { delivered: hosts.command(id, { kind: "prompt", text: note, immediate: false }).delivered };
  }
}
