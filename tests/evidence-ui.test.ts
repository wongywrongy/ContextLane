import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { project, environmentOutput, type CheckHistory } from '../src/shared/contracts.js';
import { groupProjects, groupServices } from '../web/projects.js';
// Frontend components use Vite resolution and are typechecked by tsconfig.web.json.
const panelModule = '../web/project-card.js', rowModule = '../web/project-row.js';
const { ProjectDetailsPanel } = await import(panelModule);
const { ProjectRow } = await import(rowModule);

const checkout = () => project.parse({ id: 'checkout', name: 'Fixture', path: '/code/fixture', gitCommonDir: null, branch: 'main', detached: false, manifests: [], links: [], agents: [], environmentIds: ['env'], funnel: [], runtime: { services: [{ id: 'web', name: 'Web', port: 3000 }], ports: [3000], status: 'listeners observed', ownership: 'observe-only', listeners: [{ port: 3000, bind: '127.0.0.1', wildcard: false, managedBy: { environmentId: 'env', serviceId: 'web' }, process: { name: 'vite', pid: 42 } }] } });
const environment = () => environmentOutput.parse({ id: 'env', profileRevision: 'rev', effects: 'none', dataRequirements: 'none', startAllowed: true, ownership: 'rootlane', desiredState: 'running', application: 'ready', preview: 'unavailable', links: [], services: [{ id: 'web', port: 3000, unit: 'owned.service', state: 'active', ready: true }], observedAt: new Date().toISOString(), latestOperation: null, observationError: null });

test('configured or replaced listeners are Observed until unit ownership is corroborated', () => {
  const p = checkout(), env = environment(); delete p.runtime.listeners![0].managedBy;
  for (const services of [env.services, [{ id: 'web', port: 3000, unit: '', state: 'not recorded' }]]) {
    const service = groupServices(groupProjects([p])[0], { env: { ...env, services } })[0];
    assert.equal(service.managed, false); assert.equal(service.state, 'Listening'); assert.equal(service.unit, '—');
  }
});

test('environment refresh failure clears the header and current check result, preserving history', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => ({ matches: false }) });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'matchMedia', original); else Reflect.deleteProperty(globalThis, 'matchMedia'); });
  const p = checkout(), group = groupProjects([p])[0];
  const checks: CheckHistory[] = [{ subject: 'env/web', kind: 'readiness', checkoutId: p.id, results: [{ ok: true, status: 'pass', at: new Date().toISOString() }] }];
  const props = { group, tab: 'Overview' as const, onOpen: () => {}, onClose: () => {}, onMove: () => {}, hasPrevious: false, hasNext: false, environments: { env: environment() }, environmentErrors: {}, previews: {}, previewErrors: {}, details: null, projectError: '', stale: false, lifecycleAvailable: true, working: null, editorTemplate: null, editorHost: null, activity: [], activityError: '', checks, events: [], onRequest: () => {}, onAction: () => {}, loadLogs: async () => ({ lines: [], nextCursor: null, truncated: false }) };
  const healthy = renderToStaticMarkup(React.createElement(ProjectDetailsPanel, props));
  assert(healthy.includes('Managed · Ready')); assert(healthy.includes('>Pass</span>'));
  const failed = renderToStaticMarkup(React.createElement(ProjectDetailsPanel, { ...props, environmentErrors: { env: 'Current refresh failed' } }));
  assert(failed.includes('Managed · —')); assert(!failed.includes('>Pass</span>')); assert(!failed.includes('>Working</span>'));
  assert(failed.includes('Last 1 results: pass'));
});

test('mobile exposure counts bound addresses independently of publication eligibility', () => {
  const p = checkout(); p.environmentIds = []; p.runtime.services = [];
  const props = { group: groupProjects([p])[0], environments: {}, previews: {}, stale: false, now: Date.now(), onDetails: () => {}, onLogs: () => {}, expanded: false, density: 'Expanded' as const, editorTemplate: null, editorHost: null, lifecycleAvailable: true, working: false, onAction: () => {}, onRequest: () => {} };
  p.runtime.listeners = [42, 43].map(pid => ({ port: 3000, bind: '127.0.0.1', wildcard: false, loopback: false, process: { name: 'worker', pid } }));
  const row = () => renderToStaticMarkup(React.createElement(ProjectRow, props));
  assert(!row().includes('on network'));
  p.runtime.listeners[0].bind = '0.0.0.0'; p.runtime.listeners[0].wildcard = true;
  assert(row().includes('1 on network'));
  p.runtime.listeners[1].bind = '::'; p.runtime.listeners[1].wildcard = true;
  assert(row().includes('1 on network'));
});
