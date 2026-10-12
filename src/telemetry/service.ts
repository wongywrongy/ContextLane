import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { Catalog } from '../catalog/discovery.js';
import { inside } from '../config.js';
import type { Store } from '../state/store.js';
import { Problem, type Project } from '../shared/contracts.js';
import type { AgentObservation } from '../host/types.js';
import { parseOtlp, parseSession, parseStatusline, name } from './parse.js';
import type { SafeEvent, SessionAggregate, RootlaneToolCall, TelemetryConfig } from './types.js';

type MemorySession = { aggregate: SessionAggregate; internal: Record<string, number>; samples: Map<string, { seen: number; values: number[] }>; metric: Map<string, { value: number; startTime?: string }>; metricTokens: Set<string>; hookCwd?: string; hookStartedAt?: string };
const iso = (now = Date.now()) => new Date(now).toISOString();
export function percentile(values: number[], pct: number) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * pct) - 1)]; }
function emptySession(agent: 'claude' | 'codex', sessionKey: string, at: string): SessionAggregate {
  return { id: `${agent}:${sessionKey}`, agent, sessionKey, pid: null, cwd: null, projectId: null, match: 'Process only', model: null, effort: null, mode: null, startedAt: at, lastSeenAt: at, endedAt: null, counters: {}, tools: [], toolkit: [], context: null, requestLatency: { p50Ms: null, p95Ms: null }, rootlaneTools: [] };
}
export function projectForCwd(cwd: string | null, projects: Project[]) { return cwd ? [...projects].sort((a, b) => b.path.length - a.path.length).find(p => inside(cwd, p.path)) : undefined; }
export function matchSessions(sessions: SessionAggregate[], processes: AgentObservation[], projects: Project[], now = Date.now()) {
  const matched = new Set<number>();
  for (const s of sessions) {
    if (s.agent !== 'claude') continue;
    const observed = processes.find(p => p.pid === s.pid && p.name === 'Claude Code' && (!p.startedAt || Date.parse(p.startedAt) <= Date.parse(s.startedAt)));
    s.match = observed ? 'Matched' : 'Process only';
    if (observed?.pid) matched.add(observed.pid);
  }
  for (const s of sessions.filter(s => s.agent === 'codex').sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const candidates = processes.filter(p => p.name === 'Codex' && p.pid && !matched.has(p.pid) && p.startedAt && Date.parse(p.startedAt) <= Date.parse(s.startedAt));
    const candidate = candidates.length === 1 && !s.endedAt ? candidates[0] : undefined;
    s.pid = candidate?.pid ?? null;
    s.match = candidate ? 'Probable' : 'Process only';
    if (candidate?.pid) { matched.add(candidate.pid); s.cwd = candidate.cwd; }
  }
  for (const s of sessions) {
    const project = projectForCwd(s.cwd, projects);
    s.projectId = project?.id ?? null;
    // Catalog paths are existing process metadata; raw exporter file paths are never parsed.
    if (project) s.cwd = project.path;
    if (!processes.some(p => p.pid === s.pid) && now - Date.parse(s.lastSeenAt) > 15 * 60000) s.endedAt ??= s.lastSeenAt;
  }
  return matched;
}
export class Telemetry {
  server: FastifyInstance | null = null;
  private credential: string;
  private sessions = new Map<string, MemorySession>();
  private rootlaneTools = new Map<string, RootlaneToolCall>();
  private queue: SafeEvent[] = [];
  private draining = false;
  private dirty = new Set<string>();
  private removed = new Set<string>();
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private requestId = 0;
  private failedWrite = 0;
  private pending: Promise<void> | null = null;
  private resolvePending: (() => void) | null = null;
  private lastPrune = 0;
  private lastEventAt: string | null = null;
  private droppedByReason: Record<string, number> = {};
  private bindError: string | null = null;
  private budget = 100;
  private budgetAt = Date.now();
  private stopped = false;
  constructor(public config: TelemetryConfig, readonly store: Store, readonly catalog: Catalog, credential = '') {
    this.credential = credential;
    this.load();
  }
  private load() {
    const db = this.store.db;
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_sessions'").get()) return;
    const rows = db.prepare('SELECT * FROM agent_sessions ORDER BY last_seen_at DESC LIMIT 256').all() as Record<string, any>[];
    for (const row of rows) {
      const s = emptySession(row.agent, row.session_key, row.started_at);
      Object.assign(s, { id: row.id, pid: row.pid, cwd: row.cwd, projectId: row.project_id, match: row.match, model: row.model, effort: row.effort, mode: row.mode, lastSeenAt: row.last_seen_at, endedAt: row.ended_at });
      const stored = db.prepare('SELECT key,value FROM agent_session_counters WHERE session=?').all(s.id) as { key: string; value: number }[];
      s.counters = Object.fromEntries(stored.filter(r => !r.key.startsWith('internal.') && !r.key.startsWith('metric.')).map(r => [r.key, r.value]));
      const internal = Object.fromEntries(stored.filter(r => r.key.startsWith('internal.') || r.key.startsWith('metric.')).map(r => [r.key.startsWith('metric.') ? `internal.${r.key}` : r.key, r.value]));
      const metric: MemorySession['metric'] = new Map();
      for (const key of Object.keys(internal)) if (key.startsWith('internal.cumulative.') && key.endsWith('.value') && metric.size < 256) {
        const prefix = key.slice(0, -6);
        const startTime = internal[`${prefix}.hasStart`] ? String(BigInt(internal[`${prefix}.startHi`]) * 1000000000000000000n + BigInt(internal[`${prefix}.startMid`]) * 1000000000n + BigInt(internal[`${prefix}.startLo`])) : undefined;
        metric.set(prefix.slice('internal.cumulative.'.length), { value: internal[key], startTime });
      }
      s.requestLatency = { p50Ms: s.counters['latency.p50Ms'] ?? null, p95Ms: s.counters['latency.p95Ms'] ?? null };
      s.tools = db.prepare('SELECT tool,calls,failures,rejects,total_ms AS totalMs,p95_ms AS p95Ms FROM agent_session_tools WHERE session=?').all(s.id) as SessionAggregate['tools'];
      s.toolkit = db.prepare('SELECT kind,name,version,status,last_seen_at AS lastSeenAt FROM agent_session_toolkit WHERE session=?').all(s.id) as SessionAggregate['toolkit'];
      s.context = db.prepare('SELECT used_pct AS usedPct,window,input,cacheRead,cacheCreation,rate_5h_pct AS rate5hPct,rate_5h_resets_at AS rate5hResetsAt,rate_7d_pct AS rate7dPct,rate_7d_resets_at AS rate7dResetsAt,observed_at AS observedAt FROM agent_session_context WHERE session=?').get(s.id) as SessionAggregate['context'] ?? null;
      // shortcut: duration reservoirs restart with Rootlane, persist samples if cross-restart percentiles are required.
      this.sessions.set(s.id, { aggregate: s, internal, samples: new Map(), metric, metricTokens: new Set(Object.keys(internal).filter(k => k.startsWith('internal.metric.tokens.')).map(k => k.slice('internal.metric.'.length))), ...(s.agent === 'claude' && s.pid ? { hookStartedAt: s.startedAt } : {}) });
      if (!this.lastEventAt || s.lastSeenAt > this.lastEventAt) this.lastEventAt = s.lastSeenAt;
    }
    for (const row of db.prepare('SELECT pid,session,tool,calls,errors,last_at AS lastAt FROM rootlane_tool_calls').all() as RootlaneToolCall[]) this.rootlaneTools.set(`${row.pid}:${row.tool}`, row);
  }
  private drop(reason: string, count = 1) { this.droppedByReason[reason] = (this.droppedByReason[reason] ?? 0) + count; }
  private dropped() { return Object.values(this.droppedByReason).reduce((a, b) => a + b, 0); }
  private ensurePersistence() {
    if (!this.timer) this.timer = setInterval(() => { void this.flush().catch(() => this.drop('storage')); }, 2000).unref();
  }
  private enqueue(events: SafeEvent[]) {
    const available = Math.max(0, 4096 - this.queue.length);
    this.queue.push(...events.slice(0, available));
    if (events.length > available) this.drop('queue', events.length - available);
    this.ensurePersistence();
    if (!this.draining) { this.draining = true; setImmediate(() => this.drain()); }
  }
  private drain() {
    this.draining = false;
    const events = this.queue.splice(0);
    for (const event of events) this.aggregate(event);
  }
  private reservoir(memory: MemorySession, key: string, value: number) {
    const sample = memory.samples.get(key) ?? { seen: 0, values: [] };
    sample.seen++;
    if (sample.values.length < 256) sample.values.push(value);
    else { const index = Math.floor(Math.random() * sample.seen); if (index < 256) sample.values[index] = value; }
    memory.samples.set(key, sample);
    return sample.values;
  }
  private aggregate(event: SafeEvent) {
    const id = `${event.agent}:${event.sessionKey}`;
    let memory = this.sessions.get(id);
    if (!memory) {
      if (this.sessions.size >= 256) {
        const oldest = [...this.sessions.values()].map(m => m.aggregate).filter(s => s.endedAt).sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt))[0];
        if (!oldest) { this.drop('sessions'); return; }
        this.sessions.delete(oldest.id); this.dirty.delete(oldest.id); this.removed.add(oldest.id);
        for (const t of this.rootlaneTools.values()) if (t.session === oldest.id) t.session = null;
        this.drop('evicted');
      }
      memory = { aggregate: emptySession(event.agent, event.sessionKey, event.at), internal: {}, samples: new Map(), metric: new Map(), metricTokens: new Set() };
      this.sessions.set(id, memory);
      this.removed.delete(id);
    }
    const s = memory.aggregate;
    if (event.context && s.context && event.context.observedAt < s.context.observedAt) return;
    const newest = event.at >= s.lastSeenAt;
    if (!memory.hookStartedAt && event.at < s.startedAt) s.startedAt = event.at;
    if (event.at > s.lastSeenAt) s.lastSeenAt = event.at;
    this.lastEventAt = iso();
    if (newest && event.model) s.model = event.model;
    if (newest && event.effort) s.effort = event.effort;
    if (newest && event.mode) s.mode = event.mode;
    if (s.agent === 'codex' && s.endedAt && event.at > s.endedAt) s.endedAt = null;
    const add = (key: string, value = 1) => { if (key in s.counters || Object.keys(s.counters).length < 256) s.counters[key] = Math.min(Number.MAX_SAFE_INTEGER, (s.counters[key] ?? 0) + value); else this.drop('counters'); };
    if (event.kind === 'session') {
      s.pid = event.pid ?? null; memory.hookCwd = event.cwd ?? memory.hookCwd; s.endedAt = event.name === 'end' ? event.at : null;
      if (event.name === 'start') { s.startedAt = event.at; memory.hookStartedAt = event.at; }
    }
    if (event.context && (!s.context || event.context.observedAt >= s.context.observedAt)) s.context = event.context;
    if (event.exceeds200k !== undefined) s.counters.exceeds200kTokens = Number(event.exceeds200k);
    if (event.key && event.value !== undefined) {
      let value = event.value;
      const key = JSON.stringify([event.key, event.model ?? null]);
      if (event.cumulative && event.kind === 'metric') {
        const previous = memory.metric.get(key);
        const sameExporter = previous && previous.startTime === event.startTime;
        value = sameExporter ? Math.max(0, event.value - previous.value) : event.value;
        if (memory.metric.has(key) || memory.metric.size < 256) {
          const total = sameExporter ? Math.max(previous.value, event.value) : event.value;
          memory.metric.set(key, { value: total, startTime: event.startTime });
          const prefix = `internal.cumulative.${key}`, start = BigInt(event.startTime ?? '0');
          Object.assign(memory.internal, { [`${prefix}.value`]: total, [`${prefix}.hasStart`]: Number(event.startTime !== undefined), [`${prefix}.startHi`]: Number(start / 1000000000000000000n), [`${prefix}.startMid`]: Number(start / 1000000000n % 1000000000n), [`${prefix}.startLo`]: Number(start % 1000000000n) });
        }
        else { this.drop('counters'); value = 0; }
      }
      if (event.key.startsWith('tokens.') && !memory.metricTokens.has(event.key)) {
        s.counters[event.key] = 0;
        for (const k of Object.keys(s.counters)) if (k.startsWith(`${event.key}.model.`)) s.counters[k] = 0;
        memory.metricTokens.add(event.key);
        memory.internal[`internal.metric.${event.key}`] = 1;
      }
      if (event.kind === 'metric' && event.key === 'cost' && !memory.internal['internal.metric.cost']) { s.counters.cost = 0; memory.internal['internal.metric.cost'] = 1; }
      if (event.kind === 'context' && event.key === 'cost') { if (!memory.internal['internal.metric.cost']) s.counters.cost = event.value; }
      else add(event.key, value);
      if (event.model && event.key.startsWith('tokens.')) add(`${event.key}.model.${event.model}`, value);
    }
    if (event.kind === 'event') {
      if (event.name === 'api_request') { add('requests'); if (event.agent === 'codex' && (event.success === false || (event.status ?? 0) >= 400)) { add('errors'); if (event.status) add(`errors.${event.status}`); } }
      if (event.name === 'api_error') { add('errors'); if (event.status) add(`errors.${event.status}`); }
      if (event.name === 'api_refusal') add('refusals');
      if (event.name === 'compaction' && event.success === true) add('compactions');
      if (event.name === 'api_request' && event.duration !== undefined) { const values = this.reservoir(memory, 'requests', event.duration); s.requestLatency = { p50Ms: percentile(values, .5), p95Ms: percentile(values, .95) }; }
      if (event.name === 'api_request' || event.name === 'sse_event')
        for (const [type, count] of Object.entries(event.tokens ?? {})) if (count !== undefined && !memory.metricTokens.has(`tokens.${type}`)) { add(`tokens.${type}`, count); if (event.model) add(`tokens.${type}.model.${event.model}`, count); }
      if (event.tool && (event.name === 'tool_result' || event.name === 'tool_decision')) {
        let tool = s.tools.find(t => t.tool === event.tool);
        if (!tool && s.tools.length < 200) { tool = { tool: event.tool, calls: 0, failures: 0, rejects: 0, totalMs: 0, p95Ms: null }; s.tools.push(tool); }
        if (!tool) this.drop('tools');
        else if (event.name === 'tool_result') {
          tool.calls++; if (event.success === false) tool.failures++;
          if (event.duration !== undefined) { tool.totalMs += event.duration; tool.p95Ms = percentile(this.reservoir(memory, `tool:${tool.tool}`, event.duration), .95); }
        } else if (['reject', 'denied', 'abort', 'denied_with_network_policy_deny'].includes(event.decision ?? '')) tool.rejects++;
      }
      if (event.toolkit) {
        const old = s.toolkit.find(t => t.kind === event.toolkit!.kind && t.name === event.toolkit!.name);
        if (old && event.at >= old.lastSeenAt) Object.assign(old, event.toolkit, { lastSeenAt: event.at });
        else if (old) { /* Older exporter batches cannot reverse a newer connection state. */ }
        else if (s.toolkit.length < 64) s.toolkit.push({ ...event.toolkit, lastSeenAt: event.at });
        else this.drop('toolkit');
      }
    }
    this.dirty.add(id);
  }
  async start() {
    this.stopped = false;
    this.ensurePersistence();
    if (!this.config.enabled || this.server) return;
    if (!this.credential) { this.bindError = 'Set the ingest credential before enabling the receiver.'; return; }
    const server = Fastify({ logger: false, bodyLimit: 1024 * 1024, requestTimeout: 1000 });
    server.addHook('onRequest', async (request, reply) => {
      const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
      const expected = createHash('sha256').update(this.credential).digest(), actual = createHash('sha256').update(supplied).digest();
      if (!supplied || !timingSafeEqual(actual, expected)) { this.drop('unauthorized'); return reply.code(401).send({ message: 'Ingest credential required.' }); }
      const now = Date.now();
      this.budget = Math.min(100, this.budget + (now - this.budgetAt) * .05); this.budgetAt = now;
      if (this.budget < 1) { this.drop('rate'); return reply.code(429).header('Retry-After', '1').send({ message: 'Telemetry rate limit exceeded.' }); }
      this.budget--;
      if (request.url !== '/otlp/v1/traces' && !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) { this.drop('encoding'); return reply.code(415).send({ message: 'JSON only. Set OTEL_EXPORTER_OTLP_PROTOCOL to http/json.' }); }
    });
    server.setErrorHandler((error, _request, reply) => {
      const status = (error as { statusCode?: number }).statusCode ?? 400;
      this.drop(status === 413 ? 'body' : 'invalid');
      reply.code(status).send({ message: status === 413 ? 'Telemetry body exceeds 1 MiB.' : 'Invalid telemetry request.' });
    });
    for (const signal of ['metrics', 'logs'] as const) server.post(`/otlp/v1/${signal}`, async request => {
      const result = parseOtlp(request.body, signal);
      for (const [reason, count] of Object.entries(result.dropped)) this.drop(reason, count);
      this.enqueue(result.events);
      return {};
    });
    server.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, _body, done) => done(null, null));
    server.post('/otlp/v1/traces', async () => ({}));
    server.post('/hook/session', async (request, reply) => {
      const event = parseSession(request.body);
      if (!event) { this.drop('invalid'); return reply.code(400).send({ message: 'Invalid session hook.' }); }
      this.enqueue([event]); return {};
    });
    server.post('/hook/statusline', async (request, reply) => {
      const event = parseStatusline(request.body);
      if (!event) { this.drop('invalid'); return reply.code(400).send({ message: 'Invalid statusline hook.' }); }
      this.enqueue([event]); return {};
    });
    try {
      await server.listen({ port: this.config.port, host: '127.0.0.1' });
      const address = server.server.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error('Not loopback');
      this.server = server; this.bindError = null;
    } catch { await server.close(); this.bindError = 'Receiver could not bind to 127.0.0.1. Choose an unused port distinct from the main listener.'; }
  }
  async reconfigure(config: TelemetryConfig, credential = this.credential) {
    if (this.server && (!config.enabled || config.port !== this.config.port || credential !== this.credential)) { await this.server.close(); this.server = null; }
    this.config = config; this.credential = credential;
    await this.start();
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    try {
      if (this.server) await this.server.close(); this.server = null;
      if (this.pending) await this.pending;
      if (this.worker || this.dirty.size || this.removed.size || this.rootlaneTools.size || this.queue.length) await this.flush();
    } finally {
      if (this.worker) await this.worker.terminate(); this.worker = null;
    }
  }
  contextForPid(pid: number) {
    const s = [...this.sessions.values()].map(m => m.aggregate).filter(s => s.pid === pid && ['Matched', 'Probable'].includes(s.match) && !s.endedAt && s.context && Date.now() - Date.parse(s.context.observedAt) <= 120000).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
    return s?.context?.usedPct ?? undefined;
  }
  private async match() {
    this.drain();
    const [projects, observed] = await Promise.all([this.catalog.projects(), this.catalog.host.agents()]);
    for (const memory of this.sessions.values()) if (memory.hookCwd ?? memory.aggregate.cwd) {
      const actual = await realpath((memory.hookCwd ?? memory.aggregate.cwd)!).catch(() => null);
      memory.aggregate.cwd = actual ? projectForCwd(actual, projects)?.path ?? null : null;
    }
    matchSessions([...this.sessions.values()].map(m => m.aggregate), observed.agents, projects);
    for (const m of this.sessions.values()) this.dirty.add(m.aggregate.id);
    return { projects, observed: observed.agents };
  }
  async getSessions(projectId: string) {
    const { projects, observed } = await this.match();
    const requested = projects.find(p => p.id === projectId);
    if (!requested) throw new Problem('NOT_FOUND', 'Project is no longer in the observed catalog');
    const relevant = projects.filter(p => p.id === projectId || (requested?.gitCommonDir && p.gitCommonDir === requested.gitCommonDir) || (requested && inside(p.path, requested.path)));
    const ids = new Set(relevant.map(p => p.id));
    const sessions = [...this.sessions.values()].map(m => m.aggregate).filter(s => s.projectId && ids.has(s.projectId));
    for (const s of sessions) s.rootlaneTools = [...this.rootlaneTools.values()].filter(t => t.pid === s.pid).map(t => ({ ...t, session: s.id }));
    for (const process of observed) {
      if (!process.pid || !ids.has(projectForCwd(process.cwd, projects)?.id ?? '') || sessions.some(s => s.pid === process.pid && !s.endedAt && s.match !== 'Process only')) continue;
      const s = emptySession(process.name === 'Codex' ? 'codex' : 'claude', '', process.startedAt ?? iso());
      s.id = `process:${process.pid}`; s.pid = process.pid; s.cwd = projectForCwd(process.cwd, projects)?.path ?? null; s.projectId = projectForCwd(process.cwd, projects)?.id ?? null;
      s.rootlaneTools = [...this.rootlaneTools.values()].filter(t => t.pid === process.pid);
      sessions.push(s);
    }
    return { sessions: structuredClone(sessions.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))), telemetry: { enabled: this.config.enabled, receiving: !!this.server, lastEventAt: this.lastEventAt, dropped: this.dropped() } };
  }
  async status() {
    const { observed } = await this.match();
    const reporting = { claude: 0, codex: 0 }, reported = new Set<number>();
    for (const { aggregate: s } of this.sessions.values()) if (!s.endedAt && Date.now() - Date.parse(s.lastSeenAt) <= 120000) { reporting[s.agent]++; if (s.pid && s.match !== 'Process only') reported.add(s.pid); }
    return { enabled: this.config.enabled, receiving: !!this.server, bind: '127.0.0.1' as const, port: this.config.port, endpoint: `http://127.0.0.1:${this.config.port}/otlp`, protocol: 'http/json' as const, credentialSet: !!this.credential, retentionDays: this.config.retentionDays, lastEventAt: this.lastEventAt, dropped: this.dropped(), droppedByReason: { ...this.droppedByReason }, reporting, notReporting: observed.filter(p => p.pid && !reported.has(p.pid)).length, bindError: this.bindError };
  }
  recordRootlaneCall(pid: number, tool: string, error = false) {
    if (!Number.isInteger(pid) || pid <= 0 || !name(tool)) return;
    const key = `${pid}:${tool}`, old = this.rootlaneTools.get(key);
    if (!old && this.rootlaneTools.size >= 256 * 200) { this.drop('rootlaneTools'); return; }
    const session = [...this.sessions.values()].map(m => m.aggregate).filter(s => s.pid === pid && !s.endedAt && s.match !== 'Process only').sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
    this.rootlaneTools.set(key, { pid, session: session?.id ?? null, tool, calls: (old?.calls ?? 0) + 1, errors: (old?.errors ?? 0) + Number(error), lastAt: iso() });
    this.ensurePersistence();
  }
  async prune(now = Date.now()) {
    this.drain();
    const cutoff = iso(now - this.config.retentionDays * 86400000);
    for (const [id, memory] of this.sessions) if (memory.aggregate.lastSeenAt < cutoff) { this.sessions.delete(id); this.dirty.delete(id); this.removed.add(id); }
    for (const [key, row] of this.rootlaneTools) { if (row.lastAt < cutoff) this.rootlaneTools.delete(key); else if (row.session && !this.sessions.has(row.session)) row.session = null; }
    this.lastPrune = now;
    await this.persist({ pruneBefore: cutoff });
  }
  async purge() {
    this.queue = []; this.sessions.clear(); this.rootlaneTools.clear(); this.dirty.clear(); this.removed.clear(); this.lastEventAt = null;
    await this.persist({ purge: true });
  }
  private async persist(extra: { pruneBefore?: string; purge?: boolean } = {}) {
    if (!extra.purge && this.sessions.size) await this.match();
    while (this.pending) await this.pending;
    if (!this.worker) {
      this.worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './writer.ts' : './writer.js', import.meta.url), { workerData: { path: this.store.db.name } });
      this.worker.on('message', (message: { id: number; ok: boolean }) => { if (message.id !== this.requestId) return; if (!message.ok) { this.failedWrite = message.id; this.drop('storage'); for (const id of this.sessions.keys()) this.dirty.add(id); } this.worker?.unref(); this.resolvePending?.(); this.resolvePending = null; this.pending = null; });
      this.worker.on('error', () => { this.failedWrite = this.requestId; this.drop('storage'); for (const id of this.sessions.keys()) this.dirty.add(id); this.resolvePending?.(); this.resolvePending = null; this.pending = null; this.worker = null; });
    }
    const sessions = [...this.dirty].flatMap(id => { const memory = this.sessions.get(id); return memory ? [{ ...memory.aggregate, counters: { ...memory.aggregate.counters, ...memory.internal } }] : []; });
    this.dirty.clear();
    const removed = [...this.removed]; this.removed.clear();
    this.pending = new Promise(resolve => this.resolvePending = resolve);
    const id = ++this.requestId;
    this.worker.ref();
    this.worker.postMessage({ id, sessions, tools: [...this.rootlaneTools.values()], removed, ...extra });
    await this.pending;
    if (this.failedWrite === id) {
      for (const old of removed) if (!this.sessions.has(old)) this.removed.add(old);
      throw new Error('Telemetry storage unavailable. Counts remain queued in memory.');
    }
  }
  async flush() {
    if (this.pending) { await this.pending; return; }
    this.drain();
    if (Date.now() - this.lastPrune >= 3600000) { await this.prune(); return; }
    if (this.dirty.size || this.removed.size || this.rootlaneTools.size) await this.persist();
  }
}
