import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/http/server.js';
import { Catalog } from '../src/catalog/discovery.js';
import { Rootlane } from '../src/service.js';
import { configSchema } from '../src/config.js';
import { agentSessionsOutput, telemetryStatusOutput, toolContracts } from '../src/shared/contracts.js';
import { telemetrySetup } from '../src/telemetry/setup.js';
import { setup } from './helpers.js';

test('telemetry config defaults off, bounds retention and does not accept remote bind options', async t => {
  const { config } = await setup(t);
  const raw = { ...config, telemetry: undefined };
  assert.deepEqual(configSchema.parse(raw).telemetry, { enabled: false, port: 9481, retentionDays: 7 });
  assert.deepEqual(configSchema.parse({ ...raw, telemetry: { enabled: true } }).telemetry, { enabled: true, port: 9481, retentionDays: 7 });
  for (const telemetry of [{ retentionDays: 0 }, { retentionDays: 31 }, { port: 65536 }, { host: '0.0.0.0' }]) assert(!configSchema.safeParse({ ...raw, telemetry }).success);
});

test('ingest credential is rejected across the main listener; copy requires owner session and CSRF', async t => {
  const { config, lifecycle, host } = await setup(t);
  const credentials = { owner: 'owner', agent: 'a'.repeat(40), ingest: 'i'.repeat(40) };
  const service = new Rootlane(new Catalog(config, host), lifecycle);
  const app = await createServer(config, service, credentials);
  t.after(async () => { await app.close(); await service.telemetry.stop(); });
  const bearer = { host: `127.0.0.1:${config.port}`, authorization: `Bearer ${credentials.ingest}` };
  for (const url of ['/', '/api/session', '/api/status', '/api/tools/get_telemetry_status', '/api/telemetry/copy'])
    assert.equal((await app.inject({ method: url.includes('tools') || url.includes('copy') ? 'POST' : 'GET', url, headers: bearer, payload: url.includes('tools') ? {} : url.includes('copy') ? { kind: 'credential' } : undefined })).statusCode, 401, url);
  const headers = { host: new URL(config.origin).host, origin: config.origin };
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', headers, payload: { credential: credentials.ingest } })).statusCode, 401);
  const agentHeaders = { ...bearer, authorization: `Bearer ${credentials.agent}` };
  assert.equal((await app.inject({ method: 'POST', url: '/api/telemetry/copy', headers: agentHeaders, payload: { kind: 'credential' } })).statusCode, 403);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 1000 });
  const login = await app.inject({ method: 'POST', url: '/api/login', headers, payload: { credential: credentials.owner } });
  const session = { ...headers, cookie: String(login.headers['set-cookie']).split(';')[0] };
  const request = { method: 'POST' as const, url: '/api/telemetry/copy', payload: { kind: 'credential' } };
  assert.equal((await app.inject({ ...request, headers: session })).statusCode, 403);
  const copied = await app.inject({ ...request, headers: { ...session, 'x-rootlane-csrf': login.json().csrf } });
  assert.equal(copied.json().value, credentials.ingest);
  assert.equal(copied.headers['cache-control'], 'no-store');
  const status = await app.inject({ method: 'POST', url: '/api/tools/get_telemetry_status', headers: agentHeaders, payload: {} });
  assert.equal(status.statusCode, 200); telemetryStatusOutput.parse(status.json());
  assert(!status.body.includes(credentials.ingest)); assert(!status.body.includes(credentials.agent));
  for (const ingest of [credentials.owner, credentials.agent, 'short']) await assert.rejects(createServer(config, service, { ...credentials, ingest }), /credential/);
});

test('shared read tools expose process-only Rootlane calls even when telemetry is off', async t => {
  const { config, lifecycle, host, root, store } = await setup(t);
  const now = new Date().toISOString();
  host.agentObservations.agents = [{ id: 'a'.repeat(24), name: 'Claude Code', pid: 12345, cwd: root, startedAt: now }];
  const service = new Rootlane(new Catalog(config, host, store), lifecycle);
  const app = await createServer(config, service, { owner: 'owner', agent: 'a'.repeat(40) });
  t.after(async () => { await app.close(); await service.telemetry.stop(); });
  const headers = { host: `127.0.0.1:${config.port}`, authorization: `Bearer ${'a'.repeat(40)}`, 'x-rootlane-parent-pid': '12345' };
  const catalog = await service.catalog.projects(); const projectId = catalog.find(p => p.path === root)!.id;
  assert.equal((await app.inject({ method: 'POST', url: '/api/tools/get_project', headers, payload: { projectId } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/tools/get_project', headers, payload: { projectId: 'missing' } })).statusCode, 404);
  const result = agentSessionsOutput.parse(await service.call('get_agent_sessions', { projectId }));
  const process = result.sessions.find(s => s.pid === 12345)!;
  assert.equal(process.match, 'Process only'); assert.equal(result.telemetry.enabled, false);
  assert.deepEqual(process.rootlaneTools.map(({ tool, calls, errors }) => ({ tool, calls, errors })), [{ tool: 'get_project', calls: 2, errors: 1 }]);
  await service.telemetry.flush();
  const saved = store.db.prepare('SELECT calls,errors FROM rootlane_tool_calls WHERE pid=? AND tool=?').get(12345, 'get_project');
  assert.deepEqual(saved, { calls: 2, errors: 1 });
  for (const tool of ['get_agent_sessions', 'get_telemetry_status'] as const) assert.equal(toolContracts[tool].read, true);
  await service.telemetry.stop();
});

test('copied setup uses live receiver port and explicit safe JSON exporters', async t => {
  const { config } = await setup(t); config.telemetry.port = 19500;
  const token = 'i'.repeat(40);
  const env = JSON.parse(telemetrySetup('claude-env', config, token)).env;
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:19500/otlp');
  assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json'); assert.equal(env.OTEL_METRIC_EXPORT_INTERVAL, '10000');
  assert.equal(env.OTEL_EXPORTER_OTLP_HEADERS, `Authorization=Bearer ${token}`);
  const codex = telemetrySetup('codex', config, token);
  assert(codex.includes('19500/otlp/v1/logs')); assert(codex.includes('protocol = "json"')); assert(codex.includes('log_user_prompt = false'));
});
