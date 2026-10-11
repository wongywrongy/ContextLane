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
