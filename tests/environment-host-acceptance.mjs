// Explicitly opt-in: installs dependencies and starts only disposable, independently owned host environments.
import assert from 'node:assert/strict';
import { spawn,execFileSync } from 'node:child_process';
import { mkdtemp,mkdir,writeFile,readFile,rm,access } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes,randomUUID } from 'node:crypto';
if(process.env.ROOTLANE_HOST_ACCEPTANCE!=='1')throw new Error('Opt in: ROOTLANE_HOST_ACCEPTANCE=1 npm run host:acceptance');
const {LinuxHost}=await import('../dist/host/linux.js');
const host=new LinuxHost(),originalRoutes=await host.routes();
assert(!(await host.listeners()).some(l=>l.port===9492),'Acceptance port is occupied');
const installed=JSON.parse(await readFile(process.env.ROOTLANE_CONFIG??join(homedir(),'.config/rootlane/config.json'),'utf8'));
const directory=await mkdtemp('/tmp/rootlane-environment-host-'),projects=join(directory,'projects'),state=join(directory,'state');await mkdir(projects);await mkdir(state,{mode:0o700});
const vite=join(projects,'vite'),worktree=join(projects,'worktree'),python=join(projects,'fastapi');await mkdir(vite);await mkdir(python);
const version=JSON.parse(await readFile('node_modules/vite/package.json','utf8')).version;
await writeFile(join(vite,'package.json'),JSON.stringify({private:true,scripts:{dev:'vite'},devDependencies:{vite:version}}));
await writeFile(join(vite,'index.html'),'<html><body>Rootlane fresh Vite<script type="module" src="/main.js"></script></body></html>');await writeFile(join(vite,'main.js'),'console.log("initial-fixture")');
const git=(...args)=>execFileSync('git',['-C',vite,...args],{stdio:'ignore',timeout:3000});git('init');git('add','.');git('-c','user.name=Rootlane acceptance','-c','user.email=acceptance@example.invalid','commit','-m','Fresh Vite');git('worktree','add','-b','second',worktree);
await writeFile(join(python,'requirements.txt'),'fastapi\nuvicorn\n');await writeFile(join(python,'main.py'),'from fastapi import FastAPI\napp = FastAPI()\n');
const config={...installed,port:9492,stateDirectory:state,projectRoots:[projects],observationRoots:[projects],additionalOrigins:[],projects:[],profiles:[],previewTargets:[],telemetry:{...installed.telemetry,enabled:false},toolchains:{node:process.execPath,venvs:{}},instancePorts:[21000,21999]};
const agent=randomBytes(32).toString('hex'),owner=randomBytes(32).toString('hex');
for(const [name,value] of [['config.json',JSON.stringify(config)],['agent',agent],['owner',owner]])await writeFile(join(directory,name),value,{mode:0o600});
let backend,cookie,csrf,diagnostics='',clean=true;
const instances=[],checks=[];
const startController=()=>{backend=spawn(process.execPath,[resolve('dist/main.js')],{env:{...process.env,ROOTLANE_CONFIG:join(directory,'config.json'),ROOTLANE_OWNER_CREDENTIAL_FILE:join(directory,'owner'),ROOTLANE_AGENT_CREDENTIAL_FILE:join(directory,'agent'),ROOTLANE_INGEST_CREDENTIAL_FILE:''},stdio:['ignore','ignore','pipe']});backend.stderr.on('data',chunk=>diagnostics=(diagnostics+chunk).slice(-4096));};
const stopController=async()=>{backend.kill('SIGTERM');if(backend.exitCode===null&&backend.signalCode===null)await new Promise(resolve=>backend.once('exit',resolve));};
const base='http://127.0.0.1:9492';
const json=async(path,body,ownerSession=false)=>{
 const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(ownerSession?{origin:config.origin,cookie,'x-rootlane-csrf':csrf}:{authorization:`Bearer ${agent}`})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const result=await response.json();if(!response.ok)throw new Error(`${path}: ${result.code} ${result.message}`);return result;
};
const call=(tool,input={})=>json('/api/tools/'+tool,input),own=(action,input)=>json('/api/owner/'+action,input,true);
const wait=async(work,label,timeout=60000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(backend.exitCode!==null)throw new Error('Controller exited: '+diagnostics);const result=await work();if(result)return result;await new Promise(resolve=>setTimeout(resolve,250));}throw new Error('Timed out: '+label);};
const login=async()=>{const response=await fetch(base+'/api/login',{method:'POST',headers:{origin:config.origin,'content-type':'application/json'},body:JSON.stringify({credential:owner})});assert(response.ok);cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).csrf;};
const observe=id=>call('get_environment',{environmentId:id});
const ready=id=>wait(async()=>{const result=await observe(id);if(result.latestOperation?.status==='failed')throw new Error(JSON.stringify(result.latestOperation.error));return result.application==='ready'&&result.preview==='available'?result:null;},'Ready and verified HTTPS');
const prepare=async path=>{
 let inspection=await call('inspect_environment',{path});assert.equal(inspection.nextAction,'Configure environment');assert.equal(inspection.proposal.restart,'on-failure');
 await own('configuration',{path,recipe:inspection.proposal,tools:{},fingerprint:inspection.fingerprint});
 inspection=await call('inspect_environment',{path});assert.equal(inspection.source,'Host-local');await assert.rejects(access(join(path,'.rootlane.json')));
 const request=await call('request_environment',{path,requestId:randomUUID()}),id=request.resolvedPreview.instanceId;instances.push(id);
 assert(request.resolvedPreview.prerequisites.some(b=>b.code==='PREPARATION_REQUIRED'));
 for(let review=0;review<2;review++) {
  inspection=await call('inspect_environment',{path});await own('preparation',{path,fingerprint:inspection.fingerprint,requestId:randomUUID()});
  const completed=await wait(async()=>{const current=await call('inspect_environment',{path});if(['failed','interrupted'].includes(current.preparationStatus))throw new Error(JSON.stringify(current.preparationError));return current.preparationStatus!=='running'?current:null;},'Preparation',360000);
  if(completed.preparationStatus==='succeeded')break;
  assert.equal(completed.preparationError?.code,'PREPARATION_CHANGED','Only newly generated lockfiles may require another review');assert.equal(review,0);
 }
 const review=await call('request_environment',{path,requestId:randomUUID()});assert.equal(review.resolvedPreview.prerequisites.length,0);
 await json('/api/approvals/'+new URL(review.approvalUrl).searchParams.get('approval')+'/approve',{},true);
 await call('start_environment',{environmentId:id,requestId:randomUUID()});return ready(id);
};
startController();
try {
 await wait(async()=>{try{return !(await call('get_capabilities')).reconciling;}catch{return false;}},'Controller');await login();
 const first=await prepare(vite),second=await prepare(worktree),api=await prepare(python);checks.push('fresh Vite and non-Git FastAPI preparation, owner approval, Ready and HTTPS','two concurrently running worktrees');
 assert.equal(new Set([...Object.values(first.ports),...Object.values(second.ports),...Object.values(api.ports)]).size,3);assert(api.links[0].url.endsWith('/docs'));assert((await(await fetch(api.links[0].url)).text()).includes('swagger'));
 assert(execFileSync('systemctl',['--user','show',api.services[0].unit,'--property=ExecStart'],{encoding:'utf8'}).includes('.venv/bin/python'));checks.push('virtual environment invocation preserved');
 const preview=first.previews[0].url;await fetch(new URL('/main.js',preview));
 const client=await(await fetch(new URL('/@vite/client',preview))).text(),token=client.match(/const wsToken\s*=\s*"([^"]+)"/)?.[1];assert(token);const url=new URL(preview);url.protocol='wss:';url.searchParams.set('token',token);
 await new Promise((resolve,reject)=>{const socket=new WebSocket(url,'vite-hmr'),timer=setTimeout(()=>{socket.close();reject(new Error('HMR update timed out'));},10000);socket.onmessage=async event=>{const message=JSON.parse(String(event.data));if(message.type==='connected')await writeFile(join(vite,'main.js'),'console.log("updated-fixture")');if(['update','full-reload'].includes(message.type)){clearTimeout(timer);socket.close();resolve();}};socket.onerror=()=>{clearTimeout(timer);socket.close();reject(new Error('HMR failed'));};});
 assert((await(await fetch(new URL('/main.js',preview))).text()).includes('updated-fixture'));checks.push('actual HMR file update through private HTTPS');
 const unit=first.services[0].unit,invocation=(await host.inspectUnit(unit)).invocation;
 const route={hostname:config.tailnetHostname,port:first.previews[0].port,upstream:`http://127.0.0.1:${first.ports.web}`,label:'web'};await host.removeRoute(route);
 await call('recover_environment',{environmentId:first.id,requestId:randomUUID()});await ready(first.id);assert.equal((await host.inspectUnit(unit)).invocation,invocation);checks.push('preview recovery retains healthy application invocation');
 for(let attempt=1;attempt<=4;attempt++) {
  const current=await host.inspectUnit(unit);if(current.state==='failed')break;assert(current.marker.startsWith('rootlane:'));execFileSync('systemctl',['--user','kill','--kill-whom=main','--signal=SIGKILL',unit]);
  const state=await wait(async()=>{const value=await host.inspectUnit(unit);return value?.state==='failed' || (value?.state==='active'&&value.restarts>=attempt)?value:null;},'Crash recovery/exhaustion');
  if(state.state==='failed')break;
 }
 const exhausted=await host.inspectUnit(unit);assert.equal(exhausted.state,'failed');assert.equal(exhausted.restarts,3);
 await new Promise(resolve=>setTimeout(resolve,2500));assert.equal((await host.inspectUnit(unit)).state,'failed');assert.equal((await host.inspectUnit(unit)).restarts,3);
 assert.equal((await observe(second.id)).application,'ready');checks.push('bounded systemd crash retries and exhausted limit; other worktree unchanged');
 await call('recover_environment',{environmentId:first.id,requestId:randomUUID()});await ready(first.id);
 const preserved=(await host.inspectUnit(second.services[0].unit)).invocation;await stopController();startController();await wait(async()=>{try{return !(await call('get_capabilities')).reconciling;}catch{return false;}},'Controller restart');await login();await ready(second.id);assert.equal((await host.inspectUnit(second.services[0].unit)).invocation,preserved);checks.push('controller restart retains applications and host-local configuration');
 await own('recovery-policy',{environmentId:first.id,restore:true});await call('stop_environment',{environmentId:first.id,requestId:randomUUID()});await wait(async()=>(await observe(first.id)).latestOperation.status==='succeeded','Stop');assert.equal((await observe(first.id)).desiredState,'stopped');checks.push('deliberate Stop clears restore intent');
 let inspection=await call('inspect_environment',{path:vite});const broken={...inspection.proposal,preparation:[],services:[{...inspection.proposal.services[0],command:['{node}','missing.mjs']} ]};await own('configuration',{path:vite,recipe:broken,tools:{},fingerprint:inspection.fingerprint});const failure=await call('request_environment',{path:vite,requestId:randomUUID()});await json('/api/approvals/'+new URL(failure.approvalUrl).searchParams.get('approval')+'/approve',{},true);await call('start_environment',{environmentId:first.id,requestId:randomUUID()});await wait(async()=>(await observe(first.id)).latestOperation.status==='failed','Startup failure');assert.equal((await observe(second.id)).application,'ready');checks.push('startup failure rolls back owned resources only');
}finally{
 for(const id of instances){try{await call('stop_environment',{environmentId:id,requestId:randomUUID()});await wait(async()=>(await observe(id)).latestOperation?.status==='succeeded','Cleanup');await own('retirement',{environmentId:id});}catch(error){clean=false;console.error(`Retained acceptance state ${directory}: ${error.message}`);}}
 await stopController();assert.deepEqual(await host.routes(),originalRoutes,'Unrelated Serve routes must remain unchanged');
 const report={at:new Date().toISOString(),checks,cleanupVerified:clean,unverified:['real reboot/reconnect','second-device preview/HMR','deployed Docker controller']};await writeFile(process.env.ROOTLANE_ENVIRONMENT_HOST_EVIDENCE??'/tmp/rootlane-environment-host-results.json',JSON.stringify(report,null,2));
 if(clean)await rm(directory,{recursive:true,force:true});
}
console.log('PASS environment host acceptance: '+checks.join('; '));
