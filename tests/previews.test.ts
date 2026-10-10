import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { setup, request } from './helpers.js';
import { Publications } from '../src/preview/service.js';
import { Store } from '../src/state/store.js';
import { Problem } from '../src/shared/contracts.js';

async function fixture(t: import('node:test').TestContext) {
  const context = await setup(t); const { config, host, root, lifecycle } = context;
  config.previewTargets = [{ id: 'web', approved: true, projectPath: root, checkoutPath: root, serviceId: 'web', serviceName: 'Fixture web', port: 19482, httpsPort: 19485, readiness: config.profiles[0].services[1].readiness }];
  host.listeners = async () => [{ address: '127.0.0.1', port: 19482, pid: 123, cwd: root, cgroup: null }];
  const publications = new Publications(lifecycle); await publications.reconcile();
  t.after(() => publications.drain());
  return { ...context, publications };
}
const publish = () => ({ targetId: 'web', requestId: randomUUID() });

test('publication owns only its HTTPS route; concurrent duplicates, shared request IDs and explicit removal', async t => {
  const { publications: p, host, store, lifecycle } = await fixture(t);
  host.routesMap.set(8443, 'unrelated'); const input = publish();
  const [a, b, c] = await Promise.all([p.accept('publish', input), p.accept('publish', input), p.accept('publish', publish())]);
  assert.equal(a.previewId, b.previewId); assert.equal(a.operation.id, c.operation.id);
  await p.drain(); const state = await p.get({ previewId: a.previewId }); assert.equal(state.https, 'verified'); assert.equal(host.starts, 0);
  assert.equal(store.db.prepare('SELECT key FROM reservations WHERE preview=?').get(a.previewId) && store.db.prepare('SELECT key FROM reservations WHERE key=?').get('tcp:19482'), undefined);
  assert.throws(() => lifecycle.accept('start', { environmentId: 'fixture', requestId: input.requestId }), /requestId/);
  await assert.rejects(p.accept('unpublish', { previewId: a.previewId, requestId: input.requestId }), /requestId/);
  const removed = await p.accept('unpublish', { previewId: a.previewId, requestId: randomUUID() }); await p.drain();
  assert.equal(store.previewOperation(removed.operation.id).status, 'succeeded'); assert.equal(host.routesMap.get(8443), 'unrelated'); assert.equal(host.stops.length, 0); assert.equal((await host.listeners())[0].port, 19482);
});

for (const reason of ['approval', 'binding', 'extra-binding', 'association', 'unknown', 'guard', 'route', 'port'] as const) test(`publication rejects ${reason} before host changes`, async t => {
  const { publications: p, config, host, store } = await fixture(t);
  if (reason === 'approval') config.previewTargets = [];
  if (reason === 'binding') host.listeners = async () => [{ address: '0.0.0.0', port: 19482, cwd: config.projectRoots[0], pid: 1, cgroup: null }];
  if (reason === 'extra-binding') { const listeners = host.listeners.bind(host); host.listeners = async () => [...await listeners(), { address: '0.0.0.0', port: 3000, cwd: config.projectRoots[0], pid: 123, cgroup: null }]; }
  if (reason === 'association') host.listeners = async () => [{ address: '127.0.0.1', port: 19482, cwd: '/tmp', pid: 1, cgroup: null }];
  if (reason === 'unknown') host.listeners = async () => [{ address: '127.0.0.1', port: 19482, cwd: null, pid: null, cgroup: null }];
  if (reason === 'guard') host.guardedRoutes = async () => false;
  if (reason === 'route') host.routesMap.set(19485, 'other');
  if (reason === 'port') { const listeners = host.listeners.bind(host); host.listeners = async () => [...await listeners(), { address: '127.0.0.1', port: 19485, cwd: null, pid: null, cgroup: null }]; }
  await assert.rejects(p.accept('publish', publish())); assert.equal(store.previews().length, 0); assert.equal(host.starts, 0);
});

test('lifecycle and independent publications share HTTPS reservations', async t => {
  const { publications: p, config, store, lifecycle } = await fixture(t);
  config.previewTargets[0].httpsPort = 19484;
  const publication = await p.accept('publish', publish()); await p.drain();
  const operation = lifecycle.accept('start', request()); await lifecycle.drain();
  assert(['RESOURCE_CONFLICT', 'PORT_CONFLICT', 'ROUTE_CONFLICT'].includes(store.getOperation(operation.operation.id).error!.code));
  assert.equal(store.preview(publication.previewId)?.removed, 0);
});

test('changed targets require removal; removed approval permits removal; failed removal retains reservation', async t => {
  const { publications: p, config, store, host } = await fixture(t);
  const a = await p.accept('publish', publish()); await p.drain();
  config.previewTargets[0].serviceName = 'Changed'; await assert.rejects(p.accept('publish', publish()), /changed/);
  config.previewTargets = []; host.routesMap.set(19485, 'other');
  const b = await p.accept('unpublish', { previewId: a.previewId, requestId: randomUUID() }); await p.drain();
  assert.equal(store.previewOperation(b.operation.id).status, 'failed'); assert.equal(store.preview(a.previewId)?.removed, 0); assert(store.db.prepare('SELECT key FROM reservations WHERE preview=?').get(a.previewId));
  host.routesMap.set(19485, 'http://127.0.0.1:19482'); await p.accept('unpublish', { previewId: a.previewId, requestId: randomUUID() }); await p.drain(); assert.equal(store.preview(a.previewId)?.removed, 1);
});

test('restart preserves routes, reports drift, interrupts publication and resumes matching removal', async t => {
  const { publications: p, lifecycle, store, host } = await fixture(t);
  const a = await p.accept('publish', publish()); await p.drain();
  store.finishPreview(a.operation.id, 'running');
  const restarted = new Publications(lifecycle); await restarted.reconcile(); assert.equal(host.starts, 0); assert.equal((await restarted.get({ previewId: a.previewId })).route, 'matching');
  assert.equal(store.previewOperation(a.operation.id).error?.code, 'INTERRUPTED');
  host.routesMap.delete(19485); await restarted.reconcile(); assert.equal((await restarted.get({ previewId: a.previewId })).route, 'absent'); assert(!host.routesMap.has(19485));
  host.routesMap.set(19485, 'http://127.0.0.1:19482');
  const op = store.acceptPreview('unpublish', a.previewId, randomUUID()); store.finishPreview(op.operation.id, 'running');
  await new Publications(lifecycle).reconcile(); assert.equal(store.previewOperation(op.operation.id).status, 'succeeded'); assert.equal(host.stops.length, 0);
});

test('uncertain guarded write retains ownership and failed readiness never publishes', async t => {
  const { publications: p, host, store } = await fixture(t);
  host.probe = async () => false; const a = await p.accept('publish', publish()); await p.drain(); assert.equal(store.previewOperation(a.operation.id).error?.code, 'UPSTREAM_UNREADY'); assert.equal(host.routesMap.size, 0);
  await p.accept('unpublish', { previewId: a.previewId, requestId: randomUUID() }); await p.drain();
  host.probe = async () => true;
  host.addRoute = async () => { throw new Problem('ROUTE_TIMEOUT', 'Reply lost'); };
  const b = await p.accept('publish', publish()); await p.drain(); assert.equal(store.preview(b.previewId)?.attempted, 1); assert(store.db.prepare('SELECT key FROM reservations WHERE preview=?').get(b.previewId));
});

test('migration preserves version-one requests, reservations and installation identity', async t => {
  const { root } = await setup(t); const path = join(root, 'v1.sqlite'); const db = new Database(path);
  db.exec(readFileSync('src/state/migrations/001_initial.sql', 'utf8')); db.pragma('user_version = 1');
  db.prepare('INSERT INTO meta VALUES (?,?)').run('installation', 'old');
  db.prepare('INSERT INTO environments VALUES (?,?,?,?)').run('old', 'revision', '{}', 'stopped');
  db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?)').run('op','old','stop','succeeded',null,'time','time');
  db.prepare('INSERT INTO requests VALUES (?,?,?)').run('req',JSON.stringify({environmentId:'old',action:'stop'}),'op');
  db.prepare('INSERT INTO resources(id,environment,operation,kind,data,ordinal) VALUES (?,?,?,?,?,?)').run('res','old','op','route','{}',0);
  db.prepare('INSERT INTO reservations VALUES (?,?)').run('tcp:19484','res'); db.close();
  const migrated = new Store(path); t.after(() => migrated.close()); assert.equal(migrated.installation, 'old'); assert.equal(migrated.retry('old','stop','req')?.id, 'op'); assert.equal(migrated.resources('old').length, 1); assert.equal(migrated.db.pragma('user_version',{simple:true}),2);
});

test('recorded preview checkouts remain discoverable after approval is removed', async t => {
  const { config, root, host, store, publications: p } = await fixture(t);
  const { mkdir } = await import('node:fs/promises'); const { Catalog } = await import('../src/catalog/discovery.js');
  const projectPath=join(root,'projects','app');const checkout=join(projectPath,'fixture');await mkdir(checkout,{recursive:true});
  config.projectRoots=[join(root,'projects')];config.profiles=[];Object.assign(config.previewTargets[0],{projectPath,checkoutPath:checkout});
  host.listeners=async()=>[{address:'127.0.0.1',port:19482,pid:123,cwd:checkout,cgroup:null}];
  const result=await p.accept('publish',publish());await p.drain();config.previewTargets=[];
  const catalog=new Catalog(config,host,store);const projects=await catalog.list({limit:50});const project=projects.projects.find(p=>p.path===projectPath)!;
  const details=await catalog.get(project.id);assert.equal(details.approvedTargetIds.length,0);assert.equal(details.previews[0].previewId,result.previewId);assert.equal(details.checkoutIds.length,2);
});

test('a single IPv6 or dual-loopback process publishes; wildcard binds return PUBLIC_BINDING', async t => {
  const {host,root,publications:p,store} = await fixture(t);
  for (const addresses of [['::1'],['127.0.0.1','::1']]) {
    host.listeners = async()=>addresses.map(address=>({address,port:19482,pid:123,cwd:root,cgroup:null}));
    const accepted = await p.accept('publish',publish()); await p.drain();
    assert.equal(store.previewOperation(accepted.operation.id).status,'succeeded');
    const route = JSON.parse(store.preview(accepted.previewId)!.route); assert.equal(route.upstream,addresses.length===1?'http://[::1]:19482':'http://127.0.0.1:19482'); assert.equal((await p.get({previewId:accepted.previewId})).target,route.upstream);
    await p.accept('unpublish',{previewId:accepted.previewId,requestId:randomUUID()}); await p.drain();
  }
  host.listeners=async()=>[{address:'::',port:19482,pid:123,cwd:root,cgroup:null}];
  await assert.rejects(p.accept('publish',publish()),(e:unknown)=>e instanceof Problem && e.code==='PUBLIC_BINDING' && e.message.includes('--host 127.0.0.1'));
});

test('unpublished preview history remains in project details and list_operations returns its error codes',async t=>{
  const {publications:p,config,host,store,lifecycle}=await fixture(t);
  const {Catalog}=await import('../src/catalog/discovery.js');const {Rootlane}=await import('../src/service.js');
  host.probe=async()=>false;
  const published=await p.accept('publish',publish());await p.drain();
  await p.accept('unpublish',{previewId:published.previewId,requestId:randomUUID()});await p.drain();
  const service=new Rootlane(new Catalog(config,host,store),lifecycle);
  const catalog=await service.catalog.list({limit:50});const project=catalog.projects.find(p=>p.path===config.projectRoots[0])!;
  assert((await service.catalog.get(project.id)).previews.some(p=>p.previewId===published.previewId));
  const {operationsOutput}=await import('../src/shared/contracts.js');
  const history=operationsOutput.parse(await service.call('list_operations',{previewId:published.previewId,limit:2}));
  assert.equal(history.operations[0].action,'unpublish');assert.equal(history.operations[1].error?.code,'UPSTREAM_UNREADY');
});
