import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { guard, type EventPayload, type LaneEvent } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Store } from "./db/store.js";

type Deps = { store: Store; bus: EventBus; send: (lane: string, message: Record<string, unknown>) => boolean };
export type AnswerBy = EventPayload<"permission.answered">["by"];

/**
 * Resolves a pending permission: records the answer, queues the command for the lane host and sends it,
 * and puts the lane back to working when nothing else waits. The owner's answers (/api/answers) and Auto
 * mode's both come through here; the agent's own requests never can.
 */
export function answerPermission(deps: Deps, lane: string, requestId: string, optionId: string | null, by: AnswerBy): { commandId: string; delivered: boolean } {
  const { store, bus } = deps;
  const request = store.permission(lane, requestId)!;
  const commandId = randomUUID();
  const command = { kind: "answer" as const, requestId, optionId };
  const events = store.tx(() => {
    const events: LaneEvent[] = [store.appendEvent(lane, { type: "permission.answered", payload: { requestId, optionId, by } })];
    if (request.kind !== "question") events.push(store.appendEvent(lane, { type: "agent.command", payload: { commandId, command } }));
    if (store.getLane(lane)?.state === "needs_you" && !store.inbox().some((i) => i.lane === lane && ["permission", "question"].includes(i.kind))) events.push(store.setLaneState(lane, "working"));
    return events;
  });
  for (const event of events) bus.publish(event);
  return { commandId, delivered: request.kind === "question" || deps.send(lane, { commandId, command }) };
}

/**
 * Auto mode's verdict for a permission request: the "allow once" option when the guard passes it, or why
 * it waits for the owner. Questions always wait, and so does a request with no "allow once" option, since
 * "always" would stop the agent asking and so take later requests past the guard.
 */
export function autoVerdict(store: Store, lane: string, payload: EventPayload<"permission.requested">): { optionId: string } | { held: string } {
  const l = store.getLane(lane);
  if (!l) return { held: "the lane is gone" };
  if (payload.kind === "question") return { held: "the agent asked you a question" };
  const once = payload.options.find((o) => o.kind === "allow_once");
  if (!once) return { held: "the agent offered no one-time approval" };
  const tool = { kind: null, command: null, paths: [] as string[], cwd: null, ...payload.tool };
  // Some agents (Codex) send only the call's id with the request; its first report has the kind and the command as its title.
  const call = tool.callId ? store.toolCall(lane, tool.callId) : null;
  const kind = tool.kind ?? call?.kind ?? null;
  const command = tool.command ?? (kind === "execute" && call ? call.title : null);
  const verdict = guard({ kind, command, paths: [...new Set([...tool.paths, ...(call?.files ?? [])])], cwd: tool.cwd, title: payload.title },
    { worktree: l.worktree, home: homedir(), base: l.base });
  return verdict.ok ? { optionId: once.id } : { held: verdict.reason };
}

/** Answers every pending request of a lane that Auto now passes (when Auto is turned on). */
export function sweepPending(deps: Deps, lane: string): number {
  let n = 0;
  for (const item of deps.store.inbox().filter((i) => i.lane === lane && i.kind === "permission")) {
    const requestId = item.id.slice(item.id.indexOf("#") + 1);
    const payload = deps.store.permission(lane, requestId);
    if (!payload || deps.store.answered(lane, requestId)) continue;
    const verdict = autoVerdict(deps.store, lane, payload);
    if ("optionId" in verdict) { answerPermission(deps, lane, requestId, verdict.optionId, "auto"); n++; }
  }
  return n;
}
