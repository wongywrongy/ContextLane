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
 const projects=Array.from({length:12},(_,i)=>({id:'p'+i,name:i===0?'Disposable fixture':i===1?'A very long project name that must never displace the menu control':'Project '+i,path:'/code/'+('long-checkout-path/'.repeat(i===1?8:1))+i,recipe:i===0?{found:true,valid:true,errors:[],approval:'approved'}:undefined,controls:i===0?[{id:'env',desiredState:'running',hasResources:true,startAllowed:true,latestOperation:null}]:[],devCommand:i===0?'vite':undefined,git:{dirty:2,ahead:1,behind:0,lastCommit:{sha7:'abcdef1',subject:'Fixture change',committedAt:snapshotTime}},gitCommonDir:null,branch:'feature/a-very-long-branch-name',detached:false,manifests:['package.json'],links:i===0?[{label:'Docs',url:'https://docs.rootlane.test/'}]:i===1?[{label:'Homepage',url:'https://example.invalid/'}]:[],agents:i===0?Array.from({length:5},(_,a)=>({name:a%2?'Claude Code':'Codex',source:'detected process',id:String(a).repeat(24),startedAt:new Date(Date.now()-3800000).toISOString(),pid:100+a,cwd:'/code',worktreePath:'/code/long-checkout-path/0'})):[],previewIds:i===0?[previewId]:[],environmentIds:i===0?['env','env2']:[],logServices:i===0?[{environmentId:'env',serviceId:'web'}]:[],runtime:{listeners:i===0?[3000,4000,5000,6000].map((port,index)=>({port,checkoutId:'p0',worktreePath:'/code/long-checkout-path/0',loopback:true,process:{name:index===0?'vite':index===1?'uvicorn':'node worker.js',pid:200+index,startedAt:'2026-10-10T00:50:00Z'}})):[],services:i===0?[{id:'web',name:'Web',port:3000},{id:'api',name:'API',port:4000},{id:'worker',name:'Worker',port:5000},{id:'debug',name:'Debug',port:6000}]:[],status:i===0?'listeners observed':'no associated listener',ports:i===0?[3000,4000,5000,6000]:[],ownership:'observe-only'}}));
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
   else if(path.endsWith('get_environment')){const second=payload.environmentId==='env2',url=second?'https://neo.example.ts.net:19485/':'https://neo.example.ts.net:19484/';status=failEnvironment?503:200;body=failEnvironment?{message:'Controlled environment failure'}:{ports:{web:second?7000:3000,api:4000},previews:[{serviceId:'web',label:'Console',port:second?19485:19484,url}],id:payload.environmentId,profileRevision:'test',effects:'test',dataRequirements:'None',startAllowed:true,ownership:'rootlane',desiredState:'running',application:'ready',preview:'available',links:[],services:[{id:'web',port:second?7000:3000,unit:'rootlane-web.service',state:'active'},{id:'api',port:4000,unit:'rootlane-api.service',state:'active'}],observedAt:snapshotTime,latestOperation:null,recentOperations:[],previewRoutes:[{url,target:'http://127.0.0.1:7000',route:'matching',https:second?'unverified':'verified',upstream:'ready'}],observationError:null};}
   else if(path.endsWith('get_preview')){status=failPreview?503:200;body=failPreview?{message:'Controlled preview failure'}:{id:previewId,targetId:'web',projectPath:'/code',checkoutPath:projects[0].path,serviceId:'web',serviceName:'Web',port:3000,httpsPort:19484,ownership:'rootlane route only',approved:true,removed:false,url:'https://neo.example.ts.net:19484/',route:'matching',actualConfiguration:{},upstream:'ready',https:'verified',errors:[],observedAt:snapshotTime,verifiedAt:snapshotTime,latestOperation:null};}
   else if(failActionOnce && (path.endsWith('start_environment') || path.endsWith('stop_environment'))) {failActionOnce=false;status=503;body={code:'OPERATION_IN_PROGRESS',message:'Controlled action failure'};}
   else if(path.endsWith('start_environment') || path.endsWith('stop_environment')) body={operation:{id:previewId,environmentId:'env',action:payload.environmentId?'stop':'start',status:'succeeded',error:null,createdAt:snapshotTime,finishedAt:'2026-10-10T01:00:01Z'}};
   else if(path.endsWith('list_operations')) body={operations:[]};
   else if(path.endsWith('request_environment')){pendingApproval=true;projects[0].recipe.approval='pending';body={status:'pending',approvalUrl:'https://rootlane.test/?approval='+previewId,resolvedPreview:approval.preview};}
   else if(path.endsWith('publish_preview') || path.endsWith('unpublish_preview')) body={operation:{id:previewId,previewId,action:payload.targetId?'publish':'unpublish',status:'succeeded',error:null,createdAt:snapshotTime,finishedAt:'2026-10-10T01:00:01Z'},previewId,url:'https://neo.example.ts.net:19484/',verification:'verified'};
   else if(path.endsWith('get_logs')){const failed=failLogs;await pause(delayLogs);status=failed?503:200;body=failed?{message:'Controlled logs failure'}:{lines:['bounded log output '.repeat(80)],nextCursor:null,truncated:true};}
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
 const capture=async name=>{if (process.env.ROOTLANE_CAPTURE_ONLY && !name.startsWith(process.env.ROOTLANE_CAPTURE_ONLY)) { captures.push(name); return; } if (process.env.ROOTLANE_CAPTURE==='0' && !name.startsWith('settings-')) { captures.push(name); return; } await evaluate('document.fonts.ready');await pause(400); const {data}=await page('Page.captureScreenshot',{captureBeyondViewport:!name.startsWith('details-')});await writeFile(`${evidence}/${name}.png`,Buffer.from(data,'base64'));captures.push(name);};
 const menu=async(id='p0')=>{await evaluate(`document.querySelector('#project-${id} .project-actions > button').click()`);await wait('document.querySelector(":popover-open")');};
 const choose=async label=>{await evaluate(`[...document.querySelectorAll(':popover-open button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);};
 const details=async(id='p0')=>{await menu(id);await choose('Details');await wait('document.querySelector(".details-drawer[open]")');};
 const close=async()=>{await escape();await wait('!document.querySelector(".details-drawer")');};
 const tab=async name=>{await evaluate(`document.getElementById('tab-p0-${name}').click()`);};
 assert(!requests.some(r=>r.path.endsWith('get_environment')||r.path.endsWith('get_preview')),'List does not trigger readiness probes');
 assert.equal(await evaluate('document.querySelectorAll("#project-p0 .agent-item").length'),5);
 assert.equal(await evaluate('document.querySelectorAll("#project-p0 .service-line").length'),3);
 assert(await evaluate('document.querySelector("#project-p0 .services-cell").textContent.includes("+1 services")'));
 assert.equal(await evaluate('document.querySelectorAll(".details-drawer").length'),0);
 for(const width of [360,390,768,1280,1440]) {
  await page('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
  await evaluate('window.scrollTo(0,0)');await pause(100);
  const layout=await evaluate(`({overflow:document.documentElement.scrollWidth>innerWidth,columns:getComputedStyle(document.querySelector('.project-row')).gridTemplateColumns.split(' ').length,menuRight:document.querySelector('#project-p1 .menu-cell').getBoundingClientRect().right,agentCount:document.querySelectorAll('#project-p0 .agent-item').length,serviceLines:[...document.querySelectorAll('.service-line')].every(el=>{const spans=el.querySelectorAll('span');return Math.abs(spans[1].getBoundingClientRect().top-spans[2].getBoundingClientRect().top)<3})})`);
  assert.equal(layout.overflow,false,JSON.stringify({width,layout}));assert.equal(layout.columns,width<1000?2:6);assert(layout.menuRight<=width);assert(layout.serviceLines);
  await capture(`projects-${width}`);
  if (width === 390) {
    const touch = await evaluate(`(()=>{const r=document.querySelector('#project-p0 .project-actions > button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await page('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch]});await page('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await wait('document.querySelector(":popover-open")');await escape();
  }
  await evaluate(`(()=>{const b=[...document.querySelectorAll('.project-actions > button')].at(-1);b.scrollIntoView({block:'end'});b.click()})()`);await wait('document.querySelector(":popover-open")');await pause(50);
  const bounds=await evaluate(`(()=>{const r=document.querySelector(':popover-open').getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}})()`);
  assert(bounds.top>=0&&bounds.bottom<=900&&bounds.left>=0&&bounds.right<=width,JSON.stringify({width,bounds}));
  await key('End');assert.equal(await evaluate('document.activeElement.textContent'),'Copy path');await key('Home');assert.equal(await evaluate('document.activeElement.textContent'),'Details');
  await escape();await wait('!document.querySelector(":popover-open")');await wait('document.activeElement===[...document.querySelectorAll(".project-actions > button")].at(-1)');
  await evaluate('window.scrollTo(0,0)');
  await details();await wait('document.querySelector(".project-details table")');
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  assert(await evaluate('document.querySelector(".details-drawer").textContent.includes("/code/long-checkout-path/0")'));
  await capture(`details-${width}`);
  if (width === 390) for (const section of ['Agents','Services','Links','Environment']) {
    await tab(section);await pause(50);
    assert.equal(await evaluate('document.querySelector(".details-drawer").scrollWidth>document.querySelector(".details-drawer").clientWidth'),false,`${section} panel overflow`);
  }
  await close();
  metrics.push({width,...layout,bounds});
 }
 const started = projects[0].agents[4].startedAt;
 delete projects[0].agents[4].startedAt;
 projects[2].branch=null;projects[3].detached=true;projects[3].detachedSha='abcdef1';projects[4].runtime.status='unknown';
 await refresh();await wait('document.querySelector("#project-p2 .branch-cell").textContent.includes("Non-Git")');
 assert(await evaluate('document.querySelector("#project-p3 .branch-cell").textContent.includes("detached @ abcdef1")'));
 assert(await evaluate('document.querySelector("#project-p4").textContent.includes("Observation unavailable")'));
 assert.equal(await evaluate('document.querySelectorAll("#project-p0 .agent-duration").length'),4);
 projects[0].agents[4].startedAt=started;projects[2].branch='feature/a-very-long-branch-name';projects[3].detached=false;projects[4].runtime.status='no associated listener';await refresh();
 await page('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await menu();await refresh();await pause(300);assert(await evaluate('!!document.querySelector(":popover-open")'),'Refresh preserves menu');
 await page('Input.dispatchMouseEvent',{type:'mousePressed',x:10,y:200,button:'left',clickCount:1});await page('Input.dispatchMouseEvent',{type:'mouseReleased',x:10,y:200,button:'left',clickCount:1});await wait('!document.querySelector(":popover-open")');
 await menu();await choose('Copy path');await wait('document.querySelector("#project-p0 [role=status]")?.textContent==="Path copied"');assert.equal(await evaluate('navigator.clipboard.readText()'),projects[0].path);
 await evaluate(`navigator.clipboard.writeText=async()=>{throw Error('Controlled denial')}`);await menu('p1');await choose('Copy path');await wait('document.querySelector("#project-p1 [role=status]")?.textContent.includes("Copy unavailable")');
 await menu();await choose('Logs');await wait('document.querySelector(".logs pre")?.textContent.includes("bounded")');
 assert(await evaluate('document.querySelector(".drawer-header").textContent.includes("Disposable fixture")'));
 failLogs=true;await evaluate('document.querySelector(".environment-actions button:last-child").click()');await wait('document.querySelector(".logs").textContent.includes("Controlled logs failure")');failLogs=false;
 await refresh();await pause(300);assert(await evaluate('!!document.querySelector(".details-drawer[open]")'),'Refresh preserves details');
 await tab('Links');await wait('document.querySelector(".project-details").textContent.includes("Available")');
 failEnvironment=true;failPreview=true;await refresh();await wait('document.querySelector(".project-details").textContent.includes("Controlled preview failure")');
 assert(await evaluate('document.querySelector(".conn").textContent.includes("Connected")'),'Partial failure retains connection');
 assert.equal(await evaluate('document.querySelectorAll("#project-p0 .links-cell .green").length'),0);
 failEnvironment=false;failPreview=false;await refresh();await wait('!document.querySelector(".project-details").textContent.includes("Controlled preview failure")');
 failProject=true;await refresh();await wait('document.querySelector(".project-details").textContent.includes("Controlled project failure")');assert(await evaluate('document.querySelector(".conn").textContent.includes("Connected")'));failProject=false;await close();
 delayProject=500;await details();await pause(100);await close();await details('p1');await pause(800);assert(await evaluate('document.querySelector(".drawer-header").textContent.includes("A very long project")'));assert(!await evaluate('document.querySelector(".project-details").textContent.includes("rootlane-web.service")'));delayProject=0;await close();
 delayLogs=500;await menu();await choose('Logs');await pause(100);await close();await details('p1');await pause(700);assert(!await evaluate('!!document.querySelector(".logs")'));delayLogs=0;await close();
 delayCatalog=300;await evaluate(`(()=>{const b=document.querySelector('[aria-label="Refresh projects"]');b.click();b.click();b.click()})()`);await pause(800);assert.equal(peakCatalog,1);delayCatalog=0;
 failCatalog=true;await refresh();await wait('document.querySelector("main").textContent.includes("Controlled catalog failure")');assert.equal(await evaluate('document.querySelectorAll(".project-row").length'),12);failCatalog=false;
 disconnect=true;await refresh();await wait('document.querySelector(".conn").textContent.includes("Disconnected")');disconnect=false;await refresh();await wait('document.querySelector(".conn").textContent.includes("Connected") && !document.querySelector("main").textContent.includes("Controlled catalog failure")');
 await page('Input.dispatchKeyEvent',{type:'keyDown',key:'k',code:'KeyK',modifiers:2,windowsVirtualKeyCode:75});assert(await evaluate('document.activeElement===document.querySelector(".cmd input")'));await page('Input.insertText',{text:'6000'});await wait('document.querySelectorAll(".project-row").length===1');
 await evaluate(`(()=>{const input=document.querySelector('.cmd input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}))})()`);await wait('document.querySelectorAll(".project-row").length===12');
 await evaluate(`[...document.querySelectorAll('.filters button')].find(b=>b.textContent.startsWith('With agents')).click()`);await wait('document.querySelectorAll(".project-row").length===1');await evaluate('document.querySelector(".filters button").click()');
 await details();await evaluate(`document.querySelector('.drawer-recipe .btn').click()`);await close();await wait('document.querySelector(".approval-review .primary:not(:disabled)")');await evaluate('document.querySelector(".approval-review .primary").click()');await wait('!document.querySelector(".approval-review")');assert(requests.some(r=>r.path.endsWith('/approve')));
 await details();await tab('Environment');failActionOnce=true;await wait('[...document.querySelectorAll(".environment-actions button")].some(b=>b.textContent.startsWith("Stop"))');await evaluate('[...document.querySelectorAll(".environment-actions button")].find(b=>b.textContent.startsWith("Stop")).click()');await wait('document.querySelector("main > .notice.bad")?.textContent.includes("OPERATION_IN_PROGRESS")');await close();await evaluate('document.querySelector("main > .notice.bad .btn").click()');await wait('!document.querySelector("main > .notice.bad")');assert.equal(requests.filter(r=>r.path.endsWith('stop_environment')).slice(-2)[0].payload.requestId,requests.filter(r=>r.path.endsWith('stop_environment')).at(-1).payload.requestId);
 projects.push({...projects[11],id:'nested',name:'Nested checkout',path:projects[0].path+'/fixtures/api',environmentIds:['nested-env'],logServices:[],agents:[],links:[]});
 await refresh();await wait('document.querySelectorAll(".project-row").length===12');await details();
 await wait('document.querySelector(".project-details").textContent.includes("Nested checkout")');
 assert(requests.some(r=>r.path.endsWith('get_environment')&&r.payload.environmentId==='nested-env'),'Grouped nested checkout gets environment observation');
 await close();projects.pop();await refresh();
 for(const width of [390,1440]) {await page('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});await evaluate('document.querySelector(".main-nav button:last-child").click()');await wait('document.querySelector(".settings-nav")');await evaluate('document.querySelector(".settings-nav button:first-child").click()');await pause(50);await capture(`settings-${width}`);assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await evaluate('document.querySelector(".settings-nav button:last-child").click()');await capture(`mcp-${width}`);assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);}
 unlocked=false;await page('Page.reload');await wait('document.querySelector("#credential")');assert(!await evaluate('!!document.querySelector(".topbar")'));
 assert.deepEqual(consoleErrors,[]);await writeFile(evidence+'/browser-results.json',JSON.stringify({captures,metrics,peakCatalog,requests,consoleErrors},null,2));
 console.log('PASS observation table at five widths, menus, details, logs, stale responses, partial failures, reconnect, filters, approvals, lifecycle, Settings and MCP');
} finally {socket?.close();child.kill('SIGTERM');if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
