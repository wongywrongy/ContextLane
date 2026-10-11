// Run after npm run build. CHROME may point to an installed Chromium executable.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
const evidence=process.env.ROOTLANE_EVIDENCE ?? '.impeccable/review';await mkdir(evidence,{recursive:true});
const profile=await mkdtemp('/tmp/rootlane-ui-');
const child=spawn(process.env.CHROME ?? '/home/kyle/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',['--headless','--no-sandbox','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
let socket;
try {
 const endpoint=await new Promise((resolve,reject)=>{let output='';child.stderr.on('data',data=>{output+=data;const match=output.match(/DevTools listening on (ws:\/\/\S+)/);if(match)resolve(match[1]);});child.once('exit',()=>reject(Error('Chromium exited')));});
 socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 let sequence=0;const pending=new Map();const consoleErrors=[];const requests=[];
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,sessionId}));});
 socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const item=pending.get(message.id);pending.delete(message.id);message.error?item.reject(Error(JSON.stringify(message.error))):item.resolve(message.result);}
  if(message.method==='Runtime.exceptionThrown')consoleErrors.push(message.params.exceptionDetails.text);
  if(message.method==='Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog',{accept:true},message.sessionId);
  if(message.method==='Fetch.requestPaused')void respond(message.params).catch(error=>{ if(!String(error).includes('Invalid InterceptionId')) consoleErrors.push(String(error)); });
 };
 const {targetId}=await send('Target.createTarget',{url:'about:blank'});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 await send('Browser.grantPermissions',{origin:'https://rootlane.test',permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
 const page=async(method,params={})=>{if(method==='Emulation.setDeviceMetricsOverride')await send('Emulation.setTouchEmulationEnabled',{enabled:!!params.mobile},sessionId);return send(method,params,sessionId);};
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 let editorTemplate='vscode://file{path}'; let unlocked=true; let failActionOnce=false; let failProject=false,failLogs=false,failCatalog=false,failEnvironment=false,failPreview=false,disconnect=false,delayProject=0,delayCatalog=0,delayLogs=0,activeCatalog=0,peakCatalog=0;
 const snapshotTime=new Date().toISOString();
 const previewId='12345678-1234-4234-8234-123456789abc';
 let pendingApproval=false;
 const approval={id:previewId,projectPath:'/code/.git',recipeHash:'a'.repeat(64),toolchainRevision:'b'.repeat(64),status:'pending',requestedAt:snapshotTime,decidedAt:null,decidedBy:null,stale:false,preview:{instanceId:'env',projectPath:'/code/.git',checkoutPath:'/code/long-checkout-path/0',recipeHash:'a'.repeat(64),toolchainRevision:'b'.repeat(64),services:[{id:'web',command:['/usr/bin/node','node_modules/vite/bin/vite.js','--host','127.0.0.1'],cwd:'/code/long-checkout-path/0',envNames:['API_URL','API_TOKEN','ROOTLANE_PORT','ROOTLANE_PREVIEW_ORIGIN','ROOTLANE_PREVIEW_PORT'],port:20000,readiness:{path:'/',status:200,bodyIncludes:'<div id="root">',timeoutMs:15000}}],previews:[{serviceId:'web',label:'Console',port:20001,url:'https://neo.example.ts.net:20001/'}],setup:['make doctor']}};
 const projects=Array.from({length:12},(_,i)=>({id:'p'+i,name:i===0?'Disposable fixture':i===1?'A very long project name that must never displace the menu control':'Project '+i,path:'/code/'+('long-checkout-path/'.repeat(i===1?8:1))+i,recipe:i===0?{found:true,valid:true,errors:[],approval:'approved'}:undefined,controls:i===0?[{id:'env',desiredState:'running',hasResources:true,startAllowed:true,latestOperation:null}]:[],devCommand:i===0?'vite':undefined,git:{dirty:2,ahead:1,behind:0,lastCommit:{sha7:'abcdef1',subject:'Fixture change',committedAt:snapshotTime}},funnel:[],gitCommonDir:null,branch:'feature/a-very-long-branch-name',detached:false,manifests:['package.json'],links:i===0?[{label:'Docs',url:'https://docs.rootlane.test/'}]:i===1?[{label:'Homepage',url:'https://example.invalid/'}]:[],agents:i===0?Array.from({length:5},(_,a)=>({name:a%2?'Claude Code':'Codex',source:'detected process',id:String(a).repeat(24),startedAt:new Date(Date.now()-3800000).toISOString(),pid:100+a,cwd:'/code',worktreePath:'/code/long-checkout-path/0'})):[],previewIds:i===0?[previewId]:[],environmentIds:i===0?['env','env2']:[],logServices:i===0?[{environmentId:'env',serviceId:'web'}]:[],runtime:{listeners:i===0?[3000,4000,5000,6000].map((port,index)=>({port,checkoutId:'p0',worktreePath:'/code/long-checkout-path/0',bind:'127.0.0.1',wildcard:false,loopback:true,process:{name:index===0?'vite':index===1?'uvicorn':'node worker.js',pid:200+index,startedAt:'2026-10-10T00:50:00Z'}})):[],services:i===0?[{id:'web',name:'Web',port:3000},{id:'api',name:'API',port:4000},{id:'worker',name:'Worker',port:5000},{id:'debug',name:'Debug',port:6000}]:[],status:i===0?'listeners observed':'no associated listener',ports:i===0?[3000,4000,5000,6000]:[],ownership:'observe-only'}}));
 async function respond(event) {
  const {requestId,request}=event;const url=new URL(request.url);const path=url.pathname;
  let status=200,body,contentType='application/json';
  if(path.startsWith('/api/')) {
   const payload=request.postData?JSON.parse(request.postData):{};requests.push({path,payload,at:Date.now()});
   if(disconnect){await page('Fetch.failRequest',{requestId,errorReason:'ConnectionRefused'});return;}
   if(path==='/api/session'){status=unlocked?200:401;body=unlocked?{csrf:'test'}:{message:'Unlock required'};}
   else if(path==='/api/approvals')body={approvals:pendingApproval?[approval]:[]};
   else if(path.startsWith('/api/approvals/')){pendingApproval=false;projects[0].recipe.approval=path.endsWith('approve')?'approved':'none';body={id:previewId,status:path.endsWith('approve')?'approved':'rejected'};}
   else if(path==='/api/login'){unlocked=true;body={csrf:'test'};}
   else if(path==='/api/status')body={connected:true,tailscale:{status:'connected',hostname:'neo.example.ts.net'},lifecycleAvailable:true,editorUrlTemplate:editorTemplate,projectRoots:['/code'],observationRoots:['/code','/worktrees']};
   else if(path.endsWith('list_projects')){activeCatalog++;peakCatalog=Math.max(peakCatalog,activeCatalog);const failed=failCatalog;await pause(delayCatalog);activeCatalog--;status=failed?503:200;body=failed?{message:'Controlled catalog failure'}:{projects,nextCursor:null,warnings:[],observedAt:snapshotTime};}
   else if(path.endsWith('get_project')){const failed=failProject;await pause(delayProject);status=failed?503:200;body=failed?{message:'Controlled project failure'}:{project:projects.find(p=>p.id===payload.projectId),checkoutIds:[payload.projectId],http:[{checkoutId:'p0',port:3000,http:{status:200,checkedAt:snapshotTime}}],services:[],approvedTargetIds:payload.projectId==='p0'?['api']:[],previews:payload.projectId==='p0'?[{previewId,checkoutId:'p0',serviceId:'web'}]:[],logServices:payload.projectId==='p0'?[{environmentId:'env',serviceId:'web'}]:[]};}
   else if(path.endsWith('get_environment')){const second=payload.environmentId==='env2',url=second?'https://neo.example.ts.net:19485/':'https://neo.example.ts.net:19484/';status=failEnvironment?503:200;body=failEnvironment?{message:'Controlled environment failure'}:{ports:{web:second?7000:3000,api:4000},previews:[{serviceId:'web',label:'Console',port:second?19485:19484,url}],id:payload.environmentId,profileRevision:'test',effects:'test',dataRequirements:'None',startAllowed:true,ownership:'rootlane',desiredState:'running',application:'ready',preview:'available',links:[],services:[{id:'web',port:second?7000:3000,unit:'rootlane-web.service',state:'active'},{id:'api',port:4000,unit:'rootlane-api.service',state:'active'}],observedAt:snapshotTime,latestOperation:null,recentOperations:[],previewRoutes:[{url,target:second?'http://127.0.0.1:7000':'http://127.0.0.1:3000',route:'matching',https:second?'unverified':'verified',upstream:'ready'}],observationError:null};}
   else if(path.endsWith('get_preview')){status=failPreview?503:200;body=failPreview?{message:'Controlled preview failure'}:{id:previewId,targetId:'web',projectPath:'/code',checkoutPath:projects[0].path,serviceId:'web',serviceName:'Web',target:'http://127.0.0.1:3000',port:3000,httpsPort:19484,ownership:'rootlane route only',approved:true,removed:false,url:'https://neo.example.ts.net:19484/',route:'matching',actualConfiguration:{},upstream:'ready',https:'verified',errors:[],observedAt:snapshotTime,verifiedAt:snapshotTime,latestOperation:null};}
   else if(failActionOnce && (path.endsWith('start_environment') || path.endsWith('stop_environment'))) {failActionOnce=false;status=503;body={code:'OPERATION_IN_PROGRESS',message:'Controlled action failure'};}
   else if(path.endsWith('start_environment') || path.endsWith('stop_environment')) body={operation:{id:previewId,environmentId:'env',action:payload.environmentId?'stop':'start',status:'succeeded',error:null,createdAt:snapshotTime,finishedAt:'2026-10-10T01:00:01Z'}};
   else if(path.endsWith('list_checks')) body={checks:[{subject:'env/web',kind:'readiness',checkoutId:'p0',results:[{ok:true,status:'pass',at:new Date().toISOString()}]}]};
   else if(path.endsWith('list_events')) body={events:[{at:new Date().toISOString(),projectId:payload.projectId,checkoutId:payload.projectId,kind:'listener-opened',text:'vite 127.0.0.1:3000 began listening',ref:':3000'}]};
   else if(path.endsWith('list_operations')) body={operations:[]};
   else if(path.endsWith('request_environment')){pendingApproval=true;projects[0].recipe.approval='pending';body={status:'pending',approvalUrl:'https://rootlane.test/?approval='+previewId,resolvedPreview:approval.preview};}
   else if(path.endsWith('publish_preview') || path.endsWith('unpublish_preview')) body={operation:{id:previewId,previewId,action:payload.targetId?'publish':'unpublish',status:'succeeded',error:null,createdAt:snapshotTime,finishedAt:'2026-10-10T01:00:01Z'},previewId,url:'https://neo.example.ts.net:19484/',verification:'verified'};
   else if(path.endsWith('get_logs')){const failed=failLogs;await pause(delayLogs);status=failed?503:200;body=failed?{message:'Controlled logs failure'}:{lines:payload.cursor?[]:['2026-10-10T01:00:00.000Z INFO bounded log output','2026-10-10T01:00:01.000Z WARN slow response','2026-10-10T01:00:02.000Z ERROR controlled failure'],nextCursor:payload.cursor??'s=test;i=1',truncated:false};}
   else throw Error('Unexpected API '+path);
   body=Buffer.from(JSON.stringify(body));
  } else if(path==='/favicon.ico') { body=Buffer.alloc(0);status=204;contentType='image/x-icon'; } else {
   const file=resolve('dist/web',path==='/'?'index.html':'.'+path);assert(file.startsWith(resolve('dist/web')+'/'));
   body=await readFile(file);contentType={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'}[extname(file)] ?? 'text/plain';
  }
  await page('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:contentType},{name:'Content-Security-Policy',value:"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}],body:body.toString('base64')});
 }
 await page('Page.enable');await page('Runtime.enable');await page('Fetch.enable',{patterns:[{urlPattern:'https://rootlane.test/*'}]});
 const evaluate=async expression=>{const r=await page('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const wait=async expression=>{for(let i=0;i<120;i++){if(await evaluate(`!!(${expression})`))return;await pause(50);}throw Error('Wait failed: '+expression+' notices='+JSON.stringify(await evaluate('Array.from(document.querySelectorAll(".notice.bad")).map(el=>el.textContent)'))+' actions='+JSON.stringify(requests.filter(r=>r.path.endsWith('_environment')).slice(-4)));};
 await page('Page.navigate',{url:'https://rootlane.test/'});
 await wait('document.querySelectorAll(".project-row").length===12');
 const refresh=()=>evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);
 const escape=()=>page('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 const key=key=>page('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:{ArrowDown:40,ArrowUp:38,Home:36,End:35,Tab:9,Enter:13}[key]});
 const captures=[],metrics=[];
 const capture=async name=>{if (process.env.ROOTLANE_CAPTURE_ONLY && !name.startsWith(process.env.ROOTLANE_CAPTURE_ONLY)) { captures.push(name); return; } if (process.env.ROOTLANE_CAPTURE==='0' && !name.startsWith('settings-')) { captures.push(name); return; } await evaluate('document.fonts.ready');await pause(400); const {data}=await page('Page.captureScreenshot',{captureBeyondViewport:!name.startsWith('v070-details-')&&!name.startsWith('v070-activity-')});await writeFile(`${evidence}/${name}.png`,Buffer.from(data,'base64'));captures.push(name);};
 const menu=async(id='p0')=>{await evaluate(`document.querySelector('#project-${id} .project-actions > button[aria-haspopup=menu]').click()`);await wait('document.querySelector("#project-detail")');await wait('document.querySelector(":popover-open")');};
 const choose=async label=>{await evaluate(`[...document.querySelectorAll(':popover-open button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);};
 const details=async(id='p0')=>{await menu(id);await choose('Details');await wait('document.querySelector("#project-detail")');};
 const close=async()=>{await evaluate('document.querySelector("#project-detail").focus()');await escape();await wait('!document.querySelector("#project-detail")');};
 const tab=async name=>{await evaluate(`document.getElementById('tab-${name}').click()`);};
 assert(!requests.some(r=>r.path.endsWith('get_project')),'Closed panels do not fetch detail HTTP probes');
 for(const width of [390,768,1100,1440,1920]) {
  await page('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
  await evaluate('window.scrollTo(0,0)');await pause(100);
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,`list overflow at ${width}`);
  await capture(`v070-projects-${width}`);
  await details();await wait('document.querySelector("#project-detail").textContent.includes("began listening")');
  assert.equal(await evaluate('document.querySelector("#project-detail").scrollWidth>document.querySelector("#project-detail").clientWidth'),false,`panel overflow at ${width}`);
  const bounds=await evaluate(`(()=>{const p=document.querySelector('#project-detail'),r=p.getBoundingClientRect();return {width:r.width,top:r.top,height:r.height,role:p.getAttribute('role')}})()`);
  if(width<1100) {assert.equal(bounds.role,'dialog');assert.equal(bounds.width,width);assert.equal(bounds.top,0);assert.equal(bounds.height,900);}
  else {assert.equal(bounds.role,null);assert.equal(bounds.width,660);}
  assert.equal(await evaluate('new URLSearchParams(location.search).get("project")'),'p0');
  assert(await evaluate('[...document.querySelectorAll(".rmap:not(.h)")].every(e=>e.getBoundingClientRect().height>30)'), 'Runtime rows are visible');
  assert(await evaluate('document.querySelector(".rmap:not(.h)").textContent.includes("https://neo.example.ts.net:19484/")'), 'Runtime URL maps to observed process');
  await capture(`v070-details-${width}`);
  if(width<1100) {
    await evaluate('[...document.querySelectorAll(".card-h button")].find(b=>b.textContent==="All activity").click()');
    await wait('document.querySelector("#activity-title")');
    assert.equal(await evaluate('document.querySelector("#tab-Overview").getAttribute("aria-selected")'),'true');
    assert.equal(await evaluate('document.querySelector("#detail-body").getAttribute("aria-labelledby")'),'activity-title');
    if(width===390) await capture('v070-activity-390');
    await evaluate('[...document.querySelectorAll("#project-detail button")].find(b=>b.textContent==="Back to Overview").click()');
    await wait('document.querySelector(".rmap")');
  }
  for(const name of width<1100?['Logs','Links','Agents','Worktrees']:['Logs','Services','Agents','Worktrees','Activity']) {
    await tab(name);await pause(60);assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,`${name} overflow at ${width}`);
  }
  await close();await wait('document.activeElement===document.querySelector("#project-p0 .project-open")');
 }
 await page('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await evaluate('document.querySelector("#project-p0 .project-open").click()');await wait('document.querySelector("#project-detail")');
 await evaluate('document.querySelector("#project-detail").focus()');await key('ArrowDown');await wait('new URLSearchParams(location.search).get("project")!=="p0"');
 assert.equal(await evaluate('document.querySelectorAll("#tab-Logs").length'),0,'Unmanaged has no Logs');
 await key('ArrowUp');await wait('new URLSearchParams(location.search).get("project")==="p0"');
 await evaluate('document.querySelector("#project-detail").focus()');await key('j');await wait('new URLSearchParams(location.search).get("project")!=="p0"');await key('k');await wait('new URLSearchParams(location.search).get("project")==="p0"');
 await evaluate('[...document.querySelectorAll("#project-detail button")].find(b=>b.textContent==="Widen").click()');
 assert.equal(await evaluate('document.querySelector("#project-detail").getBoundingClientRect().width'),1080);
 await tab('Agents');await page('Page.reload');await wait('document.querySelector("#tab-Agents[aria-selected=true]")');
 assert.equal(await evaluate('document.querySelector("#project-detail").getBoundingClientRect().width'),1080);
 await close();await wait('document.activeElement===document.querySelector("#project-p0 .project-open")');
 await evaluate('history.back()');await wait('document.querySelector("#project-detail")');await evaluate('history.forward()');await wait('!document.querySelector("#project-detail")');
 delayProject=700;await details('p5');assert.equal(await evaluate('document.querySelectorAll("#project-detail [role=tab] b").length'),0,'Unloaded tabs have no counts');await wait('document.querySelector("#tab-Agents b")');delayProject=0;await close();
 await details();await tab('Logs');await wait('document.querySelector(".logs").textContent.includes("bounded")');
 await evaluate('[...document.querySelectorAll(".toggle")].find(b=>b.textContent==="Errors only").click()');assert(!await evaluate('document.querySelector(".logs").textContent.includes("INFO")'));assert(await evaluate('document.querySelector(".logs").textContent.includes("WARN")'));
 await evaluate('[...document.querySelectorAll(".toggle")].find(b=>b.textContent==="Follow").click()');await pause(1150);assert(requests.some(r=>r.path.endsWith('get_logs')&&r.payload.cursor==='s=test;i=1'),'Follow uses cursor');
 const logCalls=requests.filter(r=>r.path.endsWith('get_logs')).length;await tab('Overview');await pause(1200);assert.equal(requests.filter(r=>r.path.endsWith('get_logs')).length,logCalls,'Follow stops when Logs hidden');
 failProject=true;await refresh();await wait('document.querySelector("#project-detail").textContent.includes("Controlled project failure")');failProject=false;await close();
 await details('p1');assert(!await evaluate('!!document.querySelector("#tab-Logs")'));await close();
 failCatalog=true;await refresh();await wait('document.querySelector("main").textContent.includes("Controlled catalog failure")');assert.equal(await evaluate('document.querySelectorAll(".project-row").length'),12);failCatalog=false;
 disconnect=true;await refresh();await wait('document.querySelector(".conn").textContent.includes("Disconnected")');disconnect=false;await refresh();await wait('document.querySelector(".conn").textContent.includes("Connected")');
 await details();failActionOnce=true;await wait('[...document.querySelectorAll(".dr-actions button")].some(b=>b.textContent.startsWith("Stop")&&!b.disabled)');await evaluate('[...document.querySelectorAll(".dr-actions button")].find(b=>b.textContent.startsWith("Stop")).click()');await wait('document.querySelector("main > .notice.bad")?.textContent.includes("OPERATION_IN_PROGRESS")');await close();await evaluate('[...document.querySelectorAll("main > .notice.bad button")].find(b=>b.textContent==="Retry action").click()');await wait('!document.querySelector("main > .notice.bad")');assert.equal(requests.filter(r=>r.path.endsWith('stop_environment')).slice(-2)[0].payload.requestId,requests.filter(r=>r.path.endsWith('stop_environment')).at(-1).payload.requestId);
 for(const width of [390,1440]) {await page('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});await evaluate('document.querySelector(".main-nav button:last-child").click()');await wait('document.querySelector(".settings-nav")');await evaluate('document.querySelector(".settings-nav button:last-child").click()');await wait('document.querySelector(".mcp-tools").textContent.includes("list_checks")');assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);}
 unlocked=false;await page('Page.reload');await wait('document.querySelector("#credential")');assert.deepEqual(consoleErrors,[]);
 await writeFile(evidence+'/v070-browser-results.json',JSON.stringify({captures,metrics,peakCatalog,requests,consoleErrors},null,2));
 console.log('PASS detail panel, five widths, keyboard/focus, URL reload/history, Widen, unloaded counts, managed tabs, cursor Follow, retry UUIDs, disconnect, MCP, strict CSP');
} finally {socket?.close();child.kill('SIGTERM');if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
