import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { agentSession, telemetryStatusOutput, project } from '../src/shared/contracts.js';
import { groupProjects } from '../web/projects.js';
const module = '../web/agent-telemetry.js';
const { AgentsTab, AgentDetail, TelemetrySettings } = await import(module);
const meterModule = '../web/panel-section.js';
const { meterTone } = await import(meterModule);
const now = Date.now(), at = new Date(now).toISOString();
const group = groupProjects([project.parse({ id: 'fixture', name: 'Fixture', path: '/code/fixture', gitCommonDir: null, branch: 'main', detached: false, manifests: [], links: [], agents: [{ id: 'a'.repeat(24), name: 'Claude Code', source: 'detected process', pid: 42, cwd: '/code/fixture', startedAt: at, ports: [3000] }], environmentIds: [], runtime: { status: 'no associated listener', ports: [], ownership: 'observe-only' } })])[0];
const session = agentSession.parse({ id: 'session', agent: 'claude', sessionKey: 'session-key', pid: 42, cwd: group.primary.path, projectId: 'fixture', match: 'Matched', model: 'claude-sonnet', effort: 'high', mode: 'default', startedAt: at, lastSeenAt: at, endedAt: null, counters: { 'tokens.output': 4200, requests: 12, errors: 2 }, tools: [{ tool: 'Read', calls: 10, failures: 1, rejects: 2, totalMs: 1300, p95Ms: 300 }], toolkit: [{ kind: 'mcp', name: 'rootlane', version: null, status: 'failed', lastSeenAt: at }], context: { usedPct: 71, window: 200000, input: 24000, cacheRead: 100000, cacheCreation: 18000, rate5hPct: 62, rate5hResetsAt: at, rate7dPct: 31, rate7dResetsAt: at, observedAt: at }, requestLatency: { p50Ms: 500, p95Ms: 900 }, rootlaneTools: [{ pid: 42, session: 'session', tool: 'locate', calls: 2, errors: 0, lastAt: at }] });

test('telemetry list and details use the shared sections in the specified order', () => {
  const html = renderToStaticMarkup(React.createElement(AgentsTab, { group, data: { sessions: [session], telemetry: { enabled: true, receiving: true, lastEventAt: at, dropped: 0 } }, stale: false, now, onSetup: () => {} }));
  assert(html.includes('1 agents · 1 reporting')); assert(html.includes('context-ring')); assert(html.includes('Matched'));
  const detail = renderToStaticMarkup(React.createElement(AgentDetail, { session, group, now, onBack: () => {}, onSetup: () => {} }));
  const sections = [...detail.matchAll(/<h3>(.*?)<\/h3>/g)].map(match => match[1]);
  assert.deepEqual(sections, ['Claude Code', 'Session', 'Context', 'Usage limits', 'Toolkit', 'Tool calls', 'Model and output', 'Rootlane tool calls']);
  assert(detail.includes('71% of 200k')); assert(detail.includes('toolkit-tag failed')); assert(detail.includes('Counts only. Prompts, responses, tool inputs and file paths are dropped on arrival.'));
});

test('process-only detail retains facts and Rootlane calls; telemetry off has one setup note', () => {
  const process = { ...session, id: 'process:42', sessionKey: '', match: 'Process only' as const, context: null };
  const detail = renderToStaticMarkup(React.createElement(AgentDetail, { session: process, group, now, onBack: () => {}, onSetup: () => {} }));
  assert(detail.includes('Own ports')); assert(detail.includes(':3000')); assert(detail.includes('locate')); assert(detail.includes('Set up telemetry →'));
  assert(!detail.includes('<h3>Context</h3>')); assert(!detail.includes('context-ring'));
  const list = renderToStaticMarkup(React.createElement(AgentsTab, { group, data: { sessions: [process], telemetry: { enabled: false, receiving: false, lastEventAt: null, dropped: 0 } }, stale: false, now, onSetup: () => {} }));
  assert.equal(list.split('Agent telemetry is off.').length - 1, 1);
});

test('a session without a matched live process keeps aggregates and owner registrations keep their identity', () => {
  const html = renderToStaticMarkup(React.createElement(AgentDetail, { session: { ...session, pid: null, match: 'Process only' }, group, now, onBack: () => {}, onSetup: () => {} }));
  assert(html.includes('<h3>Tool calls</h3>')); assert(html.includes('claude-sonnet')); assert(html.includes('PID —'));
  const registeredGroup = { ...group, primary: { ...group.primary, agents: [{ name: 'Owner helper', source: 'owner registration' as const }] }, checkouts: [{ ...group.primary, agents: [{ name: 'Owner helper', source: 'owner registration' as const }] }] };
  const list = renderToStaticMarkup(React.createElement(AgentsTab, { group: registeredGroup, data: { sessions: [], telemetry: { enabled: false, receiving: false, lastEventAt: null, dropped: 0 } }, stale: false, now, onSetup: () => {} }));
  assert(list.includes('Owner helper')); assert(list.includes('Owner registration · no observed process')); assert(!list.includes('Codex'));
});

test('stale session reports its age, Codex limits stay unavailable, thresholds follow the prompt', () => {
  const detail = renderToStaticMarkup(React.createElement(AgentDetail, { session: { ...session, agent: 'codex', context: null, lastSeenAt: new Date(now - 180000).toISOString() }, group, now, onBack: () => {}, onSetup: () => {} }));
  assert(detail.includes('updated 3m ago')); assert(detail.includes('Doesn&#x27;t report usage limits'));
  assert.deepEqual([59, 60, 85, 86].map(meterTone), ['ok', 'warn', 'warn', 'bad']);
});

test('a live process without telemetry does not show a stale report age', () => {
  const old = new Date(now - 86400000).toISOString();
  const process = { ...session, id: 'process:42', sessionKey: '', match: 'Process only' as const, model: null, context: null, startedAt: old, lastSeenAt: old };
  const render = (entry: typeof process) => renderToStaticMarkup(React.createElement(AgentsTab, { group, data: { sessions: [entry], telemetry: { enabled: true, receiving: true, lastEventAt: old, dropped: 0 } }, stale: false, now, onSetup: () => {} }));
  assert(render(process).includes('1d 0h'));
  assert(!render(process).includes('updated'));
  assert(render({ ...process, sessionKey: 'reported-session' }).includes('updated 1d 0h ago'));
});

test('Settings renders configured endpoints, both hooks and placeholder credentials only', () => {
  const status = telemetryStatusOutput.parse({ enabled: true, receiving: true, bind: '127.0.0.1', port: 9748, endpoint: 'http://127.0.0.1:9748/otlp', protocol: 'http/json', credentialSet: true, retentionDays: 7, lastEventAt: at, dropped: 1, droppedByReason: { unknownService: 1 }, reporting: { claude: 1, codex: 0 }, notReporting: 2, bindError: null, codexVersion: '0.162.1', headerEnvSupported: false });
  const html = renderToStaticMarkup(React.createElement(TelemetrySettings, { status, error: '', copy: async () => { throw new Error('INGEST_SECRET_SENTINEL'); }, now }));
  assert(html.includes('127.0.0.1:9748/otlp')); assert(!html.includes('127.0.0.1:9480'));
  for (const value of ['SessionStart', 'SessionEnd', '10000', 'log_user_prompt = false', '&lt;ingest token&gt;', 'literal ingest token']) assert(html.includes(value), value);
  assert(!html.includes('INGEST_SECRET_SENTINEL'));
  const loading = renderToStaticMarkup(React.createElement(TelemetrySettings, { status: null, error: '', copy: async () => {}, now }));
  assert(loading.includes('127.0.0.1:9481/otlp')); assert(!loading.includes('127.0.0.1:9480'));
});
