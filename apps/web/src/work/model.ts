import { STEP_FAMILY, type Lane, type LaneEvent, type EventPayload, type ServiceState } from "@contextlanes/protocol";

export function mergeEvents(...groups: LaneEvent[][]): LaneEvent[] {
  const unique = new Map<string, LaneEvent>();
  for (const group of groups) for (const event of group) unique.set(`${event.lane}:${event.seq}`, event);
  return [...unique.values()].sort((a, b) => a.lane.localeCompare(b.lane) || a.seq - b.seq);
}

export async function loadHistory(lane: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<LaneEvent[]> {
  const events: LaneEvent[] = [];
  let after = 0;
  for (;;) {
    const response = await fetcher(`/api/lanes/${lane}/events?after=${after}`, { signal });
    if (!response.ok) throw new Error(`Could not load steps (${response.status}).`);
    const page = await response.json() as LaneEvent[];
    if (page.length === 0) return events;
    const last = page.at(-1)!.seq;
    if (last <= after) throw new Error("Event history did not advance.");
    events.push(...page);
    after = last;
    if (page.length < 500) return events;
  }
}

type Tool = EventPayload<"tool.call"> & { failedBefore?: boolean };
export type Step = { seq: number; at: string; family: "look" | "change" | "run" | "mind" | "you" | "team"; title: string; type: "tool" | "text" | "thought" | "plan" | "permission" | "check" | "status"; text?: string; tool?: Tool; event: LaneEvent };

export function stepsFor(events: LaneEvent[]): Step[] {
  const steps: Step[] = [];
  const calls = new Map<string, Step>();
  let textRun: Step | undefined;
  for (const event of events) {
    if (event.type === "agent.message" || event.type === "agent.thought") {
      const thought = event.type === "agent.thought";
      const family = thought ? "mind" : event.payload.role === "user" ? "you" : "mind";
      const attached = event.type === "agent.message" ? [...(event.payload.files ?? []).map((f) => f.split("/").at(-1)!), ...(event.payload.images ? [`${event.payload.images} ${event.payload.images === 1 ? "picture" : "pictures"}`] : [])] : [];
      const text = attached.length ? `${event.payload.text}\n\nAttached: ${attached.join(", ")}` : event.payload.text;
      if (textRun?.event.type === event.type && textRun.family === family && !attached.length) textRun.text += text;
      else { textRun = { seq: event.seq, at: event.at, family, title: thought ? "Thinking" : family === "you" ? "Your message" : "Agent", type: thought ? "thought" : "text", text, event }; steps.push(textRun); }
      continue;
    }
    textRun = undefined;
    if (event.type === "tool.call") {
      const step: Step = { seq: event.seq, at: event.at, family: STEP_FAMILY[event.payload.kind], type: "tool", title: event.payload.title, tool: { ...event.payload }, event };
      calls.set(event.payload.callId, step); steps.push(step);
    } else if (event.type === "tool.update") {
      let step = calls.get(event.payload.callId);
      if (!step) { step = { seq: event.seq, at: event.at, family: "look", type: "tool", title: "Tool", tool: { callId: event.payload.callId, kind: "other", title: "Tool", files: [] }, event }; calls.set(event.payload.callId, step); steps.push(step); }
      const failedBefore = step.tool!.failedBefore || step.tool!.status === "failed" || event.payload.status === "failed";
      step.tool = { ...step.tool!, ...event.payload, failedBefore };
      step.title = step.tool.title;
      step.family = STEP_FAMILY[step.tool.kind];
    } else if (event.type === "agent.plan") steps.push({ seq: event.seq, at: event.at, family: "mind", title: "Plan", type: "plan", event });
    else if (event.type === "permission.requested") steps.push({ seq: event.seq, at: event.at, family: "you", title: event.payload.title, type: "permission", event });
    else if (event.type === "check.result") steps.push({ seq: event.seq, at: event.at, family: "run", title: event.payload.name, type: "check", event });
    else if (event.type === "helper.delegated") {
      const p = event.payload;
      const what = p.kind === "read" ? `read ${p.files?.length ? p.files.map((f) => f.split("/").at(-1)).join(", ") : "files"}` : p.kind === "check" ? "ran the checks" : `wrote a patch for ${p.files?.map((f) => f.split("/").at(-1)).join(", ") ?? "files"}`;
      const k = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
      steps.push({ seq: event.seq, at: event.at, family: "team", title: `Your local model ${what} for the agent`, type: "status", text: `${p.model} · about ${k(p.tokensSaved)} fewer tokens for the cloud agent to read`, event });
    }
    else if (event.type === "lane.handoff") steps.push({ seq: event.seq, at: event.at, family: "team", title: event.payload.from === event.payload.to ? "Fresh session from a handoff" : `Handed off to ${event.payload.to}`, type: "status", text: `${event.payload.chars.toLocaleString()} characters of handoff`, event });
    else if (event.type === "lane.forked") steps.push({ seq: event.seq, at: event.at, family: "team", title: `Forked into lane ${event.payload.to.slice(event.payload.to.lastIndexOf("/") + 1)}`, type: "status", event });
    else if (event.type === "agent.error") steps.push({ seq: event.seq, at: event.at, family: "run", title: "Problem", type: "status", text: event.payload.message, event });
    else if (event.type === "agent.command.result" && !event.payload.ok) steps.push({ seq: event.seq, at: event.at, family: "you", title: "Control could not be applied", type: "status", text: event.payload.error, event });
    else if (event.type === "notification.failed") steps.push({ seq: event.seq, at: event.at, family: "you", title: "Notification could not be sent", type: "status", text: event.payload.message, event });
    else if (event.type === "agent.turn" && event.payload.stopReason === "cancelled") steps.push({ seq: event.seq, at: event.at, family: "you", title: "Interrupted", type: "status", event });
  }
  return steps;
}

/** A working lane whose agent has finished its turn is idle: it waits for your next message. */
export function isIdle(lane: Lane, events: LaneEvent[]): boolean {
  if (lane.state !== "working") return false;
  const turn = events.findLast((e) => e.lane === lane.id && e.type === "agent.turn");
  return turn?.type === "agent.turn" && !turn.payload.active;
}

export function queuedPrompts(events: LaneEvent[]) {
  const started = new Set(events.flatMap((e) => e.type === "agent.turn" && e.payload.commandId ? [e.payload.commandId] : e.type === "agent.command.result" && !e.payload.ok ? [e.payload.commandId] : []));
  return events.filter((e): e is Extract<LaneEvent, { type: "agent.command" }> => e.type === "agent.command" && e.payload.command.kind === "prompt" && !started.has(e.payload.commandId));
}

export const SERVICE_GLYPH: Record<ServiceState, string> = { starting: "think", healthy: "done", failed: "fail", stopped: "idle" };

/** A lane's services as the event log last reported them, and whether a recipe waits on the owner. */
export function environmentFrom(events: LaneEvent[]): { services: EventPayload<"env.status">[]; recipeWaiting: boolean } {
  const services = new Map<string, EventPayload<"env.status">>();
  const waiting = new Set<string>();
  for (const event of events) {
    if (event.type === "env.status" && event.payload.service !== "setup") services.set(event.payload.service, event.payload);
    if (event.type === "recipe.requested") waiting.add(event.payload.hash);
    if (event.type === "recipe.approved") waiting.delete(event.payload.hash);
  }
  return { services: [...services.values()], recipeWaiting: waiting.size > 0 };
}

export type ActivitySegment = { from: number; to: number; state: string };
export function timeline(lane: Lane, events: LaneEvent[], start: number, end: number): ActivitySegment[] {
  const changes = events.filter((e) => e.lane === lane.id && (e.type === "lane.state" || e.type === "agent.turn")).sort((a, b) => a.seq - b.seq);
  const firstState = changes.find((e) => e.type === "lane.state");
  let state = firstState?.type === "lane.state" ? firstState.payload.from : lane.state;
  let active = true;
  let cursor = Math.max(start, Date.parse(lane.createdAt));
  const segments: ActivitySegment[] = [];
  for (const event of changes) {
    const at = Math.min(end, Date.parse(event.at));
    if (at > cursor && cursor < end) segments.push({ from: cursor, to: at, state: state === "working" && !active ? "idle" : state });
    cursor = Math.max(cursor, at);
    if (event.type === "lane.state") state = event.payload.to;
    if (event.type === "agent.turn") active = event.payload.active;
  }
  if (cursor < end) segments.push({ from: cursor, to: end, state: state === "working" && !active ? "idle" : state });
  return segments.filter((s) => s.to > s.from && s.to > start);
}
