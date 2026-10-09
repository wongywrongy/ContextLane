import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { Lifecycle } from '../src/lifecycle/service.js';
import { setup, request } from './helpers.js';
import { Problem } from '../src/shared/contracts.js';

test('duplicate starts are durable, readiness and preview are separate, stop preserves unrelated resources', async t => {
  const { lifecycle: life, host, store } = await setup(t);
  host.units.set('unrelated.service', { state: 'active', marker: 'someone else', cgroup: '/else', invocation: 'else' }); host.routesMap.set(8443, 'http://127.0.0.1:8000');
  const payload = request(); const a = life.accept('start', payload); const b = life.accept('start', payload); const c = life.accept('start', request());
  assert.equal(a.operation.status, 'accepted'); assert.equal(a.operation.id, b.operation.id); assert.equal(a.operation.id, c.operation.id);
  assert.throws(() => life.accept('stop', payload), /requestId/);
  assert.throws(() => life.accept('stop', request()), /Wait for operation/);
  await life.drain(); assert.equal(host.starts, 2); assert.equal(store.getOperation(a.operation.id).status, 'succeeded');
  const env = await life.get({ environmentId: 'fixture' }); assert.equal(env.application, 'ready'); assert.equal(env.preview, 'available'); assert.equal(env.links.length, 1);
  life.accept('start', request()); await life.drain(); assert.equal(host.starts, 2);
  const logs = await life.logs({ environmentId: 'fixture', serviceId: 'api', limit: 2 }); assert.equal(logs.lines.length, 2);
  life.accept('stop', request()); await life.drain(); assert.equal(host.units.size, 1); assert(host.units.has('unrelated.service')); assert.equal(host.routesMap.size, 1); assert.equal(host.routesMap.get(8443), 'http://127.0.0.1:8000'); assert.equal(store.resources('fixture').length, 0);
  assert.equal((await life.get({ environmentId: 'fixture' })).application, 'stopped');
});
for (const conflict of ['port', 'route', 'capability'] as const) test(`${conflict} conflict fails before creating resources`, async t => {
  const { lifecycle: life, host, store } = await setup(t);
  if (conflict === 'port') host.busyPorts = [19481]; if (conflict === 'route') host.routesMap.set(19484, 'other'); if (conflict === 'capability') host.missing = true;
  const op = life.accept('start', request()); await life.drain(); assert.equal(store.getOperation(op.operation.id).status, 'failed'); assert.equal(host.starts, 0); assert.equal(store.resources('fixture').length, 0);
});
test('partial startup rolls back only created units and retains useful logs', async t => {
  const { lifecycle: life, host, store } = await setup(t); host.failService = 'web';
  const op = life.accept('start', request()); await life.drain(); assert.equal(store.getOperation(op.operation.id).status, 'failed'); assert.equal(host.units.size, 0); assert.equal(host.stops.length, 1); assert.equal(store.resources('fixture').length, 0);
  assert((await life.logs({ environmentId: 'fixture', serviceId: 'api', limit: 5 })).lines.length > 0);
});
test('a listener or running unit without application readiness fails startup', async t => {
  const { lifecycle: life, host, store } = await setup(t); host.unready = 'api';
  const op = life.accept('start', request()); await life.drain(); assert.equal(store.getOperation(op.operation.id).error?.code, 'READINESS_TIMEOUT'); assert.equal(host.units.size, 0); assert.equal(host.routesMap.size, 0);
});
test('preview failure keeps healthy applications and reports partial success', async t => {
  const { lifecycle: life, host, store } = await setup(t); host.failPreview = true;
  const op = life.accept('start', request()); await life.drain(); assert.equal(store.getOperation(op.operation.id).status, 'partial'); assert.equal(host.units.size, 2);
  const env = await life.get({ environmentId: 'fixture' }); assert.equal(env.application, 'ready'); assert.equal(env.preview, 'unavailable');
  life.accept('stop', request()); await life.drain(); assert.equal(host.units.size, 0);
});
test('changed route survives stop and retains reservations', async t => {
  const { lifecycle: life, host, store } = await setup(t); life.accept('start', request()); await life.drain(); host.routesMap.set(19484, 'http://127.0.0.1:9999');
  const op = life.accept('stop', request()); await life.drain(); assert.equal(host.routesMap.get(19484), 'http://127.0.0.1:9999'); assert.equal(store.getOperation(op.operation.id).status, 'failed'); assert.equal(store.resources('fixture').length, 3);
});
test('changed unit is never stopped; failed stop retains its port', async t => {
  const { lifecycle: life, host, store } = await setup(t); life.accept('start', request()); await life.drain(); const [name, unit] = [...host.units][0]; unit.marker = 'other-owner';
  const op = life.accept('stop', request()); await life.drain(); assert(host.units.has(name)); assert(!host.stops.includes(name)); assert.equal(store.getOperation(op.operation.id).status, 'failed'); assert(store.resources('fixture').some(r => r.kind === 'unit'));
});
test('concurrent environments cannot reserve the same resources', async t => {
  const { config, store, host } = await setup(t); config.profiles.push({ ...config.profiles[0], id: 'second' }); const life = new Lifecycle(config, store, host); await life.reconcile();
  life.accept('start', request()); const second = life.accept('start', request('second')); await life.drain(); assert.equal(store.getOperation(second.operation.id).error?.code, 'RESOURCE_CONFLICT'); assert.equal(host.starts, 2);
});
test('restart preserves ready units, durable retries and removed-profile stop', async t => {
  const { lifecycle: life, config, host, store } = await setup(t); const payload = request(); const op = life.accept('start', payload); await life.drain();
  store.finish(op.operation.id, 'running');
  const restarted = new Lifecycle(config, store, host); await restarted.reconcile(); assert.equal(host.starts, 2); assert.equal(host.stops.length, 0); assert.equal(store.getOperation(op.operation.id).error?.code, 'INTERRUPTED'); assert.equal(restarted.accept('start', payload).operation.id, op.operation.id);
  config.profiles = []; assert.throws(() => restarted.accept('start', request()), /approved profile/); restarted.accept('stop', request()); await restarted.drain(); assert.equal(host.units.size, 0);
});
test('interrupted partial startup rolls back created resources; reboot does not recreate units', async t => {
  const { lifecycle: life, config, host, store } = await setup(t); const op = life.accept('start', request()); await life.drain();
  store.finish(op.operation.id, 'running'); host.unready = 'web'; await new Lifecycle(config, store, host).reconcile(); assert.equal(host.units.size, 0);
  host.unready = ''; life.accept('start', request()); await life.drain(); host.units.clear(); host.boot = 'boot-2'; await new Lifecycle(config, store, host).reconcile(); assert.equal(host.starts, 4); assert.equal(host.routesMap.size, 0); assert.equal(store.environment('fixture')?.desired, 'stopped');
});
test('backup restores operation IDs and ownership without copying a live WAL', async t => {
  const { root, lifecycle: life, store } = await setup(t); const op = life.accept('start', request()); await life.drain(); const path = join(root, 'backup.sqlite'); await store.db.backup(path);
  const restored = new Database(path, { readonly: true }); try { assert.equal((restored.prepare('SELECT id FROM operations WHERE id=?').get(op.operation.id) as { id: string }).id, op.operation.id); assert.equal((restored.prepare('SELECT count(*) AS count FROM resources').get() as { count: number }).count, 3); } finally { restored.close(); }
});
test('failed systemd stop retains units and port reservations for a later explicit retry', async t => {
  const { lifecycle: life, host, store } = await setup(t); life.accept('start', request()); await life.drain(); host.failStop = true;
  const failed = life.accept('stop', request()); await life.drain(); assert.equal(store.getOperation(failed.operation.id).status, 'failed'); assert.equal(store.resources('fixture').filter(r => r.kind === 'unit').length, 2);
  host.failStop = false; life.accept('stop', request()); await life.drain(); assert.equal(store.resources('fixture').length, 0);
});
test('interrupted stop resumes teardown, while ownership conflicts remain untouched', async t => {
  const { lifecycle: life, config, host, store } = await setup(t); life.accept('start', request()); await life.drain();
  const stopped = store.accept('fixture', 'stop', request().requestId); store.finish(stopped.operation.id, 'running');
  const restarted = new Lifecycle(config, store, host); await restarted.reconcile(); assert.equal(host.units.size, 0); assert.equal(host.routesMap.size, 0); assert.equal(store.resources('fixture').length, 0);
});
test('a start timeout after unit creation still rolls back that operation only', async t => {
  const { lifecycle: life, host, store } = await setup(t); const start = host.startUnit.bind(host);
  host.startUnit = async (unit, service) => { await start(unit, service); if (service.id === 'web') throw new Problem('HOST_COMMAND_FAILED', 'Reply lost after creation'); };
  const op = life.accept('start', request()); await life.drain(); assert.equal(store.getOperation(op.operation.id).status, 'failed'); assert.equal(host.stops.length, 2); assert.equal(host.units.size, 0); assert.equal(store.resources('fixture').length, 0);
});
