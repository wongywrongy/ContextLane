import test from 'node:test';
import assert from 'node:assert/strict';
import { routeState, boundedText } from '../src/host/linux.js';
import { orderedServices } from '../src/config.js';
import { setup } from './helpers.js';
import { instanceLock } from '../src/host/lock.js';
import { join } from 'node:path';
const route = { hostname: 'neo.example.ts.net', port: 19484, upstream: 'http://127.0.0.1:19482', label: 'Preview' };
test('route matching refuses additional handlers, TCP forwarding, other hosts and Funnel', () => {
  const config = { TCP: { '19484': { HTTPS: true } }, Web: { 'neo.example.ts.net:19484': { Handlers: { '/': { Proxy: route.upstream } } } } };
  assert.equal(routeState({}, route), 'absent'); assert.equal(routeState(config, route), 'matching');
  assert.equal(routeState({ ...config, AllowFunnel: { 'neo.example.ts.net:19484': true } }, route), 'conflict');
  assert.equal(routeState({ ...config, TCP: { '19484': { TCPForward: 'localhost:9999' } } }, route), 'conflict');
  assert.equal(routeState({ ...config, Web: { 'neo.example.ts.net:19484': { Handlers: { '/': { Proxy: route.upstream }, '/other': { Proxy: 'other' } } } } }, route), 'conflict');
});
test('response bounds terminate oversized readiness or adapter output', async () => {
  await assert.rejects(() => boundedText(new Response('x'.repeat(500)), 100), /allowed size/);
  assert.equal(await boundedText(new Response('ok'), 100), 'ok');
});
test('dependency ordering rejects cycles and missing services', async t => {
  const { config } = await setup(t); const profile = config.profiles[0]; assert.deepEqual(orderedServices(profile).map(s => s.id), ['api', 'web']);
  profile.services[0].dependencies = ['web']; assert.throws(() => orderedServices(profile), /dependency/);
});
test('a lifetime file lock excludes a second backend and releases on close', async t => {
  const { root } = await setup(t); const path = join(root, 'lock'); const unlock = await instanceLock(path);
  try { await assert.rejects(() => instanceLock(path), /Another Rootlane/); } finally { unlock(); }
  const second = await instanceLock(path); second();
});
