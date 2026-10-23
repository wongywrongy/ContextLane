import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup, request } from './helpers.js';
import { Catalog } from '../src/catalog/discovery.js';
import { Rootlane } from '../src/service.js';
import { recipeSchema } from '../src/recipes.js';
import { command } from '../src/host/command.js';
import { createServer } from '../src/http/server.js';
import { toolContracts, Problem } from '../src/shared/contracts.js';
const recipe = {version:1,services:[{id:'web',cwd:'.',command:['{node}','server.mjs','--port','{port:web}'],env:{PUBLIC_ORIGIN:'{preview:web}',STATE_PATH:'{state}'},readiness:{path:'/',status:200,bodyIncludes:'fixture'}}],previews:[{serviceId:'web',label:'Fixture'}],setup:['npm install']};
async function fixture(t:Parameters<typeof setup>[0]) {
 const f=await setup(t),repo=join(f.root,'repo'),worktree=join(f.root,'branch');await mkdir(repo);f.config.profiles=[];f.config.observationRoots=[repo,worktree];f.config.toolchains={node:process.execPath,venvs:{}};
 await command('git',['init',repo]);await writeFile(join(repo,'.rootlane.json'),JSON.stringify(recipe));await command('git',['-C',repo,'add','.rootlane.json']);await command('git',['-C',repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','recipe']);await command('git',['-C',repo,'worktree','add','-b','other',worktree]);
 const service=new Rootlane(new Catalog(f.config,f.host,f.store),f.lifecycle);return {...f,repo,worktree,service};
}
test('strict recipe schema rejects secrets, wrappers, escapes, unknown placeholders and dependency cycles',()=>{
 assert(recipeSchema.safeParse(recipe).success);
 for(const service of [{...recipe.services[0],env:{API_TOKEN:'secret'}},{...recipe.services[0],command:['/usr/bin/env','node']},{...recipe.services[0],command:['bash','-c','run']},{...recipe.services[0],cwd:'backend/../..'},{...recipe.services[0],command:['{unknown}']},{...recipe.services[0],dependencies:['web']}])assert(!recipeSchema.safeParse({...recipe,services:[service]}).success);
 assert(!recipeSchema.safeParse({...recipe,unknown:true}).success);
});
test('owner cookie and CSRF approve; agent cannot approve; stale recipes block Start but preserve Stop',async t=>{
 const f=await fixture(t);const result=toolContracts.request_environment.output.parse(await f.service.call('request_environment',{path:f.repo,requestId:randomUUID()}));assert.equal(result.status,'pending');assert.equal(f.host.starts,0);
 const id=result.resolvedPreview.instanceId,approvalId=new URL(result.approvalUrl).searchParams.get('approval')!;
 await assert.rejects(f.service.call('start_environment',request(id)),(e:unknown)=>e instanceof Problem&&e.code==='APPROVAL_REQUIRED'&&e.approvalUrl===result.approvalUrl);
 const app=await createServer(f.config,f.service,{owner:'owner',agent:'a'.repeat(40)});t.after(()=>app.close());const url=`/api/approvals/${approvalId}/approve`;
 assert.equal((await app.inject({method:'POST',url,headers:{host:`127.0.0.1:${f.config.port}`,authorization:`Bearer ${'a'.repeat(40)}`},payload:{}})).statusCode,403);
 const headers={host:new URL(f.config.origin).host,origin:f.config.origin};const login=await app.inject({method:'POST',url:'/api/login',headers,payload:{credential:'owner'}});const cookie=String(login.headers['set-cookie']).split(';')[0];
 assert.equal((await app.inject({method:'POST',url,headers:{...headers,cookie},payload:{}})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url,headers:{...headers,cookie,'x-rootlane-csrf':login.json().csrf},payload:{}})).statusCode,200);
 await f.service.call('start_environment',request(id));await f.lifecycle.drain();assert.equal((await f.lifecycle.get({environmentId:id})).application,'ready');
 await writeFile(join(f.repo,'.rootlane.json'),JSON.stringify({...recipe,setup:['changed']}));assert.equal((await f.service.recipes.inspect(f.repo)).approval,'stale');await assert.rejects(f.service.call('start_environment',request(id)),(e:unknown)=>e instanceof Problem&&e.code==='APPROVAL_REQUIRED');
 await f.service.call('stop_environment',request(id));await f.lifecycle.drain();assert.equal(f.store.resources(id).length,0);
});
test('two worktrees reserve distinct ports and previews, reuse approval, and stop independently',async t=>{
 const f=await fixture(t);const req={path:f.repo,requestId:randomUUID()};const one=toolContracts.request_environment.output.parse(await f.service.call('request_environment',req));assert.deepEqual(await f.service.call('request_environment',req),one);await f.service.recipes.decide(new URL(one.approvalUrl).searchParams.get('approval')!,true);
 const two=toolContracts.request_environment.output.parse(await f.service.call('request_environment',{path:f.worktree,requestId:randomUUID()}));assert.equal(two.status,'approved');assert.notEqual(one.resolvedPreview.instanceId,two.resolvedPreview.instanceId);
 const ports=[...one.resolvedPreview.services.map(s=>s.port),...one.resolvedPreview.previews.map(s=>s.port),...two.resolvedPreview.services.map(s=>s.port),...two.resolvedPreview.previews.map(s=>s.port)];assert.equal(new Set(ports).size,4);
 for(const r of [one,two]){await f.service.call('start_environment',request(r.resolvedPreview.instanceId));await f.lifecycle.drain();assert.equal((await f.lifecycle.get({environmentId:r.resolvedPreview.instanceId})).preview,'available');}
 await f.service.call('stop_environment',request(one.resolvedPreview.instanceId));await f.lifecycle.drain();assert.equal((await f.lifecycle.get({environmentId:two.resolvedPreview.instanceId})).application,'ready');assert.equal(f.host.routesMap.size,1);
 await f.service.call('stop_environment',request(two.resolvedPreview.instanceId));await f.lifecycle.drain();assert.equal(f.host.routesMap.size,0);
 const located=toolContracts.locate.output.parse(await f.service.call('locate',{path:f.worktree}));assert.equal(located.recipe?.approval,'approved');assert.equal(located.instances?.[0].id,two.resolvedPreview.instanceId);
});
test('toolchain revision and request IDs bind reviews; env files are private and values never escape',async t=>{
 const f=await fixture(t),secret=join(f.root,'dev.env'),value='private-value-abcdef';await writeFile(secret,`API_TOKEN=${value}\n`,{mode:0o600});await writeFile(join(f.repo,'.rootlane.json'),JSON.stringify({...recipe,services:[{...recipe.services[0],envFile:secret}]}));
 const input={path:f.repo,requestId:randomUUID()},review=toolContracts.request_environment.output.parse(await f.service.call('request_environment',input));assert(!JSON.stringify(review).includes(value));assert(review.resolvedPreview.services[0].envNames.includes('API_TOKEN'));
 await f.service.recipes.decide(new URL(review.approvalUrl).searchParams.get('approval')!,true);let actual:Record<string,string>|undefined;const start=f.host.startUnit.bind(f.host);f.host.startUnit=async(u,s)=>{actual=s.env;return start(u,s);};f.host.logs=async()=>({lines:[`echo ${value}`],nextCursor:'cursor',truncated:false});
 const id=review.resolvedPreview.instanceId;await f.service.call('start_environment',request(id));await f.lifecycle.drain();assert.equal(actual?.API_TOKEN,undefined);assert.equal(f.service.recipes.profiles.get(id)!.services[0].envFile,secret);assert(actual?.ROOTLANE_PREVIEW_ORIGIN);assert(actual?.ROOTLANE_PORT);assert(actual?.ROOTLANE_PREVIEW_PORT);
 const logs=await f.service.call('get_logs',{environmentId:id,serviceId:'web'});assert(!JSON.stringify(logs).includes(value));assert(JSON.stringify(logs).includes('[redacted]'));assert(!JSON.stringify(await f.service.call('get_environment',{environmentId:id})).includes(value));assert(!JSON.stringify(await f.service.recipes.listApprovals()).includes(value));
 await f.service.call('stop_environment',request(id));await f.lifecycle.drain();await chmod(secret,0o644);await assert.rejects(f.service.call('start_environment',request(id)),/mode 0600/);await chmod(secret,0o600);
 f.config.toolchains.node='/bin/true';assert.equal((await f.service.recipes.inspect(f.repo)).approval,'stale');await assert.rejects(f.service.call('start_environment',request(id)),(e:unknown)=>e instanceof Problem&&e.code==='APPROVAL_REQUIRED');await assert.rejects(f.service.call('request_environment',input),/Recipe changed/);
 delete f.config.toolchains.node;assert.equal((await f.service.recipes.inspect(f.repo)).valid,true); // Host Node is detected when an override is removed.
});
test('recipe reviews keep snapshots consistent, reject stale approval and rejected starts, and survive restart',async t=>{
 const f=await fixture(t);const pending=toolContracts.request_environment.output.parse(await f.service.call('request_environment',{path:f.repo,requestId:randomUUID()}));const id=pending.resolvedPreview.instanceId,approvalId=new URL(pending.approvalUrl).searchParams.get('approval')!;
 const before=toolContracts.list_projects.output.parse(await f.service.call('list_projects',{}));assert.equal(before.projects.find(p=>p.path===f.repo)?.recipe?.approval,'pending');await f.service.recipes.decide(approvalId,true);
 const snapshot=toolContracts.list_projects.output.parse(await f.service.call('list_projects',{snapshot:before.observedAt}));assert.equal(snapshot.projects.find(p=>p.path===f.repo)?.recipe?.approval,'pending');
 const after=toolContracts.list_projects.output.parse(await f.service.call('list_projects',{}));assert.equal(after.projects.find(p=>p.path===f.repo)?.controls?.[0].startAllowed,true);
 await f.service.call('start_environment',request(id));await f.lifecycle.drain();f.service.recipes.profiles.clear();await f.lifecycle.reconcile();assert.equal((await f.service.call('get_environment',{environmentId:id}) as {startAllowed:boolean}).startAllowed,true);await f.service.call('stop_environment',request(id));await f.lifecycle.drain();
 await writeFile(join(f.repo,'.rootlane.json'),JSON.stringify({...recipe,setup:['new review']}));const next=toolContracts.request_environment.output.parse(await f.service.call('request_environment',{path:f.repo,requestId:randomUUID()}));const nextId=new URL(next.approvalUrl).searchParams.get('approval')!;await writeFile(join(f.repo,'.rootlane.json'),JSON.stringify({...recipe,setup:['changed again']}));await assert.rejects(f.service.recipes.decide(nextId,true),/changed/);await f.service.recipes.decide(nextId,false);
 const reject=toolContracts.request_environment.output.parse(await f.service.call('request_environment',{path:f.repo,requestId:randomUUID()}));await f.service.recipes.decide(new URL(reject.approvalUrl).searchParams.get('approval')!,false);await assert.rejects(f.service.call('request_environment',{path:f.repo,requestId:randomUUID()}),/rejected/);await assert.rejects(f.service.call('start_environment',request(id)),(e:unknown)=>e instanceof Problem&&e.code==='APPROVAL_REQUIRED');
});
test('recipe requests cannot claim another action UUID or env files inside observation roots',async t=>{
 const f=await fixture(t);const input={path:f.repo,requestId:randomUUID()},review=toolContracts.request_environment.output.parse(await f.service.call('request_environment',input));await assert.rejects(f.service.call('stop_environment',{environmentId:review.resolvedPreview.instanceId,requestId:input.requestId}),/another|request/);
 const secret=join(f.repo,'dev.env');await writeFile(secret,'TOKEN=hidden',{mode:0o600});await writeFile(join(f.repo,'.rootlane.json'),JSON.stringify({...recipe,services:[{...recipe.services[0],envFile:secret}]}));await assert.rejects(f.service.call('request_environment',{path:f.repo,requestId:randomUUID()}),/outside observation roots/);
 assert.equal(f.host.starts,0);assert.equal((await f.service.recipes.listApprovals()).length,1);
});
test('a stopped instance reports replacement service allocations before the next launch',async t=>{
 const f=await fixture(t);const first=toolContracts.request_environment.output.parse(await f.service.call('request_environment',{path:f.repo,requestId:randomUUID()}));await f.service.recipes.decide(new URL(first.approvalUrl).searchParams.get('approval')!,true);
 const changed={...recipe,services:[{...recipe.services[0],id:'console',command:['{node}','server.mjs','--port','{port:console}'],env:{PUBLIC_ORIGIN:'{preview:console}'}}],previews:[{serviceId:'console',label:'Console'}]};await writeFile(join(f.repo,'.rootlane.json'),JSON.stringify(changed));const next=toolContracts.request_environment.output.parse(await f.service.call('request_environment',{path:f.repo,requestId:randomUUID()}));const state=toolContracts.get_environment.output.parse(await f.service.call('get_environment',{environmentId:next.resolvedPreview.instanceId}));assert.deepEqual(state.ports,{console:next.resolvedPreview.services[0].port});assert.equal(state.previews?.[0].serviceId,'console');assert.equal(state.startAllowed,false);assert.equal(state.application,'stopped');
});
