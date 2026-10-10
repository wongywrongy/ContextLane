import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, request } from './helpers.js';
import { Rootlane } from '../src/service.js';
import { Catalog } from '../src/catalog/discovery.js';
import { reloadConfig, reconcileWithRetry } from '../src/runtime.js';
import { Problem } from '../src/shared/contracts.js';

test('reconciliation backoff doubles to 60 seconds then clears errors after recovery', async t => {
  const { config, host, lifecycle } = await setup(t);
  const service = new Rootlane(new Catalog(config, host), lifecycle);
  const delays: number[] = [];
  const retry = reconcileWithRetry(service, (_work, ms) => { delays.push(ms); return setTimeout(() => {}, 0); }); t.after(() => retry.stop());
  host.routes = async () => { throw new Problem('OFFLINE', 'daemon unavailable'); };
  for (let i = 0; i < 8; i++) await retry.run();
  assert.deepEqual(delays, [2000,4000,8000,16000,32000,60000,60000,60000]);
  assert.equal(service.lastError?.code, 'OFFLINE'); assert.equal(service.reconciling, true);
  host.routes = async () => new Map(); await retry.run();
  assert.equal(service.lastError, null); assert.equal(service.reconciling, false);
});

test('config reload retains live resources, rejects invalid config and keeps revised profiles guarded', async t => {
  const { root, config, host, lifecycle, store } = await setup(t);
  const service = new Rootlane(new Catalog(config, host), lifecycle);
  lifecycle.accept('start', request()); await lifecycle.drain();
  const resources = store.resources('fixture').map(r => r.id);
  const path = join(root, 'reload.json');
  await writeFile(path, '{', {mode:0o600}); await reloadConfig(path, config, service, []);
  assert.equal(service.configError?.code, 'INVALID_CONFIG'); assert.equal(config.profiles[0].effects, 'Starts two disposable services and a private route.');
  // loadConfig requires config outside observation roots.
  const { mkdtemp, rm } = await import('node:fs/promises'); const outer = await mkdtemp('/tmp/rootlane-reload-'); t.after(() => rm(outer, {recursive:true,force:true}));
  const valid = join(outer, 'config.json');
  const next = structuredClone(config); next.profiles[0].effects = 'Revised owner review';
  await writeFile(valid, JSON.stringify(next), {mode:0o600}); await reloadConfig(valid, config, service, [valid]);
  assert.equal(service.configError, null); assert.equal(config.profiles[0].effects, 'Revised owner review');
  assert.deepEqual(store.resources('fixture').map(r => r.id), resources);
  const started = lifecycle.accept('start', request()); await lifecycle.drain();
  assert.equal(store.getOperation(started.operation.id).error?.code, 'NEEDS_STOP');
});
