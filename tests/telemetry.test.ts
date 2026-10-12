import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import Database from 'better-sqlite3';
import { Store } from '../src/state/store.js';
import { Telemetry, matchSessions, percentile, projectForCwd } from '../src/telemetry/service.js';
import { parseOtlp } from '../src/telemetry/parse.js';
import type { Catalog } from '../src/catalog/discovery.js';
import { project, agentSessionsOutput } from '../src/shared/contracts.js';
import type { AgentObservation } from '../src/host/types.js';

const auth = { authorization: 'Bearer ingest-only', 'content-type': 'application/json' };
const attrs = (values: Record<string, unknown>) => Object.entries(values).map(([key, value]) => ({ key, value: typeof value === 'boolean' ? { boolValue: value } : typeof value === 'number' ? { doubleValue: value } : { stringValue: value } }));
const log = (event: string, values: Record<string, unknown> = {}, session = 'session-one') => ({ attributes: attrs({ 'session.id': session, 'event.name': event, ...values }) });
const logs = (records: unknown[], service = 'claude-code') => ({ resourceLogs: [{ resource: { attributes: attrs({ 'service.name': service }) }, scopeLogs: [{ logRecords: records }] }] });
const metrics = (points: { name: string; value: number; type?: string; model?: string }[]) => ({ resourceMetrics: [{ resource: { attributes: attrs({ 'service.name': 'claude-code' }) }, scopeMetrics: [{ metrics: points.map(p => ({ name: p.name, sum: { aggregationTemporality: 1, dataPoints: [{ asDouble: p.value, attributes: attrs({ 'session.id': 'session-one', type: p.type, model: p.model }) }] } })) }] }] });
async function fixture(t: TestContext, enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'rootlane-telemetry-'));
  const store = new Store(join(root, 'state.sqlite'));
  const projects = [project.parse({ id: 'test-project', name: 'Test', path: root, gitCommonDir: null, branch: null, detached: false, manifests: [], links: [], agents: [], environmentIds: [], runtime: { services: [], status: 'no associated listener', ports: [], ownership: 'observe-only' } })];
  const observed: AgentObservation[] = [];
  const catalog = { projects: async () => projects, host: { agents: async () => ({ agents: observed, warnings: [] }) } } as unknown as Catalog;
  const telemetry = new Telemetry({ enabled, port: 0, retentionDays: 7 }, store, catalog, 'ingest-only');
  await telemetry.start();
  t.after(async () => { await telemetry.stop(); store.close(); await rm(root, { recursive: true, force: true }); });
  const post = (url: string, payload: unknown, headers = auth) => telemetry.server!.inject({ method: 'POST', url, headers, payload: typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload) });
  const start = (sessionId = 'session-one', pid: number | null = 101, cwd = root, event = 'start') => post('/hook/session', { agent: 'claude', sessionId, pid, cwd, event });
  return { root, store, catalog, telemetry, projects, observed, post, start };
}
test('receiver binds loopback, accepts only ingest, enforces JSON/body/rate limits and ignores traces', async t => {
  const { telemetry, post } = await fixture(t);
  const address = telemetry.server!.server.address();
  assert.equal(typeof address === 'object' && address?.address, '127.0.0.1');
  for (const token of ['', 'owner-token', 'agent-token']) {
    const result = await post('/otlp/v1/logs', logs([]), { ...auth, authorization: token ? `Bearer ${token}` : '' });
    assert.equal(result.statusCode, 401);
  }
  const accepted = await post('/otlp/v1/logs', logs([]));
  assert.equal(accepted.statusCode, 200); assert.deepEqual(accepted.json(), {});
  const protobuf = await post('/otlp/v1/metrics', Buffer.from([0, 1, 2]), { ...auth, 'content-type': 'application/x-protobuf' });
  assert.equal(protobuf.statusCode, 415); assert.match(protobuf.json().message, /http\/json/);
  const traces = await post('/otlp/v1/traces', Buffer.from([0, 1, 2]), { ...auth, 'content-type': 'application/x-protobuf' });
  assert.equal(traces.statusCode, 200); assert.deepEqual(traces.json(), {});
  assert.equal((await post('/otlp/v1/logs', JSON.stringify({ big: 'x'.repeat(1024 * 1024) }))).statusCode, 413);
  let limited = 0;
  for (let i = 0; i < 160; i++) if ((await post('/otlp/v1/logs', logs([]))).statusCode === 429) limited++;
  assert.ok(limited > 0);
  assert.ok((await telemetry.status()).droppedByReason.rate > 0);
});
test('receiver disabled has no listener; bind failure is reported without failing the host', async t => {
  const { telemetry } = await fixture(t, false);
  assert.equal(telemetry.server, null);
  const blocker = net.createServer();
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => blocker.close(() => resolve())));
  const address = blocker.address() as net.AddressInfo;
  await telemetry.reconfigure({ ...telemetry.config, enabled: true, port: address.port });
  assert.equal(telemetry.server, null);
  assert.match((await telemetry.status()).bindError!, /unused port/);
});
test('privacy: content, identity, log bodies, headers and untrusted cwd never reach SQLite bytes', async t => {
  const { root, telemetry, store, post, start } = await fixture(t);
  const sentinel = 'PRIVATE_CONTENT_SENTINEL_7f74';
  const cwd = join(root, 'PRIVATE_PATH_SENTINEL_8290'); await mkdir(cwd);
  const keys = ['prompt', 'prompt_length', 'response', 'tool_input', 'tool_parameters', 'bash_command', 'full_command', 'file.path', 'error', 'user.email', 'user.account_uuid', 'organization.id', 'terminal.type'];
  const forbidden = Object.fromEntries(keys.map(key => [key, `${sentinel}_${key}`]));
  await start('session-one', null, cwd);
  await post('/otlp/v1/logs', logs([
    { ...log('api_request', { model: 'claude-sonnet-4', input_tokens: 30, ...forbidden }), body: { stringValue: sentinel } },
    log('tool_result', { tool_name: 'Read', success: false, duration_ms: 20, ...forbidden }),
    log('user_prompt', forbidden),
  ]), { ...auth, 'x-private-sentinel': sentinel } as typeof auth);
  await post('/hook/statusline', { session_id: 'session-one', model: { id: 'claude-sonnet-4', display_name: sentinel }, context_window: { used_percentage: 50, context_window_size: 200000 }, prompt: sentinel });
  await telemetry.flush();
  assert.equal((store.db.prepare('SELECT cwd FROM agent_sessions').get() as { cwd: string }).cwd, root);
  store.db.pragma('wal_checkpoint(TRUNCATE)');
  for (const suffix of ['', '-wal']) {
    const bytes = await readFile(join(root, `state.sqlite${suffix}`)).catch(() => Buffer.alloc(0));
    for (const secret of [sentinel, 'PRIVATE_PATH_SENTINEL_8290', 'ingest-only']) assert.equal(bytes.includes(Buffer.from(secret)), false, `${secret} leaked to SQLite${suffix}`);
  }
  const rows = store.db.prepare('SELECT key,value FROM agent_session_counters').all() as { key: string; value: number }[];
  assert.equal(rows.find(r => r.key === 'tokens.input')?.value, 30);
  assert.equal((await telemetry.status()).droppedByReason.prompt, 1);
});
test('tokens aggregate by type/model without counting event and metric copies twice', async t => {
  const { telemetry, post, start } = await fixture(t);
  await start();
  await post('/otlp/v1/logs', logs([log('api_request', { model: 'claude-sonnet-4', input_tokens: 10, output_tokens: 3 })]));
  await post('/otlp/v1/metrics', metrics([
    { name: 'claude_code.token.usage', value: 10, type: 'input', model: 'claude-sonnet-4' },
    { name: 'claude_code.token.usage', value: 3, type: 'output', model: 'claude-sonnet-4' },
    { name: 'claude_code.token.usage', value: 12, type: 'cacheRead', model: 'claude-sonnet-4' },
    { name: 'claude_code.token.usage', value: 5, type: 'cacheCreation', model: 'claude-sonnet-4' },
    { name: 'claude_code.token.usage', value: 7, type: 'input', model: 'claude-opus-4' },
    { name: 'claude_code.cost.usage', value: .02 },
    { name: 'claude_code.lines_of_code.count', value: 4, type: 'added' },
    { name: 'claude_code.lines_of_code.count', value: 2, type: 'removed' },
    { name: 'claude_code.commit.count', value: 1 },
    { name: 'claude_code.pull_request.count', value: 1 },
  ]));
  const { sessions } = agentSessionsOutput.parse(await telemetry.getSessions('test-project'));
  const counters = sessions[0].counters;
  assert.equal(counters['tokens.input'], 17); assert.equal(counters['tokens.output'], 3);
  assert.equal(counters['tokens.cacheRead'], 12); assert.equal(counters['tokens.cacheCreation'], 5);
  assert.equal(counters['tokens.input.model.claude-sonnet-4'], 10); assert.equal(counters['tokens.input.model.claude-opus-4'], 7);
  assert.equal(counters['lines.added'], 4); assert.equal(counters['lines.removed'], 2);
  assert.equal(counters.commits, 1); assert.equal(counters.pullRequests, 1); assert.equal(counters.cost, .02);
  await post('/hook/statusline', { session_id: 'session-one', cost: { total_cost_usd: 99 } });
  assert.equal((await telemetry.getSessions('test-project')).sessions[0].counters.cost, .02);
});
test('cumulative metric baselines survive restart, ignore late totals and reset only for a new exporter', async t => {
  const { telemetry, post, start, store, catalog } = await fixture(t);
  const cumulative = (value: number, startTime: string) => {
    const payload = metrics([{ name: 'claude_code.token.usage', value, type: 'input', model: 'claude-sonnet-4' }]);
    const sum = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum;
    sum.aggregationTemporality = 2;
    Object.assign(sum.dataPoints[0], { startTimeUnixNano: startTime });
    return payload;
  };
  const firstExporter = '1760000000123456789', nextExporter = '1760000050123456789';
  await start(); await post('/otlp/v1/metrics', cumulative(100, firstExporter));
  assert.equal((await telemetry.getSessions('test-project')).sessions[0].counters['tokens.input'], 100);
  await telemetry.flush(); await telemetry.stop();
  const restarted = new Telemetry(telemetry.config, store, catalog, 'ingest-only');
  await restarted.start();
  try {
    for (const [value, exporter, expected] of [[100, firstExporter, 100], [120, firstExporter, 120], [110, firstExporter, 120], [120, firstExporter, 120], [5, nextExporter, 125]] as const) {
      assert.equal((await restarted.server!.inject({ method: 'POST', url: '/otlp/v1/metrics', headers: auth, payload: cumulative(value, exporter) })).statusCode, 200);
      const session = (await restarted.getSessions('test-project')).sessions[0];
      assert.equal(session.counters['tokens.input'], expected);
      assert.equal(session.counters['tokens.input.model.claude-sonnet-4'], expected);
      assert.equal(Object.keys(session.counters).some(key => key.startsWith('internal.') || key.startsWith('metric.')), false);
    }
    await restarted.flush();
    assert.ok((store.db.prepare("SELECT count(*) AS n FROM agent_session_counters WHERE key LIKE 'internal.cumulative.%'").get() as { n: number }).n > 0);
  } finally { await restarted.stop(); }
});
test('an older context snapshot cannot replace the current context or its fallback cost', async t => {
  const { telemetry, post, start, store, catalog } = await fixture(t);
  await start();
  await post('/hook/statusline', { session_id: 'session-one', context_window: { used_percentage: 71, context_window_size: 200000 }, cost: { total_cost_usd: 12 }, exceeds_200k_tokens: true });
  await telemetry.flush(); await telemetry.stop();
  // A wall clock correction makes the next snapshot older than the already persisted one.
  store.db.prepare('UPDATE agent_session_context SET observed_at=?').run(new Date(Date.now() + 60000).toISOString());
  const restarted = new Telemetry(telemetry.config, store, catalog, 'ingest-only');
  await restarted.start();
  try {
    await restarted.server!.inject({ method: 'POST', url: '/hook/statusline', headers: auth, payload: { session_id: 'session-one', context_window: { used_percentage: 10, context_window_size: 200000 }, cost: { total_cost_usd: 1 }, exceeds_200k_tokens: false } });
    const session = (await restarted.getSessions('test-project')).sessions[0];
    assert.equal(session.context?.usedPct, 71);
    assert.equal(session.counters.cost, 12);
    assert.equal(session.counters.exceeds200kTokens, 1);
  } finally { await restarted.stop(); }
});
test('tool calls keep failures/rejects/p95, toolkit transitions and latest context only', async t => {
  const { telemetry, post, start, store } = await fixture(t);
  await start();
  await post('/otlp/v1/logs', logs([
    ...Array.from({ length: 100 }, (_, i) => log('tool_result', { tool_name: 'Read', success: i !== 0, duration_ms: i + 1 })),
    log('tool_decision', { tool_name: 'Read', decision: 'reject' }),
    log('mcp_server_connection', { server_name: 'rootlane', status: 'connected' }),
    log('mcp_server_connection', { server_name: 'rootlane', status: 'failed', error: 'DO_NOT_STORE_ERROR' }),
    log('skill_activated', { 'skill.name': 'ponytail' }),
    log('plugin_loaded', { 'plugin.name': 'cloudflare', 'plugin.version': '1.0.2' }),
    log('api_request', { duration_ms: 20 }), log('api_request', { duration_ms: 100 }),
    log('api_error', { status_code: 429, error: 'DO_NOT_STORE_ERROR' }),
    log('compaction', { success: true, pre_tokens: 90000 }), log('api_refusal'),
  ]));
  for (const pct of [30, 71]) await post('/hook/statusline', { session_id: 'session-one', context_window: { used_percentage: pct, context_window_size: 200000 }, current_usage: { input_tokens: 1000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 1000 }, rate_limits: { five_hour: { used_percentage: 25, resets_at: 2000000000 }, seven_day: { used_percentage: 50, resets_at: 2000000010 } } });
  const session = (await telemetry.getSessions('test-project')).sessions[0];
  assert.deepEqual(session.tools[0], { tool: 'Read', calls: 100, failures: 1, rejects: 1, totalMs: 5050, p95Ms: 95 });
  assert.equal(session.toolkit.find(t => t.kind === 'mcp')?.status, 'failed');
  assert.equal(session.toolkit.find(t => t.kind === 'plugin')?.version, '1.0.2');
  assert.equal(session.context?.usedPct, 71); assert.equal(session.context?.rate5hPct, 25);
  assert.deepEqual(session.requestLatency, { p50Ms: 20, p95Ms: 100 });
  assert.equal(session.counters['errors.429'], 1); assert.equal(session.counters.compactions, 1); assert.equal(session.counters.refusals, 1);
  await telemetry.flush();
  assert.equal((store.db.prepare('SELECT count(*) AS n FROM agent_session_context').get() as { n: number }).n, 1);
  assert.equal((store.db.prepare('SELECT used_pct FROM agent_session_context').get() as { used_pct: number }).used_pct, 71);
});
test('unknown services, excessive tools/toolkit and session capacity are dropped and counted', async t => {
  const { telemetry, post, start } = await fixture(t);
  await start();
  await post('/otlp/v1/logs', logs([log('api_request')], 'unrelated-service'));
  await post('/otlp/v1/logs', logs([
    ...Array.from({ length: 201 }, (_, i) => log('tool_result', { tool_name: `tool-${i}`, success: true })),
    ...Array.from({ length: 65 }, (_, i) => log('skill_activated', { 'skill.name': `skill-${i}` })),
    ...Array.from({ length: 255 }, (_, i) => log('api_request', {}, `other-${i}`)),
  ]));
  await post('/otlp/v1/logs', logs([log('api_request', {}, 'over-limit')]));
  let status = await telemetry.status();
  assert.equal(status.droppedByReason.service, 1); assert.equal(status.droppedByReason.tools, 1);
  assert.equal(status.droppedByReason.toolkit, 1); assert.equal(status.droppedByReason.sessions, 1);
  const session = (await telemetry.getSessions('test-project')).sessions[0];
  assert.equal(session.tools.length, 200); assert.equal(session.toolkit.length, 64);
  await start('session-one', 101, undefined, 'end');
  await post('/otlp/v1/logs', logs([log('api_request', {}, 'over-limit')]));
  status = await telemetry.status();
  assert.equal(status.droppedByReason.evicted, 1);
  assert.equal((await telemetry.getSessions('test-project')).sessions.some(s => s.sessionKey === 'session-one'), false);
});
test('matching needs a real Claude PID or exactly one earlier Codex process; delayed events do not match newer processes', async t => {
  const { telemetry, observed, root, post, start, projects } = await fixture(t);
  const before = new Date(Date.now() - 60000).toISOString();
  observed.push({ id: 'claude', name: 'Claude Code', pid: 101, cwd: root, startedAt: before }, { id: 'codex', name: 'Codex', pid: 202, cwd: root, startedAt: before });
  await start();
  await post('/otlp/v1/logs', logs([{ attributes: attrs({ 'conversation.id': 'conversation-one', 'event.name': 'codex.conversation_starts', model: 'gpt-5.4', reasoning_effort: 'high', approval_policy: 'on-request', sandbox_policy: 'workspace-write' }) }], 'codex_cli_rs'));
  let sessions = (await telemetry.getSessions('test-project')).sessions;
  assert.equal(sessions.find(s => s.agent === 'claude')?.match, 'Matched');
  assert.equal(sessions.find(s => s.agent === 'codex')?.match, 'Probable');
  observed.push({ id: 'codex2', name: 'Codex', pid: 203, cwd: root, startedAt: before });
  sessions = (await telemetry.getSessions('test-project')).sessions;
  assert.equal(sessions.find(s => s.sessionKey === 'conversation-one')?.match, 'Process only');
  assert.equal(sessions.find(s => s.sessionKey === 'conversation-one')?.pid, null);
  assert.equal(sessions.filter(s => s.id.startsWith('process:')).length, 2);
  assert.equal(projectForCwd(join(root, 'nested'), projects)?.id, 'test-project');
  const earlier = Date.now() - 120000;
  const parsed = parseOtlp(logs([{ timeUnixNano: String(BigInt(earlier) * 1000000n), attributes: attrs({ 'conversation.id': 'delayed', 'event.name': 'codex.conversation_starts' }) }], 'codex_cli_rs'), 'logs');
  assert.equal(parsed.events[0].at, new Date(earlier).toISOString());
  const delayed = { ...sessions.find(s => s.sessionKey === 'conversation-one')!, id: 'codex:delayed', startedAt: parsed.events[0].at, lastSeenAt: parsed.events[0].at };
  matchSessions([delayed], [observed[1]], projects);
  assert.equal(delayed.match, 'Process only');
  assert.equal(delayed.pid, null);
  observed.splice(0, observed.length);
  const stale = { ...delayed, endedAt: null, lastSeenAt: new Date(Date.now() - 16 * 60000).toISOString() };
  matchSessions([stale], [], projects);
  assert.equal(stale.endedAt, stale.lastSeenAt);
});
test('Codex exact completed SSE fields provide tokens and API errors are status counts only', async t => {
  const { telemetry, post, observed, root } = await fixture(t);
  observed.push({ id: 'codex', name: 'Codex', pid: 202, cwd: root, startedAt: new Date(Date.now() - 60000).toISOString() });
  const codexLog = (event: string, fields: Record<string, unknown>) => ({ attributes: attrs({ 'conversation.id': 'conversation-one', 'event.name': `codex.${event}`, ...fields }) });
  await post('/otlp/v1/logs', logs([
    codexLog('conversation_starts', { model: 'gpt-5.4', reasoning_effort: 'high' }),
    codexLog('api_request', { duration_ms: '123', 'http.response.status_code': 429, success: 'false', error: 'PRIVATE_ERROR' }),
    codexLog('sse_event', { 'event.kind': 'response.completed', input_token_count: '100', output_token_count: '20', cached_token_count: 40, cache_write_token_count: 5 }),
    codexLog('tool_result', { tool_name: 'exec_command', success: 'false', duration_ms: '15', output: 'PRIVATE_OUTPUT' }),
    codexLog('tool_decision', { tool_name: 'exec_command', decision: 'denied' }),
  ], 'codex_cli_rs'));
  const session = (await telemetry.getSessions('test-project')).sessions[0];
  assert.equal(session.counters['tokens.input'], 100); assert.equal(session.counters['tokens.output'], 20);
  assert.equal(session.counters['tokens.cacheRead'], 40); assert.equal(session.counters.requests, 1); assert.equal(session.counters['errors.429'], 1);
  assert.equal(session.tools[0].failures, 1); assert.equal(session.tools[0].rejects, 1);
});
test('a resumed Claude hook matches its new process across restart and rejects PID reuse', async t => {
  const { telemetry, post, start, observed, root, store, catalog } = await fixture(t);
  const original = Date.now() - 120000;
  observed.push({ id: 'old-claude', name: 'Claude Code', pid: 101, cwd: root, startedAt: new Date(original).toISOString() });
  await start();
  assert.equal((await telemetry.getSessions('test-project')).sessions.find(s => s.sessionKey === 'session-one')?.match, 'Matched');
  observed.splice(0, 1, { id: 'resumed-claude', name: 'Claude Code', pid: 303, cwd: root, startedAt: new Date(Date.now() - 1000).toISOString() });
  await start('session-one', 303);
  await post('/otlp/v1/logs', logs([{ ...log('api_request'), timeUnixNano: String(BigInt(original) * 1000000n) }]));
  let session = (await telemetry.getSessions('test-project')).sessions.find(s => s.sessionKey === 'session-one')!;
  assert.equal(session.match, 'Matched'); assert.equal(session.pid, 303); assert.ok(Date.parse(session.startedAt) > original);
  await telemetry.flush();
  const restored = new Telemetry({ ...telemetry.config, enabled: false }, store, catalog);
  const persisted = (await restored.getSessions('test-project')).sessions.find(s => s.sessionKey === 'session-one')!;
  assert.equal(persisted.match, 'Matched'); assert.equal(persisted.startedAt, session.startedAt);
  await restored.stop();
  observed[0] = { ...observed[0], startedAt: new Date(Date.parse(session.startedAt) + 1000).toISOString() };
  session = (await telemetry.getSessions('test-project')).sessions.find(s => s.sessionKey === 'session-one')!;
  assert.equal(session.match, 'Process only');
});
test('Rootlane tool calls survive telemetry off, persist for process-only agents and purge/prune cascade', async t => {
  const { telemetry, observed, root, store, start, post } = await fixture(t);
  observed.push({ id: 'claude', name: 'Claude Code', pid: 101, cwd: root, startedAt: new Date(Date.now() - 60000).toISOString() });
  await start();
  await post('/otlp/v1/logs', logs([log('tool_result', { tool_name: 'Read', success: true })]));
  await telemetry.getSessions('test-project');
  telemetry.recordRootlaneCall(101, 'get_project', true);
  await telemetry.flush();
  assert.equal((store.db.prepare('SELECT session FROM rootlane_tool_calls').get() as { session: string }).session, 'claude:session-one');
  await telemetry.reconfigure({ ...telemetry.config, enabled: false });
  telemetry.recordRootlaneCall(101, 'get_project');
  assert.equal((await telemetry.getSessions('test-project')).telemetry.enabled, false);
  await Promise.all([telemetry.flush(), telemetry.flush()]);
  await telemetry.prune(Date.now() + 8 * 86400000);
  for (const table of ['agent_sessions', 'agent_session_tools', 'agent_session_counters', 'rootlane_tool_calls']) assert.equal((store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
  telemetry.recordRootlaneCall(101, 'get_project', true);
  const processOnly = (await telemetry.getSessions('test-project')).sessions[0];
  assert.equal(processOnly.match, 'Process only'); assert.equal(processOnly.rootlaneTools[0].errors, 1);
  await Promise.all([telemetry.flush(), telemetry.purge()]);
  assert.equal((store.db.prepare('SELECT count(*) AS n FROM rootlane_tool_calls').get() as { n: number }).n, 0);
  await assert.rejects(telemetry.getSessions('missing'), /no longer in the observed catalog/);
});
test('worker disk lock does not delay exporter responses', async t => {
  const { telemetry, post, start, root } = await fixture(t);
  await start();
  await telemetry.flush();
  const lock = new Database(join(root, 'state.sqlite'));
  t.after(() => lock.close());
  lock.exec('BEGIN IMMEDIATE');
  await post('/otlp/v1/logs', logs([log('api_request')]));
  const flushing = telemetry.flush();
  const beginning = performance.now();
  const accepted = await post('/otlp/v1/logs', logs([log('api_request')]));
  assert.equal(accepted.statusCode, 200); assert.ok(performance.now() - beginning < 200);
  await new Promise(resolve => setTimeout(resolve, 50));
  lock.exec('ROLLBACK');
  await flushing; await telemetry.flush();
  assert.equal((await telemetry.getSessions('test-project')).sessions[0].counters.requests, 2);
});
test('worker failures retain dirty aggregates for retry and concurrent purge completes last', async t => {
  const { telemetry, post, start, root, store } = await fixture(t);
  await start(); await telemetry.flush();
  const lock = new Database(join(root, 'state.sqlite'));
  t.after(() => lock.close());
  lock.exec('BEGIN IMMEDIATE');
  await post('/otlp/v1/logs', logs([log('api_request')]));
  await assert.rejects(telemetry.flush(), /storage unavailable/);
  lock.exec('ROLLBACK');
  await telemetry.flush();
  assert.equal((store.db.prepare("SELECT value FROM agent_session_counters WHERE key='requests'").get() as { value: number }).value, 1);
  assert.ok((await telemetry.status()).droppedByReason.storage >= 1);
  await Promise.all([telemetry.flush(), telemetry.purge()]);
  assert.equal((store.db.prepare('SELECT count(*) AS n FROM agent_sessions').get() as { n: number }).n, 0);
});
test('reservoir percentiles have stable nearest-rank behavior', () => {
  assert.equal(percentile([], .95), null);
  assert.equal(percentile([3, 1, 2], .5), 2);
  assert.equal(percentile([3, 1, 2], .95), 3);
});
