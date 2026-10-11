import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { catalogEvents, publicFunnelRoutes, wildcardBind } from '../src/catalog/events.js';
import { project, checksOutput, eventsOutput, toolContracts } from '../src/shared/contracts.js';
import { detailTabs } from '../web/projects.js';
import { Catalog } from '../src/catalog/discovery.js';
import { Rootlane } from '../src/service.js';
import type { Host } from '../src/host/types.js';
const fixture = () => project.parse({id:'checkout',name:'Fixture',path:'/code/fixture',gitCommonDir:null,branch:null,detached:false,manifests:[],links:[],agents:[],environmentIds:[],runtime:{services:[],ports:[],status:'no associated listener',ownership:'observe-only',listeners:[]},routeSummaries:[]});
test('check histories retain 30 per subject, group by checkout, and emit only pass/fail transitions',async t => {
  const {store,root} = await setup(t), id = store.checkoutId(root);
  for (let i=0;i<40;i++) store.recordCheck(root,'fixture/web','readiness',true,'pass');
  store.recordCheck(root,'fixture/api','readiness',false,'fail');
  const histories = checksOutput.parse({checks:store.listChecks([id])}).checks;
  assert.equal(histories.length,2); assert.equal(histories[0].results.length,30);
  assert.deepEqual(store.listChecks(['other']),[]); assert.deepEqual(store.listEvents([id],50),[]);
  store.recordCheck(root,'fixture/web','readiness',null,null);
  store.recordCheck(root,'fixture/web','readiness',false,'fail');
  store.recordCheck(root,'fixture/web','readiness',false,'fail');
  store.recordCheck(root,'fixture/web','readiness',true,'pass');
  assert.equal(eventsOutput.parse({events:store.listEvents([id],50)}).events.length,2);
  assert.equal(store.listChecks([id])[0].results.length,30);
});
test('catalog diff records all observed kinds once, and suppresses absent evidence', () => {
  const before=fixture(), after=fixture(),at=new Date().toISOString(), evidence={listeners:true,routes:true,agents:true};
  after.runtime.listeners=[{port:3000,bind:'0.0.0.0',wildcard:true,process:{pid:42,name:'vite'},startedBy:{name:'Codex',pid:20}}]; after.runtime.ports=[3000]; after.runtime.status='listeners observed';
  after.agents=[{source:'detected process',id:'a'.repeat(24),name:'Codex',pid:20}];
  after.routeSummaries=[{url:'https://neo.test:443/',target:'http://127.0.0.1:3000',upstreamPort:3000,route:'matching'}];
  const opened=catalogEvents([before],[after],evidence,at);
  assert.deepEqual(opened.map(e=>e.kind),['listener-opened','route-added','agent-appeared']); assert.match(opened[0].text,/started by Codex/);
  assert.deepEqual(catalogEvents([after],[after],evidence,at),[]);
  assert.deepEqual(catalogEvents([after],[before],evidence,at).map(e=>e.kind),['listener-closed','route-removed','agent-left']);
  const changed=structuredClone(after); changed.routeSummaries![0].target='http://127.0.0.1:4000';
  assert.deepEqual(catalogEvents([after],[changed],evidence,at).map(e=>e.kind),['route-changed']);
  assert.deepEqual(catalogEvents([after],[before],{listeners:false,routes:false,agents:false},at),[]);
});
test('wildcard addresses and managed tab visibility are explicit', () => {
  for (const address of ['0.0.0.0','::','*']) assert(wildcardBind(address));
  for (const address of ['127.0.0.1','::1','192.168.1.2']) assert(!wildcardBind(address));
  for (const mobile of [true,false]) { assert(!detailTabs(false,mobile).includes('Logs')); assert(detailTabs(true,mobile).includes('Logs')); }
  assert.throws(()=>toolContracts.list_events.input.parse({projectId:'checkout',limit:51}));
});
test('Funnel evidence includes foreground routes and ignores disabled entries', () => {
  assert.deepEqual(publicFunnelRoutes({AllowFunnel:{'neo.test:443':false},Foreground:{session:{AllowFunnel:{'neo.test:8443':true},Foreground:{nested:{AllowFunnel:{'neo.test:9443':true}}}}}}),['neo.test:8443','neo.test:9443']);
  assert.deepEqual(publicFunnelRoutes({}),[]);
});
test('event retention is bounded and new tools scope evidence without HTTP probes', async t => {
  const {store,root,config,host,lifecycle} = await setup(t), catalog = new Catalog(config,host,store), service = new Rootlane(catalog,lifecycle);
  const checkout = (await catalog.projects()).find(p=>p.path===root)!;
  for(let i=0;i<510;i++) store.recordEvent({at:new Date().toISOString(),projectId:checkout.id,checkoutId:checkout.id,kind:'agent-appeared',text:'Codex appeared',ref:String(i)});
  assert.equal((store.db.prepare('SELECT count(*) AS n FROM events').get() as {n:number}).n,500);
  const events=eventsOutput.parse(await service.call('list_events',{projectId:checkout.id,limit:5})); assert.equal(events.events.length,5);assert.equal(events.events[0].ref,'509');
  store.recordCheck(root,'fixture/web','readiness',true,'pass');
  assert.equal(checksOutput.parse(await service.call('list_checks',{projectId:checkout.id})).checks.length,1);
  await assert.rejects(service.call('list_checks',{projectId:'missing'}),/no longer/);
});

test('catalog bind and Funnel evidence feeds notices, and a repeated scan records no duplicate events',async t => {
  const {store,root,config,host}=await setup(t);host.listeners=async()=>[{address:'0.0.0.0',port:5960,pid:42,cwd:root,cgroup:null,process:{name:'vite',pid:42}}];
  (host as Host).routes=async()=>({AllowFunnel:{'neo.test:443':true}});
  const catalog=new Catalog(config,host,store), first=await catalog.list({});const p=first.projects.find(p=>p.path===root)!;
  assert.equal(p.runtime.listeners![0].bind,'0.0.0.0');assert(p.runtime.listeners![0].wildcard);assert.deepEqual(p.funnel,['neo.test:443']);
  assert(first.warnings.includes('vite :5960 reachable on the network'));
  const count=store.listEvents([p.id],50).length;catalog.invalidate();await catalog.list({});assert.equal(store.listEvents([p.id],50).length,count);
});

test('one Serve read records one route result per checkout port, including dual-stack listeners', async t => {
  const { root, config, host, store } = await setup(t);
  let reads = 0;
  host.routes = async () => { reads++; return new Map(); };
  host.listeners = async () => ['127.0.0.1', '::1'].map(address => ({ address, port: 3000, pid: 42, cwd: root, cgroup: null }));
  const catalog = new Catalog(config, host, store);
  await catalog.list({});
  const history = store.listChecks([store.checkoutId(root)]).find(c => c.subject.endsWith(':3000:route'))!;
  assert.equal(reads, 1);
  assert.equal(history.results.length, 1);
  catalog.invalidate(); await catalog.list({});
  assert.equal(store.listChecks([store.checkoutId(root)])[0].results.length, 2);
});

test('controller restart establishes a baseline and first source recovery creates no appearance events', async t => {
  const { root, config, host, store } = await setup(t);
  host.listeners = async () => [{ address: '127.0.0.1', port: 3000, pid: 42, cwd: root, cgroup: null, process: { name: 'vite', pid: 42 } }];
  host.agentObservations.agents = [{ id: 'a'.repeat(24), name: 'Codex', cwd: root }];
  host.routesMap.set(19484, 'http://127.0.0.1:19482');
  const first = new Catalog(config, host, store);
  await first.list({});
  assert.equal(store.listEvents([store.checkoutId(root)], 50).length, 0);
  host.listeners = async () => [{ address: '127.0.0.1', port: 3000, pid: 43, cwd: root, cgroup: null, process: { name: 'vite', pid: 43 } }];
  first.invalidate(); await first.list({});
  const count = store.listEvents([store.checkoutId(root)], 50).length;
  assert.equal(count, 2);
  await new Catalog(config, host, store).list({});
  assert.equal(store.listEvents([store.checkoutId(root)], 50).length, count);
  const listeners = host.listeners, agents = host.agents, routes = host.routes;
  host.listeners = async () => { throw Error('unavailable'); };
  host.agents = async () => { throw Error('unavailable'); };
  host.routes = async () => { throw Error('unavailable'); };
  const recovery = new Catalog(config, host, store); await recovery.list({});
  host.listeners = listeners; host.agents = agents; host.routes = routes;
  recovery.invalidate(); await recovery.list({});
  assert.equal(store.listEvents([store.checkoutId(root)], 50).length, count);
});

test('removed checkout emits disappearance events and retains its parent history across controller restarts', async t => {
  const { mkdir, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { root, config, host, store, lifecycle } = await setup(t);
  const child = join(root, 'tree'); await mkdir(child); await writeFile(join(child, 'package.json'), '{}');
  config.profiles.push({ ...config.profiles[0], id: 'child', projectPath: child });
  const catalog = new Catalog(config, host, store), service = new Rootlane(catalog, lifecycle);
  await catalog.list({});
  host.listeners = async () => [{ address: '127.0.0.1', port: 3000, pid: 42, cwd: child, cgroup: null }];
  host.agentObservations.agents = [{ id: 'a'.repeat(24), name: 'Codex', cwd: child }];
  catalog.invalidate(); await catalog.list({});
  const id = store.checkoutId(root), childId = store.checkoutId(child);
  assert.equal(eventsOutput.parse(await service.call('list_events', { projectId: id })).events.length, 2);
  await rm(child, { recursive: true }); host.listeners = async () => []; host.agentObservations.agents = [];
  catalog.invalidate(); await catalog.list({});
  const events = eventsOutput.parse(await service.call('list_events', { projectId: id })).events;
  assert.deepEqual(events.map(e => e.kind), ['agent-left', 'listener-closed', 'agent-appeared', 'listener-opened']);
  assert(events.every(e => e.checkoutId === childId));
  const restarted = new Rootlane(new Catalog(config, host, store), lifecycle);
  assert.deepEqual(eventsOutput.parse(await restarted.call('list_events', { projectId: id })).events, events);
});

test('removed checkout diff includes routes and suppresses disappearance on incomplete discovery', () => {
  const before = fixture(); before.runtime.status = 'listeners observed';
  before.runtime.listeners = [{ port: 3000, bind: '127.0.0.1', wildcard: false }];
  before.agents = [{ source: 'detected process', id: 'a'.repeat(24), name: 'Codex' }];
  before.routeSummaries = [{ url: 'https://neo.test:443/', target: 'http://127.0.0.1:3000', upstreamPort: 3000, route: 'matching' }];
  const evidence = { listeners: true, routes: true, agents: true };
  assert.deepEqual(catalogEvents([before], [], evidence, new Date().toISOString()).map(e => e.kind), ['listener-closed', 'route-removed', 'agent-left']);
  assert.deepEqual(catalogEvents([before], [], { ...evidence, projects: false }, new Date().toISOString()), []);
});

test('listener ownership requires the recorded unit marker, invocation and control group', async t => {
  const { root, config, host, store, lifecycle } = await setup(t);
  const { groupProjects, groupServices } = await import('../web/projects.js');
  const { request } = await import('./helpers.js');
  await lifecycle.accept('start', request()); await lifecycle.drain();
  const resource = store.resources('fixture').find(r => r.kind === 'unit')!;
  const unit = JSON.parse(resource.data) as import('../src/host/types.js').Unit;
  const current = host.units.get(unit.name)!;
  let cgroup: string | null = current.cgroup;
  host.listeners = async () => [{ address: '127.0.0.1', port: unit.port, pid: 42, cwd: root, cgroup }];
  const catalog = new Catalog(config, host, store);
  const observed = async () => { catalog.invalidate(); return (await catalog.projects()).find(p => p.path === root)!; };
  let checkout = await observed();
  assert.deepEqual(checkout.runtime.listeners![0].managedBy, { environmentId: 'fixture', serviceId: unit.serviceId });
  const environments = { fixture: await lifecycle.get({ environmentId: 'fixture' }) };
  assert.equal(groupServices(groupProjects([checkout])[0], environments).find(s => s.port === unit.port)!.managed, true);
  for (const changed of [null, current.cgroup + '-other']) {
    cgroup = changed; checkout = await observed();
    assert.equal(checkout.runtime.listeners![0].managedBy, undefined);
    const service = groupServices(groupProjects([checkout])[0], environments).find(s => s.port === unit.port)!;
    assert.equal(service.managed, false); assert.equal(service.state, 'Listening');
  }
  cgroup = current.cgroup + '/child'; checkout = await observed();
  assert(checkout.runtime.listeners![0].managedBy);
  host.units.set(unit.name, { ...current, marker: 'other owner' });
  assert.equal((await observed()).runtime.listeners![0].managedBy, undefined);
  host.units.set(unit.name, { ...current, invocation: 'another-start' });
  assert.equal((await observed()).runtime.listeners![0].managedBy, undefined);
});

test('removed checkout waits for missing source evidence without repeating successful disappearance observations', async t => {
  const { mkdir, rm } = await import('node:fs/promises'), { join } = await import('node:path');
  const { root, config, host, store } = await setup(t), child = join(root, 'tree');
  await mkdir(child); config.profiles.push({ ...config.profiles[0], id: 'child', projectPath: child });
  host.listeners = async () => [{ address: '127.0.0.1', port: 3000, pid: 42, cwd: child, cgroup: null }];
  host.agentObservations.agents = [{ id: 'a'.repeat(24), name: 'Codex', cwd: child }];
  const catalog = new Catalog(config, host, store); await catalog.list({});
  await rm(child, { recursive: true }); host.listeners = async () => [];
  const agents = host.agents, listeners = host.listeners;
  host.agents = async () => { throw Error('unavailable'); };
  host.listeners = async () => { throw Error('unavailable'); };
  catalog.invalidate(); await catalog.list({});
  assert(store.eventCheckoutIds((await catalog.checkouts(store.checkoutId(root)))).includes(store.checkoutId(child)));
  host.listeners = listeners;
  for (let i = 0; i < 2; i++) { catalog.invalidate(); await catalog.list({}); }
  assert.deepEqual(store.listEvents([store.checkoutId(child)], 50).map(e => e.kind), ['listener-closed']);
  host.agents = agents; host.agentObservations.agents = [];
  catalog.invalidate(); await catalog.list({});
  assert.deepEqual(store.listEvents([store.checkoutId(child)], 50).map(e => e.kind), ['agent-left', 'listener-closed']);
});

test('historical scope retains external Git worktrees without including unrelated checkouts', async t => {
  const { store } = await setup(t), main = fixture(), tree = fixture(), other = fixture();
  main.gitCommonDir = '/code/fixture/.git'; tree.id = 'tree'; tree.path = '/worktrees/tree'; tree.gitCommonDir = main.gitCommonDir;
  other.id = 'other'; other.path = '/code/fixture-other';
  store.rememberCatalog([main, tree, other]);
  store.recordEvent({ at: new Date().toISOString(), projectId: tree.id, checkoutId: tree.id, kind: 'agent-left', text: 'Codex is no longer observed', ref: null });
  store.rememberCatalog([main]);
  assert.deepEqual(store.eventCheckoutIds([main]), [main.id, tree.id]);
  assert.equal(store.listEvents(store.eventCheckoutIds([main]), 50).length, 1);
});
