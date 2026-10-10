// Opt-in host integration. Only the reviewed disposable fixture is controlled.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
if (process.env.ROOTLANE_HOST_ACCEPTANCE !== '1') {
  console.error('Host acceptance is opt-in: ROOTLANE_HOST_ACCEPTANCE=1 npm run host:acceptance');
  process.exit(1);
}
const { LinuxHost } = await import('../dist/host/linux.js');
const root=resolve('.'), fixture=join(root,'fixtures/disposable');
const installed=JSON.parse(await readFile(process.env.ROOTLANE_CONFIG ?? join(homedir(),'.config/rootlane/config.json'),'utf8'));
const host=new LinuxHost(); const originalRoutes=await host.routes();
for(const port of [9491,19481,19482,19484]) {
  assert(!(await host.listeners()).some(l=>l.port===port),'Acceptance port occupied: '+port);
  assert.equal(host.routeState(originalRoutes,{hostname:installed.tailnetHostname,port,upstream:'http://127.0.0.1:1',label:'Acceptance'}),'absent','Acceptance route occupied: '+port);
}
const temp=await mkdtemp('/tmp/rootlane-host-acceptance-'); await mkdir(join(temp,'state'),{mode:0o700});
const profile={id:'acceptance-disposable',approved:true,projectPath:fixture,effects:'Runs only the disposable API and Vite frontend; publishes one temporary private route.',dataRequirements:'No application data or database.',services:[
  {id:'api',cwd:fixture,executable:process.execPath,args:[join(fixture,'api.mjs')],port:19481,dependencies:[],readiness:{path:'/health',status:200,bodyIncludes:'rootlane-disposable-api',timeoutMs:15000}},
  {id:'web',cwd:fixture,executable:process.execPath,args:[join(root,'node_modules/vite/bin/vite.js'),'--config',join(fixture,'vite.config.mjs')],port:19482,dependencies:['api'],readiness:{path:'/',status:200,bodyIncludes:'rootlane-disposable-frontend',timeoutMs:15000}}
],previews:[{serviceId:'web',httpsPort:19484,label:'Disposable acceptance preview'}]};
const config={...installed,port:9491,stateDirectory:join(temp,'state'),additionalOrigins:[],projects:[],profiles:[profile],previewTargets:[]};
const credential=randomBytes(32).toString('hex');
for(const [name,value] of [['config.json',JSON.stringify(config)],['agent',credential],['owner',randomBytes(32).toString('hex')]])await writeFile(join(temp,name),value,{mode:0o600});
const env={...process.env,ROOTLANE_CONFIG:join(temp,'config.json'),ROOTLANE_OWNER_CREDENTIAL_FILE:join(temp,'owner'),ROOTLANE_AGENT_CREDENTIAL_FILE:join(temp,'agent')};
const backend=spawn(process.execPath,[join(root,'dist/main.js')],{cwd:root,env,stdio:['ignore','ignore','pipe']});let diagnostics='';backend.stderr.on('data',data=>{diagnostics=(diagnostics+data).slice(-4096);});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const call=async(name,args={})=>{const response=await fetch(`http://127.0.0.1:9491/api/tools/${name}`,{method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(10000)});const body=await response.json();assert(response.ok,`${name}: ${JSON.stringify(body)}`);return body;};
const waitFor=async(predicate,description)=>{const deadline=Date.now()+45000;let last;while(Date.now()<deadline){if(backend.exitCode!==null)throw Error('Backend exited: '+diagnostics);try{const value=await predicate();if(value)return value;}catch(e){last=e;}await pause(250);}throw Error(description+': '+(last?.message??diagnostics));};
let started=false,stopped=false,previewId;
try {
  await waitFor(async()=>{const caps=await call('get_capabilities');return !caps.reconciling;},'Backend reconciliation');
  const input={environmentId:profile.id,requestId:randomUUID()}; started=true;
  const accepted=await call('start_environment',input);assert.equal(accepted.operation.status,'accepted');
  assert.equal((await call('start_environment',input)).operation.id,accepted.operation.id);
  const ready=await waitFor(async()=>{const state=await call('get_environment',{environmentId:profile.id});if(state.latestOperation?.status==='failed')throw Error(JSON.stringify(state.latestOperation.error));return state.application==='ready' && state.preview==='available'?state:null;},'Ready and HTTPS Available');
  const url=ready.links[0].url;assert((await (await fetch(url,{signal:AbortSignal.timeout(5000)})).text()).includes('rootlane-disposable-frontend'));
  const logs=await call('get_logs',{environmentId:profile.id,serviceId:'api',limit:10});assert(logs.lines.some(line=>line.includes('rootlane-disposable-api')));
  const location=await call('locate',{path:fixture});assert(location.ports.some(p=>p.port===19482 && p.name==='vite'));assert(location.environments.some(e=>e.id===profile.id));assert(location.previews.some(p=>p.url===url));
  const proposal=await call('propose_preview_target',{checkoutId:location.checkout.id,port:19482});assert.equal(proposal.draft.approved,false);assert.equal(proposal.draft.readiness.bodyIncludes,'<CHANGE ME>');assert.notEqual(proposal.draft.httpsPort,19484);
  const draft=await call('propose_profile',{checkoutId:location.checkout.id,port:19482});assert.equal(draft.draft.approved,false);assert(draft.draft.services[0].args.includes('127.0.0.1'));
  config.previewTargets=[{...proposal.draft,approved:true,readiness:profile.services[1].readiness}];
  const beforeReload=JSON.stringify(config);await writeFile(join(temp,'config.json'),'{');backend.kill('SIGHUP');
  await waitFor(async()=>{const caps=await call('get_capabilities');return caps.configError;},'Invalid reload retains config');
  await writeFile(join(temp,'config.json'),beforeReload);backend.kill('SIGHUP');await waitFor(async()=>!(await call('get_capabilities')).configError,'Valid config reload');
  config.editorUrlTemplate='vscode://file{path}';await writeFile(join(temp,'config.json'),JSON.stringify(config));
  await waitFor(async()=>{const response=await fetch('http://127.0.0.1:9491/api/status',{headers:{authorization:`Bearer ${credential}`}});return (await response.json()).editorUrlTemplate===config.editorUrlTemplate;},'Config mtime reload');
  const published=await call('publish_preview',{targetId:proposal.draft.id,requestId:randomUUID()});previewId=published.previewId;
  const available=await waitFor(async()=>{const p=await call('get_preview',{previewId});return p.route==='matching' && p.upstream==='ready' && p.https==='verified'?p:null;},'Reviewed proposal publication Available');assert(available.verifiedAt);
  assert((await call('locate',{path:fixture})).previews.some(p=>p.url===available.url));
  await call('unpublish_preview',{previewId,requestId:randomUUID()});await waitFor(async()=>(await call('get_preview',{previewId})).removed,'Unpublish');previewId=undefined;
  await call('stop_environment',{environmentId:profile.id,requestId:randomUUID()});
  await waitFor(async()=>{const state=await call('get_environment',{environmentId:profile.id});return state.application==='stopped' && state.latestOperation?.status==='succeeded';},'Stop and cleanup');stopped=true;
  assert(!(await host.listeners()).some(l=>[19481,19482].includes(l.port)));assert.deepEqual(await host.routes(),originalRoutes);
  const history=await call('list_operations',{environmentId:profile.id,limit:20});assert(history.operations.some(op=>op.action==='start' && op.status==='succeeded'));assert(history.operations.some(op=>op.action==='stop' && op.status==='succeeded'));
  const evidence={observedAt:new Date().toISOString(),checks:['HTTP start/idempotency','reviewed Ready','HTTPS Available','bounded logs','locate real vite listener','non-approving preview and profile proposals','invalid/valid SIGHUP reload','10-second config mtime reload','reviewed target publish Available','locate managed and independent preview URLs','unpublish preserves application','HTTP stop','ports released','Serve snapshot restored','operation history'],ownerChecksOpen:['second-device preview and HMR','reboot','SSH disconnect']};
  await writeFile(process.env.ROOTLANE_HOST_EVIDENCE ?? '/tmp/rootlane-host-acceptance-results.json',JSON.stringify(evidence,null,2));
  console.log('PASS host HTTP acceptance: Ready, HTTPS Available, logs, locate, proposals, config reload, stop, released ports and unchanged Serve config.');
} finally {
  if(previewId) {await call('unpublish_preview',{previewId,requestId:randomUUID()});await waitFor(async()=>(await call('get_preview',{previewId})).removed,'Preview failure cleanup');}
  if(started && !stopped) {
    try {await call('stop_environment',{environmentId:profile.id,requestId:randomUUID()});await waitFor(async()=>{const state=await call('get_environment',{environmentId:profile.id});return state.application==='stopped' && state.latestOperation?.status==='succeeded';},'Failure cleanup');stopped=true;}
    catch(error){console.error('Cleanup needs owner inspection. Isolated state retained at '+temp);console.error(error.message);}
  }
  backend.kill('SIGTERM');if(backend.exitCode===null && backend.signalCode===null)await new Promise(resolve=>backend.once('exit',resolve));
  assert.deepEqual(await host.routes(),originalRoutes,'Serve snapshot after cleanup');
  await rm(join(temp,'agent'),{force:true});await rm(join(temp,'owner'),{force:true});
  if(!started || stopped)await rm(temp,{recursive:true,force:true});
}
