import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { cliPromptText, guard, HookRequest, type HookPayload, type Lane, type NewLaneEvent, type StepKind } from "@contextlanes/protocol";
import { SessionUsage, usageDelta } from "@contextlanes/lanehost/usage";
import type { EventBus } from "./bus.js";
import type { Config } from "./config.js";
import type { Store } from "./db/store.js";
import { answerPermission, autoVerdict } from "./permissions.js";
import { NotFound, Refused, toolsHint } from "./lanes/manager.js";

type Deps = { store: Store; bus: EventBus; config: Config; context?: (lane: Lane, task: string) => Promise<string> };
const output = (event: string, value: object) => ({ hookSpecificOutput: { hookEventName: event, ...value } });
const text = (v: unknown) => typeof v === "string" ? v : JSON.stringify(v ?? "");
const inputKey = (p: HookPayload) => createHash("sha256").update(JSON.stringify([p.session_id, p.tool_name, Object.entries(p.tool_input ?? {}).filter(([key]) => key !== "description").sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
const options = [{ id: "allow", label: "Allow once", kind: "allow_once" as const }, { id: "deny", label: "Deny", kind: "reject_once" as const }];

/** Native hooks observe only their own lane; only owner answers or the fixed guard can grant permission. */
export class Hooks {
  constructor(private deps: Deps) {}
  private emit(lane: string, event: NewLaneEvent, source?: string) { const e = this.deps.store.appendEvent(lane, event, source); this.deps.bus.publish(e); return e; }

  answer(lane: string, request: string): object {
    const permission = this.deps.store.permission(lane, request);
    if (!permission || !request.startsWith("hook:")) throw new NotFound("no hook permission");
    const answer = this.deps.store.answer(lane, request);
    if (!answer) return { pending: true, requestId: request };
    if (answer.by === "terminal") return {};
    return output("PermissionRequest", { decision: { behavior: answer.optionId === "allow" ? "allow" : "deny", ...(answer.optionId !== "allow" ? { message: answer.message || "The owner denied this action." } : {}) } });
  }

  async receive(id: string, input: unknown): Promise<object> {
    const { store, bus, config } = this.deps;
    const lane = store.getLane(id);
    if (!lane) throw new NotFound("no lane");
    if (lane.kind !== "cli") throw new Refused("This lane uses ACP, not CLI hooks.", 400);
    const { eventId, payload: p } = HookRequest.parse(input);
    const event = p.hook_event_name;
    const requestId = `hook:${eventId}`;
    const tool = toolInput(p);
    const safety = event === "PreToolUse" ? guard({ ...tool, title: p.tool_name ?? "Tool" }, { worktree: lane.worktree, home: homedir(), base: lane.base }) : null;
    if (store.eventBySource(id, eventId)) return event === "PermissionRequest" ? this.answer(id, requestId) : safety && !safety.ok ? output(event, { permissionDecision: "deny", permissionDecisionReason: safety.reason }) : {};
    const emit = (e: NewLaneEvent) => this.emit(id, e, store.eventBySource(id, eventId) ? undefined : eventId);
    if (event === "SessionStart") {
      emit({ type: "agent.session", payload: { sessionId: p.session_id, ...(p.transcript_path ? { transcriptPath: p.transcript_path } : {}), modes: [], models: [], images: false } });
      const baseline = store.eventsOfType(["lane.created"], { lanes: [id] })[0]?.payload.baseline;
      const notes = baseline ? "" : await readFile(join(config.paths.data, "notes", `${lane.project}.md`), "utf8").catch(() => "");
      if (baseline) return {};
      const task = store.eventsOfType(["agent.message"], { lanes: [id] }).find(e => e.payload.role === "user")?.payload.text ?? lane.task;
      const brief = await this.deps.context?.(lane, task) ?? "";
      const context = [notes.trim() ? `Project notes from the owner:\n${notes.trim().slice(0, 12_000)}` : "", brief, toolsHint(config)].filter(Boolean).join("\n\n");
      return output(event, { additionalContext: context });
    }
    if (event === "UserPromptSubmit") {
      this.terminalAnswers(id);
      const last = store.eventsOfType(["agent.message"], { lanes: [id] }).findLast((e) => e.payload.role === "user");
      const turns = store.eventsOfType(["agent.turn"], { lanes: [id] });
      const before = turns.at(-1);
      const input = store.eventsOfType(["agent.input"], { lanes: [id] }).findLast((e) => e.payload.phase === "sending");
      // Repeated native prompt hooks can follow the first active turn. Correlation is for
      // display/delivery only: neither a match nor an unmatched terminal prompt proves owner input.
      const idle = turns.findLast(e => !e.payload.active);
      const sent = input && input.seq > (idle?.seq ?? 0) ? store.eventsOfType(["agent.command"], { lanes: [id] }).find((e) => e.payload.commandId === input.payload.commandId) : null;
      const delivered = sent?.payload.command.kind === "prompt" && cliPromptText(sent.payload.command).trim() === p.prompt?.trim() ? sent.payload.commandId : null;
      if (p.prompt && !delivered && (before || last?.payload.text !== p.prompt)) emit({ type: "agent.message", payload: { role: "user", text: p.prompt, origin: "native" } });
      emit({ type: "agent.turn", payload: { active: true, ...(delivered ? { commandId: delivered } : {}) } });
      if (lane.state === "failed") bus.publish(store.setLaneState(id, "working", "The CLI started a new turn"));
      return {};
    }
    if (event === "Notification") { emit({ type: "agent.notice", payload: { message: p.message ?? "Agent notification" } }); return {}; }
    if (["Stop", "StopFailure", "Interrupt"].includes(event)) {
      this.terminalAnswers(id);
      if (p.last_assistant_message) emit({ type: "agent.message", payload: { role: "agent", text: p.last_assistant_message } });
      await this.usage(lane, p.session_id, eventId);
      emit({ type: "agent.turn", payload: { active: false, ...(p.error ? { stopReason: p.error } : {}) } });
      return {};
    }
    const previous = p.tool_use_id ? undefined : store.eventsOfType(["tool.call"], { lanes: [id] }).findLast((e) => e.payload.sessionId === p.session_id && e.payload.name === p.tool_name && inputKey({ ...p, tool_input: e.payload.input }) === inputKey(p));
    const callId = p.tool_use_id ?? previous?.payload.callId ?? inputKey(p);
    if (event === "PreToolUse") {
      emit({ type: "tool.call", payload: { callId, name: p.tool_name, input: p.tool_input, sessionId: p.session_id, kind: tool.kind, title: tool.command ?? p.tool_name ?? "Tool", files: tool.paths, status: "in_progress" } });
      const verdict = safety!;
      if (!verdict.ok) {
        emit({ type: "tool.update", payload: { callId, status: "failed", summary: verdict.reason } });
        return output(event, { permissionDecision: "deny", permissionDecisionReason: verdict.reason });
      }
      return {};
    }
    if (event === "PermissionRequest") {
      const payload = { requestId, title: tool.command ?? p.tool_name ?? "Run a tool?", options, tool: { ...tool, callId } };
      const verdict = lane.auto ? autoVerdict(store, id, payload) : null;
      emit({ type: "permission.requested", payload: { ...payload, ...(verdict && "held" in verdict ? { held: verdict.held } : {}) } });
      if (verdict && "optionId" in verdict) answerPermission({ store, bus, send: () => false }, id, requestId, verdict.optionId, "auto");
      else if (lane.state === "working") bus.publish(store.setLaneState(id, "needs_you"));
      return this.answer(id, requestId);
    }
    const result = p.tool_response;
    const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const code = record.exit_code ?? record.exitCode ?? text(result).match(/Process exited with code (-?\d+)/)?.[1];
    const exitCode = code !== undefined && Number.isInteger(Number(code)) ? Number(code) : null;
    const failed = event === "PostToolUseFailure" || !!record.is_error || (exitCode !== null && exitCode !== 0);
    const summary = (p.error ?? text(result)).slice(0, 12_000);
    emit({ type: "tool.update", payload: { callId, status: failed ? "failed" : "completed", exitCode, summary } });
    // The native prompt won, or the hook lost its daemon connection; observing completion never grants an action.
    this.terminalAnswers(id, callId);
    return {};
  }

  private terminalAnswers(id: string, callId?: string): void {
    const { store, bus } = this.deps;
    for (const item of store.inbox().filter((i) => i.lane === id && i.kind === "permission")) {
      const request = item.id.slice(item.id.indexOf("#") + 1);
      if (request.startsWith("hook:") && (!callId || store.permission(id, request)?.tool?.callId === callId) && !store.answered(id, request)) this.emit(id, { type: "permission.answered", payload: { requestId: request, optionId: null, by: "terminal" } });
    }
    if (store.getLane(id)?.state === "needs_you" && !store.inbox().some((i) => i.lane === id && ["permission", "question"].includes(i.kind))) bus.publish(store.setLaneState(id, "working"));
  }

  private async usage(lane: Lane, session: string, turnId: string): Promise<void> {
    const home = join(this.deps.config.paths.data, "cli", lane.id.replace("/", "-"), "agent");
    const after = await new SessionUsage(lane.agent, lane.worktree, session, { CLAUDE_CONFIG_DIR: home, CODEX_HOME: home }).read();
    if (!after) return;
    // Codex 0.166 sends an empty Bash hook result; its native JSONL reports the exact call's output and exit.
    for (const result of after.results ?? []) {
      if (!this.deps.store.toolCall(lane.id, result.callId)) continue;
      const last = this.deps.store.eventsOfType(["tool.update"], { lanes: [lane.id] }).findLast((e) => e.payload.callId === result.callId)?.payload;
      if (last?.exitCode !== result.exitCode || last?.summary !== result.summary) this.emit(lane.id, { type: "tool.update", payload: { ...result, status: result.exitCode !== null && result.exitCode !== 0 ? "failed" : "completed" } });
    }
    for (const limit of after.limits ?? []) {
      const previous = this.deps.store.eventsOfType(["usage.limit"], { lanes: [lane.id] }).findLast(e => e.payload.window === limit.window)?.payload;
      if (JSON.stringify(previous) !== JSON.stringify(limit)) this.emit(lane.id, { type: "usage.limit", payload: limit });
    }
    const before = this.deps.store.eventsOfType(["usage.snapshot"], { lanes: [lane.id] }).findLast((e) => e.payload.sessionId === session)?.payload.tokens;
    const tokens = usageDelta(after.tokens, before);
    if (tokens && Object.values(tokens).some((n) => n !== null && n > 0)) this.emit(lane.id, { type: "usage.turn", payload: { ...tokens, sessionId: session, turnId, source: after.source } });
    this.emit(lane.id, { type: "usage.snapshot", payload: { sessionId: session, tokens: after.tokens } });
  }
}

function toolInput(p: HookPayload): { kind: StepKind; command: string | null; paths: string[]; cwd: string } {
  const input = p.tool_input ?? {};
  const kind: StepKind = /^(Bash|shell|exec_command)$/.test(p.tool_name ?? "") ? "execute" : /^(Edit|Write|apply_patch)$/.test(p.tool_name ?? "") ? "edit" : /^(Read|read_file)$/.test(p.tool_name ?? "") ? "read" : /Grep|Glob|search/i.test(p.tool_name ?? "") ? "search" : "other";
  const command = kind === "execute" && typeof input.command === "string" ? input.command : null;
  const paths = [input.file_path, input.path, ...(Array.isArray(input.paths) ? input.paths : [])].filter((v): v is string => typeof v === "string");
  if (p.tool_name === "apply_patch" && typeof input.command === "string") for (const m of input.command.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.push(m[1]!);
  return { kind, command, paths, cwd: typeof input.cwd === "string" ? input.cwd : p.cwd };
}
