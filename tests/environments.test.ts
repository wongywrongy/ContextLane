import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup,request } from './helpers.js';
import { Catalog } from '../src/catalog/discovery.js';
import { Rootlane } from '../src/service.js';
import { Store } from '../src/state/store.js';
import { Lifecycle } from '../src/lifecycle/service.js';
import { recipeSchema } from '../src/recipes.js';
import { command } from '../src/host/command.js';
import { createServer } from '../src/http/server.js';
import { toolContracts, Problem } from '../src/shared/contracts.js';

async function application(t:Parameters<typeof setup>[0]) {
  const f=await setup(t),path=join(f.root,'app');await mkdir(path);f.config.profiles=[];f.config.observationRoots=[path];f.config.toolchains.node=process.execPath;
  await writeFile(join(path,'package.json'),JSON.stringify({scripts:{dev:'vite'},devDependencies:{vite:'^7.0.0'}}));
  const service=new Rootlane(new Catalog(f.config,f.host,f.store),f.lifecycle);
  await service.publications.reconcile();
  return {...f,path,service};
}
const simpleRecipe=()=>recipeSchema.parse({version:1,services:[{id:'web',command:['{node}','server.mjs','{port:web}'],readiness:{path:'/',bodyIncludes:'fixture'}}],previews:[{serviceId:'web',label:'Web'}]});
async function reviewed(f:Awaited<ReturnType<typeof application>>,recipe=simpleRecipe()) {
  const inspection=await f.service.recipes.inspectEnvironment(f.path);
  await f.service.recipes.configure(f.path,recipe,{},inspection.fingerprint);
  const result=await f.service.recipes.request(f.path,randomUUID());
  const prerequisites=await f.service.recipes.inspectEnvironment(f.path);
  if(!prerequisites.blockers.length && ['not-needed','succeeded'].includes(prerequisites.preparationStatus))await f.service.recipes.decide(new URL(result.approvalUrl).searchParams.get('approval')!,true);
  return result.resolvedPreview.instanceId;
}
test('bounded Vite proposal is inert, host-local, exports, and leaves repository files unchanged',async t=>{
  const f=await application(t),before=await readFile(join(f.path,'package.json'),'utf8');
  const inspected=await f.service.call('inspect_environment',{path:f.path});
  const value=toolContracts.inspect_environment.output.parse(inspected);
  assert.equal(value.source,null);assert.equal(value.nextAction,'Configure environment');assert(value.proposal);assert.equal(f.host.starts,0);
  const proposal=recipeSchema.parse(value.proposal);assert.equal(proposal.restart,'on-failure');assert(proposal.services[0].command.includes('{vite-launcher}'));assert.equal(proposal.preparation[0].lifecycleScripts,true);
  const saved=await f.service.recipes.configure(f.path,proposal,{},value.fingerprint);assert.equal(saved.source,'Host-local');assert.equal(saved.preparationStatus,'review');
  assert.equal(await readFile(join(f.path,'package.json'),'utf8'),before);await assert.rejects(readFile(join(f.path,'.rootlane.json')));
  assert.equal((await f.service.recipes.inspect(f.path)).source,'Host-local');
  await writeFile(join(f.path,'.rootlane.json'),JSON.stringify(simpleRecipe()));assert.equal((await f.service.recipes.inspect(f.path)).source,'Project-shared');
  const authoritative=await f.service.recipes.inspectEnvironment(f.path);await assert.rejects(f.service.recipes.configure(f.path,proposal,{},authoritative.fingerprint),/cannot replace/);
});
test('workspace and FastAPI proposals require evidence and report uncertainty without imports',async t=>{
  const f=await application(t);await mkdir(join(f.path,'apps/web'),{recursive:true});
  await writeFile(join(f.path,'package.json'),JSON.stringify({workspaces:['apps/*'],packageManager:'missing-manager@1'}));
  await writeFile(join(f.path,'apps/web/package.json'),JSON.stringify({scripts:{dev:'vite --mode custom'},devDependencies:{vite:'7'}}));
  let value=await f.service.recipes.inspectEnvironment(f.path);assert(value.blockers.some(b=>b.code==='CUSTOM_LAUNCHER'));assert(value.blockers.some(b=>b.code==='TOOLCHAIN_MISSING'));assert.equal(value.proposal,null);
  await writeFile(join(f.path,'requirements.txt'),'fastapi\nuvicorn\n');await writeFile(join(f.path,'main.py'),"raise RuntimeError('MUST NEVER IMPORT')\napp = FastAPI()\n");
  value=await f.service.recipes.inspectEnvironment(f.path);assert(recipeSchema.parse(value.proposal).services.some(s=>s.command.includes('main:app')));assert.equal(f.host.starts,0);
  await writeFile(join(f.path,'app.py'),'other = FastAPI()');value=await f.service.recipes.inspectEnvironment(f.path);assert(value.blockers.some(b=>b.code==='COMMAND_AMBIGUOUS'));
});
test('workspace services reuse hoisted Vite and do not launch the workspace orchestrator',async t=>{
  const f=await application(t);await mkdir(join(f.path,'apps/client'),{recursive:true});
  await writeFile(join(f.path,'package.json'),JSON.stringify({workspaces:['apps/*'],scripts:{dev:'npm run dev --workspaces'},devDependencies:{vite:'7'}}));await writeFile(join(f.path,'apps/client/package.json'),JSON.stringify({name:'client',scripts:{dev:'vite'}}));await symlink(join(process.cwd(),'node_modules'),join(f.path,'node_modules'));
  const inspection=await f.service.recipes.inspectEnvironment(f.path),recipe=recipeSchema.parse(inspection.proposal);assert.equal(recipe.services.length,1);assert.equal(recipe.services[0].cwd,'apps/client');assert.equal(inspection.blockers.length,0);
  const saved=await f.service.recipes.configure(f.path,recipe,{},inspection.fingerprint);await f.service.recipes.runPreparation(f.path,saved.fingerprint,randomUUID());await f.service.recipes.drain();const prepared=await f.service.recipes.inspectEnvironment(f.path);assert.equal(prepared.preparationStatus,'succeeded');assert(!prepared.blockers.some(b=>b.code==='DEPENDENCIES_MISSING'));
});
test('all required variable names and file locations are reported without private values',async t=>{
  const f=await application(t),recipe=simpleRecipe(),file=join(f.root,'private.env');
  await writeFile(file,'PRESENT=private-sentinel\n',{mode:0o600});recipe.services[0].requiredEnv=['PRESENT','DATABASE_URL','API_TOKEN'];recipe.services[0].envFile=file;recipe.services[0].env.PRESENT='';
  await reviewed(f,recipe);const result=await f.service.recipes.inspectEnvironment(f.path);
  assert.deepEqual(result.requiredEnv.map(v=>[v.name,v.missing]),[['PRESENT',false],['DATABASE_URL',true],['API_TOKEN',true]]);
  assert.equal(result.blockers.filter(b=>b.code==='ENV_REQUIRED').length,2);assert(!JSON.stringify(result).includes('private-sentinel'));
  f.host.missing=true;f.host.guardedRoutes=async()=>false;(f.host as import('../src/host/types.js').Host).connection=async()=>({status:'unavailable',hostname:null});const blocked=await f.service.recipes.inspectEnvironment(f.path);for(const code of ['ENV_REQUIRED','MISSING_CAPABILITY','GUARDED_WRITES_UNAVAILABLE','TAILSCALE_UNAVAILABLE'])assert(blocked.blockers.some(b=>b.code===code),code);
});
test('preparation approval binds exact revisions, jobs, retries and interruption; Start cannot bypass it',async t=>{
  const f=await application(t),recipe=simpleRecipe();recipe.preparation=[{command:['/bin/true'],cwd:'.',writes:['node_modules'],lifecycleScripts:true,timeoutMs:1000}];
  const id=await reviewed(f,recipe);await assert.rejects(f.service.call('start_environment',request(id)),/preparation|approval/i);
  let finish!:()=>void,calls=0;
  f.host.runPreparation=async()=>{calls++;await new Promise<void>(resolve=>finish=resolve);};
  const current=await f.service.recipes.inspectEnvironment(f.path),input=randomUUID();
  await assert.rejects(f.service.recipes.runPreparation(f.path,'a'.repeat(64),randomUUID()),/review/);
  await f.service.recipes.runPreparation(f.path,current.fingerprint,input);
  while(!finish)await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.service.recipes.inspectEnvironment(f.path)).preparationProgress?.step,1);
  await writeFile(join(f.path,'.rootlane.json'),JSON.stringify(simpleRecipe()));assert.equal((await f.service.recipes.inspectEnvironment(f.path)).preparationStatus,'running');await rm(join(f.path,'.rootlane.json'));
  assert.equal((await f.service.recipes.runPreparation(f.path,current.fingerprint,input)).status,'running');assert.equal(calls,1);
  await assert.rejects(f.service.call('start_environment',request(id)),/preparation|approval/i);
  finish();await f.service.recipes.drain();assert.equal((await f.service.recipes.inspectEnvironment(f.path)).preparationStatus,'succeeded');
  await f.service.recipes.decide((await f.service.recipes.inspect(f.path)).approvalId!,true);
  await f.service.call('start_environment',request(id));await f.lifecycle.drain();assert.equal((await f.lifecycle.get({environmentId:id})).application,'ready');
  await f.service.call('stop_environment',request(id));await f.lifecycle.drain();
  await writeFile(join(f.path,'package-lock.json'),'{}');assert.equal((await f.service.recipes.inspectEnvironment(f.path)).preparationStatus,'review');assert.equal((await f.service.recipes.inspect(f.path)).approval,'stale');
  const interruptedId=randomUUID();f.store.db.prepare("INSERT INTO preparations VALUES (?,?,?,'running','[]',NULL,NULL,?,NULL)").run(interruptedId,f.path,current.fingerprint,new Date().toISOString());await f.service.recipes.reconcilePreparation();assert.equal((f.store.db.prepare('SELECT status FROM preparations WHERE id=?').get(interruptedId) as {status:string}).status,'interrupted');
});
test('failed preparation cleanup blocks retries, configuration and Start until owner cleanup verifies ownership',async t=>{
  const f=await application(t),recipe=simpleRecipe();recipe.preparation=[{command:['/bin/true'],cwd:'.',writes:['node_modules'],lifecycleScripts:true,timeoutMs:1000}];
  const id=await reviewed(f,recipe),inspection=await f.service.recipes.inspectEnvironment(f.path),job=randomUUID();let calls=0;
  f.host.runPreparation=async unit=>{calls++;f.host.units.set(unit.name,{state:'active',marker:unit.marker,cgroup:'',invocation:''});throw new Error('job observation lost');};f.host.failStop=true;
  await f.service.recipes.runPreparation(f.path,inspection.fingerprint,job);await f.service.recipes.drain();
  assert.equal((await f.service.recipes.inspectEnvironment(f.path)).preparationError?.code,'PREPARATION_CLEANUP_REQUIRED');
  await f.service.recipes.reconcilePreparation();assert.equal((await f.service.recipes.inspectEnvironment(f.path)).preparationError?.code,'PREPARATION_CLEANUP_REQUIRED');
  await assert.rejects(f.service.recipes.runPreparation(f.path,inspection.fingerprint,randomUUID()),/cleanup/i);assert.equal(calls,1);
  await assert.rejects(f.service.recipes.configure(f.path,recipe,{},inspection.fingerprint),/cleanup/i);
  await assert.rejects(f.service.recipes.decide((await f.service.recipes.inspect(f.path)).approvalId!,true),/cleanup/i);
  await assert.rejects(f.service.call('start_environment',request(id)),/cleanup|approval/i);
  const unit=[...f.host.units.values()][0],marker=unit.marker;unit.marker='unrelated';f.host.failStop=false;
  await assert.rejects(f.service.recipes.cleanupPreparation(job),(error:unknown)=>error instanceof Problem && error.code==='OWNERSHIP_CONFLICT');assert.equal(f.host.units.size,1);
  unit.marker=marker;await f.service.recipes.cleanupPreparation(job);assert.equal(f.host.units.size,0);assert(! (await f.service.recipes.inspectEnvironment(f.path)).blockers.some(b=>b.code==='PREPARATION_CLEANUP_REQUIRED'));
  f.host.runPreparation=async()=>{};await f.service.recipes.runPreparation(f.path,inspection.fingerprint,randomUUID());await f.service.recipes.drain();assert.equal((await f.service.recipes.inspectEnvironment(f.path)).preparationStatus,'succeeded');
});
for(const file of ['package.json','package-lock.json','tools/package-lock.json'])test(`preparation retains reviewed fingerprint when ${file} changes during installation`,async t=>{
  const f=await application(t),recipe=simpleRecipe();await mkdir(join(f.path,'tools'));recipe.preparation=[{command:['/bin/true'],cwd:file.startsWith('tools/')?'tools':'.',writes:['node_modules'],lifecycleScripts:true,timeoutMs:1000}];const id=await reviewed(f,recipe);
  const inspection=await f.service.recipes.inspectEnvironment(f.path),job=randomUUID();f.host.runPreparation=async()=>{await writeFile(join(f.path,file),JSON.stringify({dependencies:{unreviewed:'1.0.0'}}));};
  await f.service.recipes.runPreparation(f.path,inspection.fingerprint,job);await f.service.recipes.drain();
  const after=await f.service.recipes.inspectEnvironment(f.path);assert.equal(after.preparationStatus,'review');assert.equal(after.preparationError?.code,'PREPARATION_CHANGED');
  assert.equal((f.store.db.prepare('SELECT fingerprint FROM preparations WHERE id=?').get(job) as {fingerprint:string}).fingerprint,inspection.fingerprint);
  assert.equal((await f.service.recipes.runPreparation(f.path,inspection.fingerprint,job)).status,'failed');
  await assert.rejects(f.service.call('start_environment',request(id)),/preparation|approval/i);
  const review=await f.service.recipes.request(f.path,randomUUID());await assert.rejects(f.service.recipes.decide(new URL(review.approvalUrl).searchParams.get('approval')!,true),/preparation/i);
  f.host.runPreparation=async()=>{};await f.service.recipes.runPreparation(f.path,after.fingerprint,randomUUID());await f.service.recipes.drain();assert.equal((await f.service.recipes.inspectEnvironment(f.path)).preparationStatus,'succeeded');
});
test('configuration, preparation, retirement, policy and integration repairs require owner cookie and CSRF',async t=>{
  const f=await application(t),app=await createServer(f.config,f.service,{owner:'owner',agent:'a'.repeat(40)});t.after(()=>app.close());
  for(const name of ['configuration','preparation','retirement','recovery-policy','integrations','telemetry-policy','export-recipe']) {
    assert.equal((await app.inject({method:'POST',url:'/api/owner/'+name,headers:{host:`127.0.0.1:${f.config.port}`,authorization:`Bearer ${'a'.repeat(40)}`},payload:{}})).statusCode,403);
  }
  const headers={host:new URL(f.config.origin).host,origin:f.config.origin};const login=await app.inject({method:'POST',url:'/api/login',headers,payload:{credential:'owner'}});const cookie=String(login.headers['set-cookie']).split(';')[0];
  assert.equal((await app.inject({method:'POST',url:'/api/owner/preparation',headers:{...headers,cookie},payload:{}})).statusCode,403);
  const cleanup='/api/owner/preparation/'+randomUUID()+'/cleanup';
  assert.equal((await app.inject({method:'POST',url:cleanup,headers:{...headers,cookie},payload:{}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:cleanup,headers:{host:`127.0.0.1:${f.config.port}`,authorization:`Bearer ${'a'.repeat(40)}`},payload:{}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:cleanup,headers:{...headers,cookie,'x-rootlane-csrf':login.json().csrf},payload:{}})).statusCode,404);
  const inspection=await f.service.recipes.inspectEnvironment(f.path);
  const saved=await app.inject({method:'POST',url:'/api/owner/configuration',headers:{...headers,cookie,'x-rootlane-csrf':login.json().csrf},payload:{path:f.path,recipe:inspection.proposal,tools:{},fingerprint:inspection.fingerprint}});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().source,'Host-local');
});
test('stopped conflicting allocations move URLs; verified retirement frees reservations and retains history',async t=>{
  const f=await application(t),id=await reviewed(f);let instance=f.service.recipes.instances()[0],old=JSON.parse(instance.allocations);
  f.host.busyPorts=[old.ports.web];const replacement=await f.service.recipes.request(f.path,randomUUID());assert.notEqual(replacement.resolvedPreview.services[0].port,old.ports.web);
  await f.service.call('start_environment',request(id));await f.lifecycle.drain();await assert.rejects(f.service.recipes.retire(id),/Stop/);
  await f.service.call('stop_environment',request(id));await f.lifecycle.drain();await f.service.call('start_environment',request(id));await f.lifecycle.drain();await f.service.call('stop_environment',request(id));await f.lifecycle.drain();const operations=f.store.recent(id).map(o=>o.id);
  const lastUnit=JSON.parse(f.store.resources(id,true).filter(r=>r.kind==='unit').at(-1)!.data);f.host.units.set(lastUnit.name,{state:'inactive',marker:lastUnit.marker,cgroup:'',invocation:lastUnit.invocation});
  await f.service.recipes.retire(id);assert.equal(f.service.recipes.instances().length,0);assert.equal((f.store.db.prepare('SELECT count(*) n FROM reservations WHERE instance=?').get(id) as {n:number}).n,0);assert.deepEqual(f.store.recent(id).map(o=>o.id),operations);
  const priorRequest=(f.store.db.prepare('SELECT id FROM recipe_requests WHERE instanceId=? LIMIT 1').get(id) as {id:string}).id;await assert.rejects(f.service.recipes.request(f.path,priorRequest),/retired instance/);assert.equal(f.service.recipes.instances().length,0);
});
test('Start automatically reallocates stopped conflicts and preserves virtual-environment interpreter paths',async t=>{
  const f=await application(t),recipe=simpleRecipe(),venv=join(f.path,'.venv');await mkdir(join(venv,'bin'),{recursive:true});await symlink(process.execPath,join(venv,'bin/python'));
  recipe.services[0].command=['{venv}/bin/python','server.py'];const id=await reviewed(f,recipe),old=(await f.lifecycle.get({environmentId:id})).ports!.web;f.host.busyPorts=[old];
  let invoked='';const start=f.host.startUnit.bind(f.host);f.host.startUnit=async(unit,service)=>{invoked=service.executable;return start(unit,service);};
  await f.service.call('start_environment',request(id));await f.lifecycle.drain();assert.equal(invoked,join(venv,'bin/python'));assert.notEqual((await f.lifecycle.get({environmentId:id})).ports!.web,old);
});
test('HTTPS failure is partial; durable recovery repairs missing routes without restarting healthy services',async t=>{
  const f=await application(t),id=await reviewed(f);f.host.probe=async()=>false;
  const accepted=await f.service.call('start_environment',request(id));await f.lifecycle.drain();assert.equal(f.store.latest(id)?.status,'partial');assert.equal(f.store.latest(id)?.error?.code,'HTTPS_UNVERIFIED');assert.equal(f.host.units.size,1);
  f.host.probe=async()=>true;f.host.routesMap.clear();const input=request(id),operation=await f.service.call('recover_environment',input);await f.lifecycle.drain();
  assert.equal(f.store.latest(id)?.action,'recover');assert.equal(f.store.latest(id)?.status,'succeeded');assert.equal(f.host.starts,1);assert.deepEqual(await f.service.call('recover_environment',input),{...operation,operation:f.store.latest(id)});
  const route=f.store.resources(id).find(r=>r.kind==='route')!;f.host.routesMap.set(JSON.parse(route.data).port,'http://unrelated');await f.service.call('recover_environment',request(id));await f.lifecycle.drain();assert.equal(f.store.latest(id)?.error?.code,'ROUTE_CONFLICT');assert.equal(f.host.starts,1);assert.equal(f.host.routesMap.get(JSON.parse(route.data).port),'http://unrelated');
});
test('preview paths are visible and HTTPS verifies the actual Open destination',async t=>{
  const f=await application(t),recipe=simpleRecipe();recipe.previews[0].path='/docs';const id=await reviewed(f,recipe);
  (f.host as import('../src/host/types.js').Host).probe=async(_url,readiness)=>readiness.path!=='/docs';
  await f.service.call('start_environment',request(id));await f.lifecycle.drain();const state=await f.lifecycle.get({environmentId:id});assert(state.previews![0].url.endsWith('/docs'));assert.equal(state.preview,'unavailable');assert.equal(f.store.latest(id)?.error?.code,'HTTPS_UNVERIFIED');
});
test('existing private host profiles remain usable without a project recipe',async t=>{
  const f=await setup(t),service=new Rootlane(new Catalog(f.config,f.host,f.store),f.lifecycle);const inspection=await service.recipes.inspectEnvironment(f.root);assert.equal(inspection.source,'Host-local');assert.equal(inspection.proposal,null);assert.equal(inspection.nextAction,'Start');assert.equal(f.host.starts,0);
  f.lifecycle.accept('start',request());await f.lifecycle.drain();await assert.rejects(service.recipes.configure(f.root,simpleRecipe(),{},inspection.fingerprint),/Stop this checkout/);
});
test('Tailscale loss marks previews unavailable and reconnect repairs only absent recorded routes',async t=>{
  const f=await application(t),id=await reviewed(f);await f.service.call('start_environment',request(id));await f.lifecycle.drain();
  const connection=f.host.connection.bind(f.host);(f.host as import('../src/host/types.js').Host).connection=async()=>({status:'unavailable',hostname:null});
  const offline=await f.lifecycle.get({environmentId:id});assert.equal(offline.application,'ready');assert.equal(offline.preview,'unavailable');assert.equal(f.host.units.size,1);
  f.host.routesMap.clear();await f.service.maintain();assert.equal(f.host.routesMap.size,0);
  f.host.connection=connection;await f.service.maintain();assert.equal(f.host.routesMap.size,1);assert.equal(f.host.starts,1);assert.equal((await f.lifecycle.get({environmentId:id})).preview,'available');
});
test('interrupted recovery rolls back unhealthy resources created by that recovery',async t=>{
  const f=await application(t),id=await reviewed(f);await f.service.call('start_environment',request(id));await f.lifecycle.drain();f.host.units.clear();
  await f.service.call('recover_environment',request(id));await f.lifecycle.drain();const operation=f.store.latest(id)!;assert.equal(operation.action,'recover');assert.equal(operation.status,'succeeded');
  f.store.finish(operation.id,'running');f.host.unready='web';await f.lifecycle.reconcile();assert.equal(f.store.latest(id)?.error?.code,'INTERRUPTED');assert.equal(f.store.resources(id).length,0);assert.equal(f.host.units.size,0);
});
test('approved automatic restarts keep recorded attribution and logs, including unavailable cwd evidence',async t=>{
  const f=await application(t),recipe=simpleRecipe();recipe.restart='on-failure';const id=await reviewed(f,recipe);await f.service.call('start_environment',request(id));await f.lifecycle.drain();
  const resource=f.store.resources(id).find(r=>r.kind==='unit')!,unit=JSON.parse(resource.data),current=f.host.units.get(unit.name)!;
  current.invocation=randomUUID().replaceAll('-','');current.restart='on-failure';current.restarts=1;
  f.host.listeners=async()=>[{address:'127.0.0.1',port:unit.port,pid:123456,cwd:null,cgroup:current.cgroup}];
  const catalog=await f.service.catalog.list({rescan:true});assert.equal(catalog.projects.find(p=>p.path===f.path)?.runtime.listeners?.[0].managedBy?.environmentId,id);assert(!catalog.scan.unmatchedListeners.includes(unit.port));
  let logged='';f.host.logs=async observed=>{logged=observed.invocation!;return {lines:['restarted'],nextCursor:'cursor',truncated:false};};
  await f.lifecycle.logs({environmentId:id,serviceId:'web'});assert.equal(logged,current.invocation);
  current.invocation=randomUUID().replaceAll('-','');current.restarts=2;await f.lifecycle.logs({environmentId:id,serviceId:'web'});assert.equal(logged,current.invocation);
  current.invocation=randomUUID().replaceAll('-','');current.restart='no';const unrelated=await f.service.catalog.list({rescan:true});assert(!unrelated.projects.find(p=>p.path===f.path)?.runtime.listeners?.some(l=>l.managedBy));
});
test('reboot restoration attempts survive controller restarts, exhaust at three, and deliberate Stop cancels them',async t=>{
  const f=await application(t),id=await reviewed(f);await f.service.recoveryPolicy(id,true);await f.service.call('start_environment',request(id));await f.lifecycle.drain();
  f.host.units.clear();f.host.boot='boot-2';await f.lifecycle.reconcile();f.host.missing=true;
  await f.service.maintain();await f.service.maintain();
  const restarted=new Rootlane(new Catalog(f.config,f.host,f.store),new Lifecycle(f.config,f.store,f.host));await restarted.lifecycle.reconcile();await restarted.publications.reconcile();await restarted.maintain();await restarted.maintain();
  assert.equal((f.store.db.prepare('SELECT attempts FROM recovery_preferences WHERE environmentId=?').get(id) as {attempts:number}).attempts,3);
  await restarted.call('stop_environment',request(id));await restarted.lifecycle.drain();f.host.missing=false;await restarted.maintain();assert.equal(f.store.environment(id)?.desired,'stopped');assert.equal(f.host.units.size,0);
});
test('Stop remains authoritative while a reboot restoration is already starting',async t=>{
  const f=await application(t),id=await reviewed(f);await f.service.recoveryPolicy(id,true);await f.service.call('start_environment',request(id));await f.lifecycle.drain();f.host.units.clear();f.host.boot='boot-2';await f.lifecycle.reconcile();
  const original=f.host.startUnit.bind(f.host);let release!:()=>void;f.host.startUnit=async(unit,service)=>{await original(unit,service);await new Promise<void>(resolve=>release=resolve);};
  const restoration=f.service.maintain();while(!release)await new Promise(resolve=>setImmediate(resolve));
  await f.service.call('stop_environment',request(id));release();await restoration;await f.lifecycle.drain();assert.equal(f.store.environment(id)?.desired,'stopped');assert.equal(f.host.units.size,0);assert.equal(f.store.latest(id)?.action,'stop');assert.equal(f.store.latest(id)?.status,'succeeded');
});
test('rescan invalidates metadata immediately, coalesces concurrent calls, excludes leaf folders and discovers nested repositories',async t=>{
  const f=await application(t);await mkdir(join(f.path,'empty'));await command('git',['init',f.path]);const catalog=f.service.catalog;await catalog.list({});
  const nested=join(f.path,'nested');await mkdir(nested);await command('git',['init',nested]);
  let calls=0;const original=f.host.listeners.bind(f.host);f.host.listeners=async()=>{calls++;return original();};
  const [one,two]=await Promise.all([catalog.list({rescan:true}),catalog.list({rescan:true})]);assert.equal(calls,1);assert.equal(one.observedAt,two.observedAt);assert(one.projects.some(p=>p.path===nested));assert(!one.projects.some(p=>p.path.endsWith('/empty')));assert(one.scan);
});
test('missing checkout retains actionable Stop and retirement records',async t=>{
  const f=await application(t),id=await reviewed(f);await rm(f.path,{recursive:true});const result=await f.service.catalog.list({rescan:true});const project=result.projects.find(p=>p.path===f.path);assert(project?.missing);assert(project.controls?.some(c=>c.id===id));
  await f.service.call('stop_environment',request(id));await f.lifecycle.drain();await f.service.recipes.retire(id);assert.equal(f.service.recipes.instances().length,0);
});
test('additive migration preserves populated approvals, allocations, operations, IDs and ownership',async t=>{
  const f=await application(t),id=await reviewed(f);await f.service.call('start_environment',request(id));await f.lifecycle.drain();const path=join(f.root,'migration.sqlite');await f.store.db.backup(path);
  const {default:Database}=await import('better-sqlite3');const old=new Database(path);old.exec('DROP TABLE recovery_operations; DROP TABLE recovery_preferences; DROP TABLE retired_instances; DROP TABLE preparations; DROP TABLE local_recipes; PRAGMA user_version=5');old.close();
  const migrated=new Store(path);t.after(()=>migrated.close());assert.equal(migrated.installation,f.store.installation);
  for(const table of ['approvals','instances','environments','operations','resources','reservations'])assert.deepEqual(migrated.db.prepare(`SELECT * FROM ${table}`).all(),f.store.db.prepare(`SELECT * FROM ${table}`).all());
  assert.equal(migrated.db.pragma('user_version',{simple:true}),6);
});
