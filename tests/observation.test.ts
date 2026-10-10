import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer as httpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setup, request } from './helpers.js';
import { Catalog } from '../src/catalog/discovery.js';
import { Rootlane } from '../src/service.js';
import { command } from '../src/host/command.js';
import { serviceName, procText } from '../src/host/process.js';
import { configSchema } from '../src/config.js';
import { toolContracts } from '../src/shared/contracts.js';

test('derived service names recognize dev tools without disclosing command arguments',()=>{
  const cases:[string[],string][]=[[['node','/app/node_modules/vite/bin/vite.js','--token=secret'],'vite'],[['uvicorn','app:app','--password=secret'],'uvicorn'],[['python','-m','http.server'],'python -m http.server'],[['node','/app/server.js','--secret'],'node server.js'],[['python','manage.py','runserver'],'django runserver'],[['cargo','run'],'cargo run'],[['go','run','main.go'],'go run']];
  for(const [argv,name] of cases) assert.equal(serviceName('fallback',argv),name);
  assert.equal(serviceName('custom-server',['custom-server','--password=secret']),'custom-server');
});

test('worktree state, service and agent detail, locate follow strict observational contracts',async t=>{
  const {root,config,host,lifecycle,store}=await setup(t); const repo=join(root,'repo'); await mkdir(repo); config.profiles=[];
  await command('git',['init',repo]); await command('git',['-C',repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','Fixture subject']);
  await writeFile(join(repo,'package.json'),JSON.stringify({scripts:{dev:'vite'}}));
  host.listeners=async()=>[{address:'127.0.0.1',port:19482,pid:123,cwd:repo,cgroup:null,process:{name:'vite',pid:123,startedAt:'2026-10-10T14:02:00.000Z'}}];
  host.agentObservations.agents=[{id:'a'.repeat(24),name:'Claude Code',pid:456,cwd:repo,startedAt:'2026-10-10T14:02:00.000Z'}];
  const service=new Rootlane(new Catalog(config,host,store),lifecycle);
  const listed=await service.call('list_projects',{}); const project=(listed as {projects:import('../src/shared/contracts.js').Project[]}).projects.find(p=>p.path===repo)!;
  assert.equal(project.git?.dirty,1);assert.equal(project.git?.ahead,null);assert.equal(project.git?.behind,null);assert.equal(project.git?.lastCommit?.subject,'Fixture subject');assert.match(project.git?.lastCommit?.sha7!,/^[a-f0-9]{7}$/);
  assert.equal(project.runtime.listeners?.[0].process?.name,'vite');assert.equal(project.runtime.listeners?.[0].checkoutId,project.id);
  const agent=project.agents[0]; if(agent.source!=='detected process')throw Error('wrong source');assert.equal(agent.checkoutId,project.id);assert.equal(agent.startedAt,'2026-10-10T14:02:00.000Z');
  const located=toolContracts.locate.output.parse(await service.call('locate',{path:repo}));assert.equal(located.checkout.id,project.id);assert.deepEqual(located.ports,[{port:19482,name:'vite'}]);
  await assert.rejects(service.call('locate',{path:'/etc'}),/outside observation roots/);
  assert.equal(store.previews().length,0); assert.equal(config.previewTargets.length,0);
  assert.throws(()=>toolContracts.locate.input.parse({path:repo,extra:true}));assert.throws(()=>toolContracts.list_operations.input.parse({limit:21}));
});

test('expanded listener probe uses HEAD then GET only on 405, never promotes readiness, caches 30 seconds',async t=>{
  const {root,config,host}=await setup(t);config.profiles=[];await writeFile(join(root,'package.json'),'{}');
  const methods:string[]=[]; const server=httpServer((req,res)=>{methods.push(req.method!);res.writeHead(req.method==='HEAD'?405:200);res.end('discarded');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const port=(server.address() as AddressInfo).port;host.listeners=async()=>[{address:'127.0.0.1',port,pid:process.pid,cwd:root,cgroup:null}];
  const catalog=new Catalog(config,host);const list=await catalog.list({});assert.deepEqual(methods,[]);
  const first=await catalog.get(list.projects[0].id);assert.equal(first.http?.[0].http.status,200);assert.equal(first.services[0].readiness,'unverified');
  await catalog.get(list.projects[0].id);assert.deepEqual(methods,['HEAD','GET']);
});

test('operation history combines lifecycle and preview errors newest first and bounds output',async t=>{
  const {config,host,lifecycle,store}=await setup(t);const service=new Rootlane(new Catalog(config,host),lifecycle);
  for(let i=0;i<3;i++){lifecycle.accept('start',request());await lifecycle.drain();lifecycle.accept('stop',request());await lifecycle.drain();}
  const result=toolContracts.list_operations.output.parse(await service.call('list_operations',{environmentId:'fixture',limit:2}));assert.equal(result.operations.length,2);assert.equal(result.operations[0].action,'stop');
});

test('editor templates and instance range validate at the config boundary; process reads are bounded',async t=>{
  const {config,root}=await setup(t);
  assert(configSchema.parse({...config,editorUrlTemplate:'vscode://vscode-remote/ssh-remote+{host}{path}'}));
  for(const editorUrlTemplate of ['javascript:alert(1)','https://evil.test/{path}','vscode://{secret}/'])assert.throws(()=>configSchema.parse({...config,editorUrlTemplate}));
  assert.throws(()=>configSchema.parse({...config,instancePorts:[21000,20000]}));
  const path=join(root,'oversized');await writeFile(path,'x'.repeat(257));await assert.rejects(procText(path,256),/metadata limit/);
});
