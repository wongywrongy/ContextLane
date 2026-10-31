import { STEP_FAMILY, isTestCommand, type InboxItem, type Lane, type LaneEvent, type EventPayload, type ServiceState } from "@contextlanes/protocol";
import { GLYPH } from "../components/ui";

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
    else if (event.type === "lane.auto") steps.push({ seq: event.seq, at: event.at, family: "you", title: event.payload.on ? "Auto on" : "Auto off", type: "status", text: event.payload.on ? "ContextLanes approves the agent's requests, except dire ones, which wait for you" : "Every request waits for you again", event });
    else if (event.type === "lane.split") steps.push({ seq: event.seq, at: event.at, family: "team", title: `Split into ${event.payload.children.length} sub-lanes`, type: "status", text: event.payload.children.map((c) => `${c.lane.slice(c.lane.lastIndexOf("/") + 1)} ${c.title}`).join(" · "), event });
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

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? text;
  const end = line.search(/[.!?](\s|$)/);
  return end > 0 ? line.slice(0, end + 1) : line;
}

const SUBCOMMAND = /^(git|npm|pnpm|yarn|bun|npx|docker|kubectl|cargo|go|make|uv|pip|python3?\s+-m|gh|terraform)$/;
/** A command line as a person would say it: "git status", "pnpm test", "rg"; never the whole quoted line. */
export { isTestCommand };
export function plainCommand(line: string): string {
  const first = line.split(/&&|\|\||;|\|/).map((p) => p.trim()).find((p) => p && !/^(cd|export|set|source|\.)\s/.test(p)) ?? line.trim();
  const words = first.replace(/^(\w+=\S*\s+)+/, "").split(/\s+/).filter(Boolean);
  const program = (words[0] ?? "").split("/").pop() ?? "";
  const pair = `${program} ${words[1] ?? ""}`;
  if (SUBCOMMAND.test(program) || SUBCOMMAND.test(pair.trim())) {
    const sub = words.slice(1).find((w) => !w.startsWith("-")) ?? "";
    return `${program} ${sub === "run" ? `run ${words[words.indexOf("run") + 1] ?? ""}` : sub}`.trim();
  }
  return program || first.slice(0, 40);
}

/** A step in a few plain words: "Running pnpm test", "Editing dates.py", "Searching the code". */
export function plainStep(step: Step): string {
  if (step.type === "text") return step.family === "you" ? "Reading your message" : "Writing a reply";
  if (step.type === "thought") return "Thinking";
  if (step.type === "plan") return "Planning";
  const tool = step.tool;
  if (!tool) return firstLine(step.title).slice(0, 60);
  const file = tool.files[0]?.split("/").pop();
  switch (tool.kind) {
    case "execute": return isTestCommand(step.title) ? `Running tests (${plainCommand(step.title)})` : `Running ${plainCommand(step.title)}`;
    case "read": return file ? `Reading ${file}` : "Reading files";
    case "edit": return file ? `Editing ${file}${tool.files.length > 1 ? ` and ${tool.files.length - 1} more` : ""}` : "Editing files";
    case "delete": return file ? `Deleting ${file}` : "Deleting files";
    case "move": return file ? `Moving ${file}` : "Moving files";
    case "search": return "Searching the code";
    case "fetch": return "Reading a web page";
    case "think": return "Thinking";
    default: return firstLine(step.title).slice(0, 60);
  }
}

/** What a lane is doing, in a few words, for the lane list and the overview. */
export function laneNow(lane: Lane, events: LaneEvent[], waiting: InboxItem[]): string {
  const asked = waiting.find((i) => i.lane === lane.id);
  if (asked) return asked.kind === "question" ? `Asks: ${asked.title}` : asked.kind === "review" ? "Ready for your review" : asked.kind === "permission" ? `Wants to run ${plainCommand(asked.title)}` : firstLine(asked.title);
  const mine = events.filter((e) => e.lane === lane.id);
  if (lane.state === "failed") {
    const error = mine.findLast((e) => e.type === "agent.error");
    const change = mine.findLast((e) => e.type === "lane.state" && e.payload.to === "failed");
    const why = change?.type === "lane.state" && change.payload.reason ? change.payload.reason : error?.type === "agent.error" ? error.payload.message : "";
    return why ? firstLine(why) : "Stopped";
  }
  if (isIdle(lane, events)) return "Idle · waiting for your message";
  const latest = mine.findLast((e) => e.type === "agent.error" || e.type === "agent.session" || e.type === "agent.message" || e.type === "tool.call");
  if (lane.state === "working" && latest?.type === "agent.error") return latest.payload.message.startsWith("Agent restarted") ? "Restarting the agent" : `Problem: ${firstLine(latest.payload.message)}`;
  const last = stepsFor(mine).findLast((s) => s.type !== "text" || s.family !== "you");
  if (lane.state === "working" && last) return plainStep(last);
  return lane.state === "working" ? "Working · no steps yet" : GLYPH[lane.state][1];
}

/**
 * The lane as progress rather than activity. Milestones stay as their own rows: your messages, the agent's
 * replies, test runs, commits and pushes, checks and checkpoints, approvals and problems. Everything the
 * agent did between two milestones (reading, searching, thinking, editing, other commands) folds into one
 * "worked" row that says how long, which files changed, and how much it read and ran.
 */
export type ProgressItem =
  | { kind: "milestone"; seq: number; at: string; step: Step; what: "you" | "reply" | "tests" | "commit" | "push" | "other"; ok?: boolean; title: string }
  | { kind: "worked"; seq: number; at: string; to: string; steps: Step[]; edited: string[]; reads: number; searches: number; commands: number; thoughts: number; failed: number };

const COMMIT = /\bgit\s+(-\S+\s+)*commit\b/;
const PUSH = /\bgit\s+(-\S+\s+)*push\b/;
export function progressFor(steps: Step[]): ProgressItem[] {
  const out: ProgressItem[] = [];
  let work: Extract<ProgressItem, { kind: "worked" }> | null = null;
  const close = () => { if (work) { out.push(work); work = null; } };
  for (const step of steps) {
    const tool = step.tool;
    const finished = tool?.status === "completed" || tool?.status === "failed";
    const ok = tool?.status !== "failed" && (tool?.exitCode ?? 0) === 0;
    let milestone: Extract<ProgressItem, { kind: "milestone" }> | null = null;
    if (step.type === "text") milestone = { kind: "milestone", seq: step.seq, at: step.at, step, what: step.family === "you" ? "you" : "reply", title: step.text ?? "" };
    else if (step.type === "tool" && tool?.kind === "execute" && finished && isTestCommand(step.title)) milestone = { kind: "milestone", seq: step.seq, at: step.at, step, what: "tests", ok, title: ok ? `Tests passed · ${plainCommand(step.title)}` : `Tests failed · ${plainCommand(step.title)}` };
    else if (step.type === "tool" && tool?.kind === "execute" && finished && ok && COMMIT.test(step.title)) milestone = { kind: "milestone", seq: step.seq, at: step.at, step, what: "commit", ok, title: `Committed${/-m\s+["']([^"']+)/.exec(step.title)?.[1] ? `: ${/-m\s+["']([^"']+)/.exec(step.title)![1]}` : ""}` };
    else if (step.type === "tool" && tool?.kind === "execute" && finished && ok && PUSH.test(step.title)) milestone = { kind: "milestone", seq: step.seq, at: step.at, step, what: "push", ok, title: "Pushed the branch" };
    else if (step.type === "permission" || step.type === "check" || step.type === "status") milestone = { kind: "milestone", seq: step.seq, at: step.at, step, what: "other", title: step.title };
    if (milestone) { close(); out.push(milestone); continue; }
    if (step.type === "plan") continue;
    work ??= { kind: "worked", seq: step.seq, at: step.at, to: step.at, steps: [], edited: [], reads: 0, searches: 0, commands: 0, thoughts: 0, failed: 0 };
    work.steps.push(step); work.to = step.at;
    if (step.type === "thought") work.thoughts++;
    else if (tool) {
      if (tool.status === "failed" || (tool.exitCode ?? 0) !== 0) work.failed++;
      if (["edit", "delete", "move"].includes(tool.kind)) for (const f of tool.files) { const name = f.split("/").pop()!; if (!work.edited.includes(name)) work.edited.push(name); }
      else if (tool.kind === "read") work.reads += Math.max(1, tool.files.length);
      else if (tool.kind === "search") work.searches++;
      else if (tool.kind === "execute") work.commands++;
    }
  }
  close();
  return out;
}

/** "Worked 6m · edited dates.py and 2 more · read 12 files · ran 5 commands" */
export function workedLine(w: Extract<ProgressItem, { kind: "worked" }>): string {
  const minutes = Math.round((Date.parse(w.to) - Date.parse(w.at)) / 60_000);
  const parts = [
    w.edited.length ? `edited ${w.edited.slice(0, 2).join(", ")}${w.edited.length > 2 ? ` and ${w.edited.length - 2} more` : ""}` : "",
    w.reads ? `read ${w.reads} ${w.reads === 1 ? "file" : "files"}` : "",
    w.searches ? `${w.searches} ${w.searches === 1 ? "search" : "searches"}` : "",
    w.commands ? `ran ${w.commands} ${w.commands === 1 ? "command" : "commands"}` : "",
    !w.edited.length && !w.reads && !w.searches && !w.commands && w.thoughts ? "thought it through" : "",
  ].filter(Boolean);
  return `${minutes >= 1 ? `Worked ${minutes}m` : "Worked"}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
}
