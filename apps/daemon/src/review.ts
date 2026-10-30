import type { Checkpoint, Lane } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Store } from "./db/store.js";
import type { HostLinks } from "./hosts.js";
import { NotFound, Refused } from "./lanes/manager.js";
import type { Runner } from "./run.js";

type Deps = { store: Store; bus: EventBus; hosts: HostLinks; run: Runner };

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
      if ((await this.git(lane, "rev-parse", "HEAD")).stdout.trim() !== checkpoint.head) throw new Refused("The lane has new commits since this checkpoint. Ask for a new checkpoint so review covers them.");
      if ((await this.git(lane, "status", "--porcelain")).stdout.trim()) throw new Refused("The lane has uncommitted changes. Ask the agent to commit or discard them first.");
      await this.git(lane, "remote", "get-url", "origin").catch(() => { throw new Refused("This repository has no origin remote to push to."); });
      await this.git(lane, "fetch", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`);
      await this.update(lane, base);
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
