// Installed native clients, isolated homes/backend. Authenticated mode calls only the fixture catalog.
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,symlink,readFile,rm,copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join,resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { configSchema } from '../dist/config.js';
import { Catalog } from '../dist/catalog/discovery.js';
import { Store } from '../dist/state/store.js';
import { Lifecycle } from '../dist/lifecycle/service.js';
import { Rootlane } from '../dist/service.js';
import { createServer } from '../dist/http/server.js';
import { integrate } from '../dist/integrations/runner.js';
import { toolContracts } from '../dist/shared/contracts.js';
if(process.env.ROOTLANE_CLIENT_ACCEPTANCE!=='1')throw new Error('Opt in: ROOTLANE_CLIENT_ACCEPTANCE=1 npm run client:acceptance');
const directory=await mkdtemp('/tmp/rootlane-client-acceptance-');let app,store,service;
const results=[];
try {
 const project=join(directory,'projects/app'),state=join(directory,'state');await mkdir(project,{recursive:true});await mkdir(state,{mode:0o700});await writeFile(join(project,'package.json'),'{}');
 const config=configSchema.parse({projectRoots:[project],observationRoots:[project],stateDirectory:state,origin:'https://fixture.example.ts.net:19483',tailnetHostname:'fixture.example.ts.net'});
 store=new Store(join(state,'rootlane.sqlite'));
 const host={bootId:async()=>'isolated',agents:async()=>({agents:[],warnings:[]}),listeners:async()=>[],routes:async()=>({}),routeState:()=> 'absent',guardedRoutes:async()=>true,capabilities:async()=>{},connection:async()=>({status:'connected',hostname:config.tailnetHostname})};
 const lifecycle=new Lifecycle(config,store,host);service=new Rootlane(new Catalog(config,host,store),lifecycle);await lifecycle.reconcile();await service.publications.reconcile();
 const telemetry=process.env.ROOTLANE_CLIENT_TELEMETRY==='1',ingest=randomBytes(32).toString('hex');
 if(telemetry){config.telemetry.enabled=true;config.telemetry.port=0;await service.telemetry.reconfigure(config.telemetry,ingest);config.telemetry.port=service.telemetry.server.server.address().port;}
 const token=randomBytes(32).toString('hex'),credentialPath=join(directory,'agent');await writeFile(credentialPath,token,{mode:0o600});
 app=await createServer(config,service,{owner:randomBytes(32).toString('hex'),agent:token});await app.listen({host:'127.0.0.1',port:0});config.port=app.server.address().port;
 const adapter=join(directory,'adapter.mjs');await writeFile(adapter,`#!${process.execPath}\nimport {readFileSync} from 'node:fs';process.env.ROOTLANE_URL=${JSON.stringify('http://127.0.0.1:'+config.port)};process.env.ROOTLANE_AGENT_TOKEN=readFileSync(${JSON.stringify(credentialPath)},'utf8');await import(${JSON.stringify(resolve('dist/mcp/main.js'))});\n`,{mode:0o700});
 for(const client of ['codex','claude']) {
  let executable;try{executable=execFileSync('which',[client],{encoding:'utf8'}).trim();}catch{results.push({client,available:false});continue;}
  const home=join(directory,client);await mkdir(join(home,'.local/bin'),{recursive:true});await mkdir(join(home,'.codex'));await mkdir(join(home,'.claude'));await symlink(executable,join(home,'.local/bin',client));
  if(client==='claude' && process.env.ROOTLANE_CLIENT_AUTHENTICATED==='1')await copyFile(join(homedir(),'.claude/.credentials.json'),join(home,'.claude/.credentials.json'));
  await writeFile(join(home,'.codex/config.toml'),'approval_policy = "on-request"\n');
  const settings={hooks:{SessionStart:[]},statusLine:{type:'command',command:'printf original-output'},permissions:{allow:['Read']}};await writeFile(join(home,'.claude/settings.json'),JSON.stringify(settings));
  const input={client,home,adapter,tools:Object.keys(toolContracts),...(telemetry?{telemetry:true,endpoint:`http://127.0.0.1:${config.telemetry.port}`,token:ingest}:{})};
  const review=await integrate({...input,action:'inspect'});assert(review.version);assert(!review.blockers.length,review.blockers.join('; '));
  const applied=await integrate({...input,action:'apply',fingerprint:review.fingerprint});assert(applied.configured);
  const saved=JSON.parse(await readFile(join(home,'.claude/settings.json'),'utf8'));for(const key of Object.keys(settings))assert.deepEqual(saved[key],settings[key]);
  assert((await readFile(join(home,'.codex/config.toml'),'utf8')).includes('approval_policy = "on-request"'));
  let verification;try{verification=await integrate({...input,action:'verify'});}catch(error){verification={connectionChecked:false,toolCallVerified:false,blockers:[error.message]};}
  let nativeTelemetry=false;
  if(telemetry){const deadline=Date.now()+20000;while(Date.now()<deadline){nativeTelemetry=(await service.telemetry.status()).reporting[client]>0;if(nativeTelemetry)break;await new Promise(resolve=>setTimeout(resolve,250));}}
  results.push({client,version:review.version,temporaryHome:true,registrationVerified:true,connectionChecked:verification.connectionChecked,toolCallVerified:verification.toolCallVerified,tools:verification.tools,blockers:verification.blockers,nativeTelemetry});
  if(client==='codex' || process.env.ROOTLANE_CLIENT_AUTHENTICATED==='1')assert(verification.toolCallVerified,client+' must complete an actual structured fixture tool call');
  if(telemetry)assert(nativeTelemetry,client+' must produce fresh native exporter events');
 }
 const report={at:new Date().toISOString(),isolatedBackend:true,liveHostServicesChanged:false,results};await writeFile(process.env.ROOTLANE_CLIENT_EVIDENCE??'/tmp/rootlane-client-acceptance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await app?.close();await service?.telemetry.stop();store?.close();await rm(directory,{recursive:true,force:true});}
