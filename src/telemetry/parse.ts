import type { SafeEvent, AgentKind, ContextSnapshot } from './types.js';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const name = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,159}$/.test(value) ? value : undefined;
const number = (value: unknown) => (typeof value === 'number' || typeof value === 'string') && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= Number.MAX_SAFE_INTEGER ? Number(value) : undefined;
const bool = (value: unknown) => value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined;
function observedAt(value: unknown, now: number) {
  if (typeof value !== 'string' || !/^\d{1,25}$/.test(value)) return new Date(now).toISOString();
  const milliseconds = Number(BigInt(value) / 1000000n);
  return new Date(Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= now ? milliseconds : now).toISOString();
}
const enumValue = (value: unknown, values: string[]) => typeof value === 'string' && values.includes(value) ? value : undefined;
// Read only explicitly requested scalar attributes; bodies and arbitrary keys never enter the queue.
function attributes(value: unknown, keys: string[]): Json {
  const result: Json = {};
  for (const item of array(value)) {
    const attr = object(item);
    if (typeof attr.key !== 'string' || !keys.includes(attr.key)) continue;
    const v = object(attr.value);
    result[attr.key] = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
  }
  return result;
}
const keys = ['session.id', 'conversation.id', 'event.name', 'otel.name', 'model', 'reasoning_effort', 'effort', 'approval_policy', 'sandbox_policy', 'type', 'tool_name', 'success', 'decision', 'duration_ms', 'status_code', 'http.response.status_code', 'status', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'input_token_count', 'output_token_count', 'cached_token_count', 'cache_write_token_count', 'event.kind', 'server_name', 'skill.name', 'plugin.name', 'plugin.version', 'to_mode'];
const metrics: Record<string, string> = {
  'claude_code.cost.usage': 'cost', 'claude_code.commit.count': 'commits', 'claude_code.pull_request.count': 'pullRequests',
};
const claudeEvents = ['api_request', 'api_error', 'tool_result', 'tool_decision', 'mcp_server_connection', 'skill_activated', 'plugin_loaded', 'api_refusal', 'permission_mode_changed', 'compaction'];
const codexEvents = ['conversation_starts', 'api_request', 'tool_result', 'tool_decision', 'sse_event'];
export function parseOtlp(payload: unknown, signal: 'metrics' | 'logs', now = Date.now()): { events: SafeEvent[]; dropped: Record<string, number> } {
  const events: SafeEvent[] = [], dropped: Record<string, number> = {};
  const drop = (reason: string) => dropped[reason] = (dropped[reason] ?? 0) + 1;
  for (const resource of array(object(payload)[signal === 'metrics' ? 'resourceMetrics' : 'resourceLogs'])) {
    const r = object(resource);
    const service = attributes(object(r.resource).attributes, ['service.name'])['service.name'];
    const agent: AgentKind | undefined = service === 'claude-code' || service === 'claude-code-desktop' ? 'claude' : service === 'codex' || service === 'codex_cli_rs' ? 'codex' : undefined;
    for (const scope of array(r[signal === 'metrics' ? 'scopeMetrics' : 'scopeLogs'])) {
      const s = object(scope);
      for (const entry of array(s[signal === 'metrics' ? 'metrics' : 'logRecords'])) {
        const record = object(entry);
        const points = signal === 'metrics' ? array(object(record.sum).dataPoints) : [record];
        if (!agent || (signal === 'metrics' && agent !== 'claude')) { drop('service'); continue; }
        if (!points.length && signal === 'metrics') { drop('unsupported'); continue; }
        for (const point of points) {
          if (events.length >= 4096) { drop('queue'); continue; }
          const p = object(point), a = attributes(p.attributes, keys);
          const sessionKey = name(a[agent === 'claude' ? 'session.id' : 'conversation.id']);
          const rawName = signal === 'metrics' ? record.name : a['event.name'] ?? a['otel.name'];
          const eventName = typeof rawName === 'string' ? rawName.replace(agent === 'claude' ? /^claude_code\./ : /^codex\./, '') : '';
          if (eventName === 'user_prompt') { drop('prompt'); continue; }
          if (!sessionKey) { drop('session'); continue; }
          const event: SafeEvent = { agent, sessionKey, at: observedAt(p.timeUnixNano, now), kind: signal === 'metrics' ? 'metric' : 'event', name: eventName };
          event.model = name(a.model);
          event.effort = enumValue(a.effort ?? a.reasoning_effort, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
          const approval = enumValue(a.approval_policy, ['never', 'on-request', 'on-failure', 'untrusted', 'unless-trusted']);
          const sandbox = enumValue(a.sandbox_policy, ['read-only', 'workspace-write', 'danger-full-access']);
          event.mode = approval || sandbox ? [approval, sandbox].filter(Boolean).join(' · ') : enumValue(a.to_mode, ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk']);
          if (signal === 'metrics') {
            const metricName = String(record.name);
            event.value = number(p.asDouble ?? p.asInt);
            event.key = metrics[metricName];
            if (metricName === 'claude_code.token.usage') {
              const tokenType = enumValue(a.type, ['input', 'output', 'cacheRead', 'cacheCreation']);
              if (tokenType) event.key = `tokens.${tokenType}`;
            }
            if (metricName === 'claude_code.lines_of_code.count') {
              const lineType = enumValue(a.type, ['added', 'removed']);
              if (lineType) event.key = `lines.${lineType}`;
            }
            event.cumulative = object(record.sum).aggregationTemporality === 2 || object(record.sum).aggregationTemporality === 'AGGREGATION_TEMPORALITY_CUMULATIVE';
            event.startTime = /^\d{1,25}$/.test(String(p.startTimeUnixNano)) ? String(BigInt(String(p.startTimeUnixNano))) : undefined;
            if (!event.key || event.value === undefined) { drop('unsupported'); continue; }
          } else {
            if (!(agent === 'claude' ? claudeEvents : codexEvents).includes(eventName)) { drop('unsupported'); continue; }
            if (eventName === 'sse_event' && a['event.kind'] !== 'response.completed') continue;
            event.tool = name(a.tool_name);
            event.success = bool(a.success);
            event.decision = enumValue(a.decision, ['accept', 'reject', 'approved', 'approved_for_session', 'approved_with_amendment', 'denied', 'abort', 'denied_with_network_policy_deny']);
            event.duration = number(a.duration_ms);
            event.status = number(a.status_code ?? a['http.response.status_code']);
            if (event.status !== undefined && (!Number.isInteger(event.status) || event.status < 100 || event.status > 599)) event.status = undefined;
            event.tokens = {
              input: number(a.input_tokens ?? a.input_token_count), output: number(a.output_tokens ?? a.output_token_count),
              cacheRead: number(a.cache_read_tokens ?? a.cached_token_count), cacheCreation: number(a.cache_creation_tokens ?? a.cache_write_token_count),
            };
            if (eventName === 'mcp_server_connection') {
              const serverName = name(a.server_name), status = enumValue(a.status, ['connected', 'failed', 'disconnected']);
              if (serverName && status) event.toolkit = { kind: 'mcp', name: serverName, version: null, status: status === 'connected' ? 'connected' : 'failed' };
            } else if (eventName === 'skill_activated' || eventName === 'plugin_loaded') {
              const isSkill = eventName === 'skill_activated', entryName = name(a[isSkill ? 'skill.name' : 'plugin.name']);
              if (entryName) event.toolkit = { kind: isSkill ? 'skill' : 'plugin', name: entryName, version: isSkill ? null : name(a['plugin.version']) ?? null, status: 'active' };
            }
          }
          events.push(event);
        }
      }
    }
  }
  return { events, dropped };
}
export function parseSession(payload: unknown, now = Date.now()): SafeEvent | null {
  const p = object(payload), sessionKey = name(p.sessionId), pid = number(p.pid);
  if (p.agent !== 'claude' || !sessionKey || (p.pid !== null && (!pid || !Number.isInteger(pid))) || !['start', 'end'].includes(String(p.event))) return null;
  const cwd = typeof p.cwd === 'string' && p.cwd.startsWith('/') && p.cwd.length <= 4096 && !/[\0\r\n]/.test(p.cwd) ? p.cwd : undefined;
  return { agent: 'claude', sessionKey, pid: pid ?? null, cwd, kind: 'session', name: String(p.event), at: new Date(now).toISOString() };
}
export function parseStatusline(payload: unknown, now = Date.now()): SafeEvent | null {
  const p = object(payload), sessionKey = name(p.session_id);
  if (!sessionKey) return null;
  const context = object(p.context_window), usage = object(p.current_usage ?? context.current_usage), rates = object(p.rate_limits);
  const pct = (value: unknown) => { const n = number(value); return n === undefined ? null : Math.min(100, n); };
  const reset = (value: unknown) => { const n = number(value); return n !== undefined && n < 8640000000000 ? new Date(n * 1000).toISOString() : null; };
  const snapshot: ContextSnapshot = {
    usedPct: pct(context.used_percentage), window: number(context.context_window_size) ?? null,
    input: number(usage.input_tokens) ?? null, cacheRead: number(usage.cache_read_input_tokens) ?? null, cacheCreation: number(usage.cache_creation_input_tokens) ?? null,
    rate5hPct: pct(object(rates.five_hour).used_percentage), rate5hResetsAt: reset(object(rates.five_hour).resets_at),
    rate7dPct: pct(object(rates.seven_day).used_percentage), rate7dResetsAt: reset(object(rates.seven_day).resets_at), observedAt: new Date(now).toISOString(),
  };
  return { agent: 'claude', sessionKey, kind: 'context', name: 'statusline', model: name(object(p.model).id), context: snapshot, key: 'cost', value: number(object(p.cost).total_cost_usd), cumulative: true, exceeds200k: bool(p.exceeds_200k_tokens), at: snapshot.observedAt };
}
