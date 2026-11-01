import { SplitLanesRequest, LaneStartRequest, SublaneProposal, laneTitle, type Lane, type LaneEvent } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Store } from "./db/store.js";
import type { HostLinks } from "./hosts.js";
import { NotFound, Refused, type LaneManager } from "./lanes/manager.js";
import type { Runner } from "./run.js";

type Proposal = import("zod").infer<typeof SublaneProposal>;
type Result = { pending: true; requestId: string } | { started: { lane: string; title: string }[]; note: string } | { declined: true; note: string };
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
  private running = new Map<string, { text: string; work: Promise<Result> }>();
  constructor(private deps: { store: Store; bus: EventBus; lanes: LaneManager; hosts: HostLinks; run: Runner }) {}

  /** The lane a sub-lane merges into, if it is one. */
  parentOf(lane: Lane): Lane | null {
    const { store } = this.deps;
    const link = store.eventsOfType(["lane.child"], { lanes: [lane.id] }).at(-1);
    if (link) return store.getLane(link.payload.parent);
    for (const l of store.listLanes(lane.project)) {
      if (l.id === lane.id) continue;
      if (store.eventsOfType(["lane.split"], { lanes: [l.id] }).some((e) => e.payload.children.some((c) => c.lane === lane.id))) return l;
    }
    return null;
  }

  children(parent: string): { lane: string; title: string }[] {
    const { store } = this.deps;
    return [...new Map([...store.eventsOfType(["lane.split"], { lanes: [parent] }).flatMap(e => e.payload.children), ...store.listLanes().flatMap(l => store.eventsOfType(["lane.child"], { lanes: [l.id] }).filter(e => e.payload.parent === parent).map(e => ({ lane: l.id, title: e.payload.title })))].map(c => [c.lane, c])).values()];
  }

  /** split_lanes: asks the owner once, then starts the sub-lanes. Returns pending until answered. */
  split(parentId: string, input: unknown): Promise<Result> { return this.propose(parentId, SplitLanesRequest.parse(input)); }

  start(parentId: string, input: unknown): Promise<Result> {
    const { requestId, task, agent, base } = LaneStartRequest.parse(input);
    return this.propose(parentId, { requestId, why: "A separate child lane for this task", lanes: [{ title: laneTitle(task).slice(0, 100), task, ...(agent ? { agent } : {}), ...(base ? { base } : {}) }] });
  }

  private propose(parentId: string, input: Proposal): Promise<Result> {
    const parent = this.deps.store.getLane(parentId);
    if (!parent) throw new NotFound("no lane");
    const body = SublaneProposal.parse({ ...input, lanes: input.lanes.map(part => ({ ...part, agent: part.agent ?? parent.agent, base: part.base ?? parent.branch })) }), key = `${parentId}#${body.requestId}`, text = JSON.stringify(body);
    const running = this.running.get(key);
    if (running) {
      if (running.text !== text) throw new Refused("This request ID already has different content.");
      return running.work;
    }
    const work = this.launch(parentId, body).finally(() => this.running.delete(key));
    this.running.set(key, { text, work });
    return work;
  }

  private async launch(parentId: string, body: Proposal): Promise<Result> {
    const { store, bus, lanes, run } = this.deps;
    const parent = store.getLane(parentId);
    if (!parent) throw new NotFound(`no lane ${parentId}`);
    const proposed = store.eventsOfType(["lane.proposed"], { lanes: [parentId] }).find(e => e.payload.requestId === body.requestId);
    if (proposed && JSON.stringify(proposed.payload) !== JSON.stringify(body)) throw new Refused("This request ID already has different content; ask again with a new request ID.");
    if (!proposed && store.permission(parentId, body.requestId)) throw new Refused("This request ID belongs to another question; ask with a new request ID.");
    // Retried with the same request ID: the split already started answers with its lanes.
    const done = store.eventsOfType(["lane.split"], { lanes: [parentId] }).find((e) => e.payload.requestId === body.requestId);
    if (done) return { started: done.payload.children, note: note(parent, done.payload.children) };
    if (this.parentOf(parent)) throw new Refused("This lane is a sub-lane already; it cannot split again. Finish your part, or ask the owner.");
    if (!["working", "needs_you"].includes(parent.state)) throw new Refused("The parent lane is no longer working.");
    if (!store.permission(parentId, body.requestId)) {
      if ((await run("git", ["status", "--porcelain"], { cwd: parent.worktree })).stdout.trim()) throw new Refused("Commit your work first: sub-lanes start from your latest commit, and these changes are not committed yet.");
      if (!proposed) bus.publish(store.appendEvent(parentId, { type: "lane.proposed", payload: body }));
      const detail = [`Why: ${body.why}`, ...body.lanes.map((l, i) => `${i + 1}. ${l.title} — ${l.task}\nAgent: ${l.agent ?? parent.agent}; base: ${l.base ?? parent.branch}`), `Each gets a checkout with the agent and base above. Approved work merges back into lane ${n(parent.id)}.`].join("\n");
      bus.publish(store.appendEvent(parentId, { type: "permission.requested", payload: { requestId: body.requestId, title: body.lanes.length === 1 ? `Start a child lane: ${body.lanes[0]!.title}?` : `Split the rest into ${body.lanes.length} parallel sub-lanes?`, detail, kind: "question",
        options: [{ id: "0", label: `Start ${body.lanes.length} ${body.lanes.length === 1 ? "child lane" : "sub-lanes"}`, kind: "allow_once" }, { id: "1", label: "Keep it in one lane", kind: "reject_once" }] } }));
      if (parent.state === "working") bus.publish(store.setLaneState(parentId, "needs_you"));
    }
    const answer = store.answer(parentId, body.requestId);
    if (!answer) return { pending: true, requestId: body.requestId };
    if (answer.optionId !== "0") return { declined: true, note: "The owner wants this kept in one lane. Carry on with the whole task yourself." };
    const started: { lane: string; title: string }[] = [];
    const failed: string[] = [];
    for (const [index, part] of body.lanes.entries()) {
      const prior = store.listLanes(parent.project).find(l => store.eventsOfType(["lane.child"], { lanes: [l.id] }).some(e => e.payload.parent === parentId && e.payload.requestId === body.requestId && e.payload.part === index));
      if (prior) { started.push({ lane: prior.id, title: part.title }); continue; }
      const prompt = [`You are a sub-lane of lane ${n(parent.id)} ("${parent.task}"). Its agent split the work; this part is yours.`,
        `Your part: ${part.title}`, part.task,
        `Work only on this part and stay out of the other parts' files. Commit as you go. When your part is done and tested, call checkpoint. Once the owner approves, lane ${n(parent.id)} merges your branch.`].join("\n\n");
      try {
        const child = await lanes.start({ project: parent.project, task: part.task, title: part.title, agent: part.agent ?? parent.agent, kind: !part.agent || part.agent === parent.agent ? parent.kind : ["claude-code", "codex"].includes(part.agent) ? "cli" : "acp", model: !part.agent || part.agent === parent.agent ? parent.model ?? undefined : undefined, mode: parent.mode, auto: parent.auto,
          ...(parent.effort ? { effort: parent.effort as "low" | "medium" | "high" } : {}), base: part.base ?? parent.branch, ...(parent.goal ? { goal: parent.goal } : {}) }, { firstPrompt: prompt, prepare: async child => { bus.publish(store.appendEvent(child.id, { type: "lane.child", payload: { parent: parentId, requestId: body.requestId, part: index, title: part.title } })); } });
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

  list(caller: string) {
    const parent = this.deps.store.getLane(caller);
    if (!parent) throw new NotFound("no lane");
    return { lanes: this.deps.store.listLanes(parent.project).map(l => ({ lane: l.id, title: l.task, state: l.state, agent: l.agent, checkpoint: this.deps.store.latestCheckpoint(l.id) })) };
  }

  inspect(caller: string, target: string) {
    const { store } = this.deps;
    const lane = store.getLane(target);
    if (!lane || lane.project !== store.getLane(caller)?.project) throw new NotFound("no lane in this project");
    return laneStatus(store, lane);
  }

  send(caller: string, target: string, text: string) {
    const { store, bus, hosts } = this.deps;
    const child = store.getLane(target);
    if (!child || this.parentOf(child)?.id !== caller) throw new Refused("You can send only to your own children.", 403);
    if (!OPEN.includes(child.state)) throw new Refused("This child lane has finished.");
    const message = `Message from parent lane ${caller}:\n\n${text}`;
    bus.publish(store.appendEvent(caller, { type: "lane.sent", payload: { to: target, text } }));
    bus.publish(store.appendEvent(target, { type: "agent.message", payload: { role: "user", text: message } }));
    return hosts.command(target, { kind: "prompt", text: message, immediate: false, files: [], images: [] });
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
    return parent && OPEN.includes(parent.state) ? parent : null;
  }
}

function note(parent: Lane, started: { lane: string; title: string }[]): string {
  return started.length ? `Started ${started.map((s) => `lane ${n(s.lane)} (${s.title})`).join(", ")}. Their approved bases and agents are recorded in the proposal. Keep working on what is left for you and leave their files alone. When the owner approves one, you will be asked to merge its branch. Call sublane_status to see where they are.` : "No sub-lane could start.";
}

export function laneStatus(store: Store, lane: Lane) {
  const checkpoint = store.latestCheckpoint(lane.id);
  const plan = store.eventsOfType(["agent.plan"], { lanes: [lane.id] }).at(-1)?.payload.entries ?? [];
  return { lane, plan, checkpoint, verdict: checkpoint?.judge?.verdict ?? null };
}
