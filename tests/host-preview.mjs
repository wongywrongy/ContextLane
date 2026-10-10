// Live acceptance: starts and cleans up only this harness's disposable fixture.
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { LinuxHost } from '../dist/host/linux.js';
const repo=resolve('.'),fixture=resolve('fixtures/disposable'),temp=await mkdtemp('/tmp/rootlane-publishing-');
const useInstalled=process.env.ROOTLANE_INSTALLED==='1';
const installed=JSON.parse(await readFile('/home/kyle/.config/rootlane/config.json','utf8'));
const host=new LinuxHost();const originalRoutes=await host.routes();
for(const port of [9491,19481,19482,19484])assert(!(await host.listeners()).some(l=>l.port===port),'Occupied test port '+port);
const target={id:'disposable-web',approved:true,projectPath:repo,checkoutPath:fixture,serviceId:'web',serviceName:'Disposable frontend',port:19482,httpsPort:19484,readiness:{path:'/',status:200,bodyIncludes:'rootlane-disposable-frontend',timeoutMs:15000}};
const config=useInstalled?installed:{...installed,port:9491,stateDirectory:temp+'/state',profiles:[],previewTargets:[target]};
if(!useInstalled)await mkdir(config.stateDirectory,{mode:0o700});const agent=randomBytes(32).toString('hex');
for(const [name,value] of [['config.json',JSON.stringify(config)],['agent',agent],['owner',randomBytes(32).toString('hex')]])await writeFile(temp+'/'+name,value,{mode:0o600});
const env={...process.env,ROOTLANE_CONFIG:useInstalled?'/home/kyle/.config/rootlane/config.json':temp+'/config.json',ROOTLANE_OWNER_CREDENTIAL_FILE:temp+'/owner',ROOTLANE_AGENT_CREDENTIAL_FILE:temp+'/agent'};
let backend,api,web,client,previewId;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const startChild=(args,cwd)=>{const child=spawn(process.execPath,args,{cwd,env,stdio:['ignore','ignore','pipe']});child.stderr.on('data',data=>process.stderr.write(data));return child;};
const stop=async child=>{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}};
const waitFor=async predicate=>{for(let i=0;i<150;i++){try{const value=await predicate();if(value)return value;}catch{}await sleep(100);}throw Error('Acceptance timed out');};
const connect=async era=>{client=new Client({name:'rootlane-publication-acceptance',version:'1.0.0'},{versionNegotiation:{mode:era==='legacy'?'legacy':{pin:'2026-07-28'}}});await client.connect(new StdioClientTransport({command:useInstalled?'/opt/stacks/rootlane/deploy/rootlane-mcp-docker':process.execPath,args:useInstalled?[]:[repo+'/dist/mcp/main.js'],env:{PATH:process.env.PATH,ROOTLANE_URL:'http://127.0.0.1:9491',ROOTLANE_AGENT_TOKEN:agent},stderr:'pipe'}));assert.equal((await client.listTools()).tools.length,13);};
const call=async(name,args={})=>{const result=await client.callTool({name,arguments:args});assert(!result.isError,JSON.stringify(result));return result.structuredContent;};
const readyBackend=async()=>{if(!useInstalled)backend=startChild([repo+'/dist/main.js'],repo);await waitFor(async()=> (await fetch(`http://127.0.0.1:${config.port}/`)).ok);};
try {
 api=startChild([fixture+'/api.mjs'],fixture);web=startChild([repo+'/node_modules/vite/bin/vite.js','--config',fixture+'/vite.config.mjs'],fixture);
 await waitFor(async()=> (await fetch('http://127.0.0.1:19482/')).ok);await readyBackend();await connect('modern');
 const caps=await call('get_capabilities');assert.deepEqual(caps.approvalScope.previewTargetIds,['disposable-web']);assert.equal(caps.observed.routeWritePermission,'unverified');
 const catalog=await call('list_projects',{limit:50});const project=catalog.projects.find(p=>p.path===repo);assert(project);
 const details=await call('get_project',{projectId:project.id});assert(details.approvedTargetIds.includes(target.id));
 const payload={targetId:target.id,requestId:randomUUID()};const accepted=await call('publish_preview',payload);previewId=accepted.previewId;
 assert.equal((await call('publish_preview',payload)).operation.id,accepted.operation.id);
 const state=await waitFor(async()=>{const s=await call('get_preview',{previewId});if(['failed','partial'].includes(s.latestOperation.status))throw Error(JSON.stringify(s));return s.https==='verified'?s:null;});
 const url=state.url;assert((await (await fetch(url)).text()).includes('rootlane-disposable-frontend'));
 assert((await fetch(new URL('/main.tsx',url))).ok);assert((await fetch(new URL('/@vite/client',url))).ok);
 assert.equal((await (await fetch(new URL('/api/message',url))).json()).message,'The disposable API is reachable.');
 const redirect=await fetch(new URL('/api/redirect',url),{redirect:'manual'});assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),'/api/message');assert((await fetch(new URL('/api/redirect',url))).ok);
 const source=await (await fetch(new URL('/@vite/client',url))).text();const token=source.match(/const wsToken = "([^"]+)"/);assert(token,'Vite websocket token');
 const ws=new WebSocket(`wss://${config.tailnetHostname}:19484/?token=${token[1]}`,'vite-hmr');const messages=[];
 ws.addEventListener('message',event=>messages.push(JSON.parse(event.data)));await waitFor(()=>messages.some(m=>m.type==='connected'));
 const main=fixture+'/main.tsx';const original=await readFile(main,'utf8');
 try {await writeFile(main,original+'\n// Harness HMR acceptance probe\n');await waitFor(()=>messages.some(m=>['update','full-reload'].includes(m.type)));}finally{await writeFile(main,original);ws.close();}
 const fixturePids=[api.pid,web.pid];await client.close();await stop(backend);if(useInstalled)execFileSync('docker',['compose','--project-directory','/opt/stacks/rootlane','restart','rootlane'],{stdio:'inherit'});await readyBackend();assert.deepEqual([api.pid,web.pid],fixturePids);await connect('legacy');
 assert.equal((await call('get_preview',{previewId})).https,'verified');assert.equal((await call('publish_preview',payload)).previewId,previewId);
 if(process.env.ROOTLANE_HOLD==='1'){console.log('SECOND_DEVICE_URL '+url+' RELEASE_FILE '+temp+'/release');for(let i=0;i<6000;i++){try{await readFile(temp+'/release');break;}catch{}await sleep(100);}}
 await call('unpublish_preview',{previewId,requestId:randomUUID()});await waitFor(async()=> (await call('get_preview',{previewId})).removed);
 assert((await fetch('http://127.0.0.1:19482/')).ok);assert((await fetch('http://127.0.0.1:19481/health')).ok);
 assert.deepEqual(await host.routes(),originalRoutes);
 await writeFile(temp+'/acceptance.json',JSON.stringify({previewId,url,fixturePids,protocols:['modern','legacy'],checks:['HTML','assets','API','redirect','WebSocket connected','HMR traffic','restart preserves applications','unpublish preserves local upstream','unrelated routes unchanged']},null,2));
 console.log('PASS live MCP workflow, HTTPS HTML/assets/API/redirect/WebSocket/HMR, restart reconciliation and independently owned upstream survival. Evidence '+temp);
} finally {
 if(client){if(previewId)try{await call('unpublish_preview',{previewId,requestId:randomUUID()});await waitFor(async()=> (await call('get_preview',{previewId})).removed);}catch(error){console.error('Cleanup needs inspection',error.message);}await client.close();}
 await stop(backend);await stop(web);await stop(api);await rm(temp+'/owner',{force:true});await rm(temp+'/agent',{force:true});
 assert.deepEqual(await host.routes(),originalRoutes);
}
