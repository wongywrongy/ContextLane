import { SplitLanesRequest, type Lane, type LaneEvent } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Store } from "./db/store.js";
import type { HostLinks } from "./hosts.js";
import { NotFound, Refused, type LaneManager } from "./lanes/manager.js";
import type { Runner } from "./run.js";

const OPEN = ["setting_up", "working", "needs_you", "in_review"];
const n = (id: string) => id.slice(id.lastIndexOf("/") + 1);

/**
 * Sub-lanes: a lane's agent splits the rest of its task into parallel lanes. The owner agrees once for all of
 * them. Each starts from the parent's current commit with the same agent, model, permissions and Auto, is
 * judged and reviewed like any lane, and when approved its branch goes back to the parent: the parent's agent
 * is asked to merge it in its own checkout (the same repository), so nothing is pushed or opened as a pull
 * request until the parent itself is reviewed. One level only: a sub-lane cannot split again.
 */
export class Sublanes {
  constructor(private deps: { store: Store; bus: EventBus; lanes: LaneManager; hosts: HostLinks; run: Runner }) {}

  /** The lane a sub-lane merges into, if it is one. */
  parentOf(lane: Lane): Lane | null {
    const { store } = this.deps;
    for (const l of store.listLanes(lane.project)) {
      if (l.id === lane.id) continue;
      if (store.eventsOfType(["lane.split"], { lanes: [l.id] }).some((e) => e.payload.children.some((c) => c.lane === lane.id))) return l;
    }
    return null;
  }

  children(parent: string): { lane: string; title: string }[] {
    return this.deps.store.eventsOfType(["lane.split"], { lanes: [parent] }).flatMap((e) => e.payload.children);
  }

  /** split_lanes: asks the owner once, then starts the sub-lanes. Returns pending until answered. */
  async split(parentId: string, input: unknown): Promise<{ pending: true; requestId: string } | { started: { lane: string; title: string }[]; note: string } | { declined: true; note: string }> {
    const { store, bus, lanes, run } = this.deps;
    const parent = store.getLane(parentId);
    if (!parent) throw new NotFound(`no lane ${parentId}`);
    const body = SplitLanesRequest.parse(input);
    // Retried with the same request ID: the split already started answers with its lanes.
    const done = store.eventsOfType(["lane.split"], { lanes: [parentId] }).find((e) => e.payload.requestId === body.requestId);
    if (done) return { started: done.payload.children, note: note(parent, done.payload.children) };
    if (!store.permission(parentId, body.requestId)) {
      if (this.parentOf(parent)) throw new Refused("This lane is a sub-lane already; it cannot split again. Finish your part, or ask the owner.");
      if (!["working", "needs_you"].includes(parent.state)) throw new Refused(`A lane can split only while it works; this one is ${parent.state.replace("_", " ")}.`);
      if ((await run("git", ["status", "--porcelain"], { cwd: parent.worktree })).stdout.trim()) throw new Refused("Commit your work first: sub-lanes start from your latest commit, and these changes are not committed yet.");
      const detail = [`Why: ${body.why}`, ...body.lanes.map((l, i) => `${i + 1}. ${l.title} — ${l.task.split("\n")[0]!.slice(0, 160)}`), `Each gets its own ${parent.agent} agent and checkout from lane ${n(parent.id)}'s latest commit and merges back into it.`].join("\n");
      bus.publish(store.appendEvent(parentId, { type: "permission.requested", payload: { requestId: body.requestId, title: `Split the rest into ${body.lanes.length} parallel sub-lanes?`, detail, kind: "question",
        options: [{ id: "0", label: `Start ${body.lanes.length} sub-lanes`, kind: "allow_once" }, { id: "1", label: "Keep it in one lane", kind: "reject_once" }] } }));
      if (parent.state === "working") bus.publish(store.setLaneState(parentId, "needs_you"));
    }
    const answer = store.answer(parentId, body.requestId);
    if (!answer) return { pending: true, requestId: body.requestId };
    if (answer.optionId !== "0") return { declined: true, note: "The owner wants this kept in one lane. Carry on with the whole task yourself." };
    const started: { lane: string; title: string }[] = [];
    const failed: string[] = [];
    for (const part of body.lanes) {
      const prompt = [`You are a sub-lane of lane ${n(parent.id)} ("${parent.task}"). Its agent split the work; this part is yours.`,
        `Your part: ${part.title}`, part.task,
        `Work only on this part and stay out of the other parts' files. Commit as you go. When your part is done and tested, call checkpoint. Once the owner approves, lane ${n(parent.id)} merges your branch.`].join("\n\n");
      try {
        const child = await lanes.start({ project: parent.project, task: part.task, title: part.title, agent: parent.agent, model: parent.model ?? undefined, mode: parent.mode, auto: parent.auto,
          ...(parent.effort ? { effort: parent.effort as "low" | "medium" | "high" } : {}), base: parent.branch, ...(parent.goal ? { goal: parent.goal } : {}) }, { firstPrompt: prompt });
        started.push({ lane: child.id, title: part.title });
      } catch (err) { failed.push(`${part.title}: ${(err as Error).message}`); }
    }
    bus.publish(store.appendEvent(parentId, { type: "lane.split", payload: { requestId: body.requestId, why: body.why, children: started } }));
    return { started, note: note(parent, started) + (failed.length ? `\n\nThese did not start, so they are still yours: ${failed.join("; ")}` : "") };
  }

  /** sublane_status: each sub-lane's state, its last checkpoint and the judge's verdict. */
  status(parentId: string): { lanes: { lane: string; title: string; state: string; checkpoint: string | null; verdict: string | null; merged: boolean }[] } {
    const { store } = this.deps;
    return { lanes: this.children(parentId).map((c) => {
      const lane = store.getLane(c.lane);
      const cp = store.latestCheckpoint(c.lane);
      return { lane: c.lane, title: c.title, state: lane?.state ?? "gone", checkpoint: cp?.summary ?? null, verdict: cp?.judge?.verdict ?? null, merged: lane?.state === "merged" };
    }) };
  }

  /**
   * Approve for a sub-lane: its branch goes to the parent, not to origin. The parent's agent is asked to merge it
   * (same repository, so the branch is already there) and run the tests; its message shows in the parent's steps.
   */
  approveIntoParent(lane: Lane, parent: Lane, checkpointId: string): LaneEvent[] {
    const { store, hosts } = this.deps;
    const text = `Sub-lane ${n(lane.id)} ("${lane.task}") was approved. Merge its branch into yours now: git merge --no-ff ${lane.branch} (it is in this repository already). Resolve any conflicts, run the tests, commit, and carry on.`;
    const events = store.tx(() => {
      store.decideCheckpoint(checkpointId, "approved");
      return [store.appendEvent(lane.id, { type: "checkpoint.decided", payload: { checkpointId, decision: "approved" } }),
        store.setLaneState(lane.id, "merged", `approved into lane ${n(parent.id)}`),
        store.appendEvent(parent.id, { type: "agent.message", payload: { role: "user", text } })];
    });
    hosts.command(parent.id, { kind: "prompt", text, immediate: false, files: [], images: [] });
    return events;
  }

  /** The open parent a sub-lane merges into, or null when it is not a sub-lane or its parent has finished. */
  openParent(lane: Lane): Lane | null {
    const parent = this.parentOf(lane);
    return parent && OPEN.includes(parent.state) && parent.branch === lane.base ? parent : null;
  }
}

function note(parent: Lane, started: { lane: string; title: string }[]): string {
  return started.length ? `Started ${started.map((s) => `lane ${n(s.lane)} (${s.title})`).join(", ")}. They branch from your latest commit on ${parent.branch}. Keep working on what is left for you and leave their files alone. When the owner approves one, you will be asked to merge its branch. Call sublane_status to see where they are.` : "No sub-lane could start.";
}
