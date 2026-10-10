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
 const previewId='12345678-1234-4234-8234-123456789abc';
 let pendingApproval=false;
 const approval={id:previewId,projectPath:'/code/.git',recipeHash:'a'.repeat(64),toolchainRevision:'b'.repeat(64),status:'pending',requestedAt:'2026-10-10T01:00:00Z',decidedAt:null,decidedBy:null,stale:false,preview:{instanceId:'env',projectPath:'/code/.git',checkoutPath:'/code/long-checkout-path/0',recipeHash:'a'.repeat(64),toolchainRevision:'b'.repeat(64),services:[{id:'web',command:['/usr/bin/node','node_modules/vite/bin/vite.js','--host','127.0.0.1'],cwd:'/code/long-checkout-path/0',envNames:['API_URL','API_TOKEN','ROOTLANE_PORT','ROOTLANE_PREVIEW_ORIGIN','ROOTLANE_PREVIEW_PORT'],port:20000,readiness:{path:'/',status:200,bodyIncludes:'<div id="root">',timeoutMs:15000}}],previews:[{serviceId:'web',label:'Console',port:20001,url:'https://neo.example.ts.net:20001/'}],setup:['make doctor']}};
 const projects=Array.from({length:12},(_,i)=>({id:'p'+i,name:i===0?'Disposable fixture':'Project '+i,path:'/code/'+('long-checkout-path/'.repeat(i===1?8:1))+i,recipe:i===0?{found:true,valid:true,errors:[],approval:'approved'}:undefined,controls:i===0?[{id:'env',desiredState:'running',hasResources:true,startAllowed:true,latestOperation:null}]:[],devCommand:i===0?'vite':undefined,git:{dirty:2,ahead:1,behind:0,lastCommit:{sha7:'abcdef1',subject:'Fixture change',committedAt:'2026-10-10T01:00:00Z'}},gitCommonDir:null,branch:'feature/a-very-long-branch-name',detached:false,manifests:['package.json'],links:i===0?[{label:'Docs',url:'https://docs.rootlane.test/'}]:i===1?[{label:'Homepage',url:'https://example.invalid/'}]:[],agents:i===0?Array.from({length:5},(_,a)=>({name:a%2?'Claude Code':'Codex',source:'detected process',id:String(a).repeat(24),startedAt:'2026-10-10T00:42:00Z',pid:100+a,cwd:'/code',worktreePath:'/code/long-checkout-path/0'})):[],previewIds:i===0?[previewId]:[],environmentIds:i===0?['env','env2']:[],logServices:i===0?[{environmentId:'env',serviceId:'web'}]:[],runtime:{listeners:i===0?[3000,4000,5000,6000].map((port,index)=>({port,checkoutId:'p0',worktreePath:'/code/long-checkout-path/0',loopback:true,process:{name:index===0?'vite':index===1?'uvicorn':'node worker.js',pid:200+index,startedAt:'2026-10-10T00:50:00Z'}})):[],services:i===0?[{id:'web',name:'Web',port:3000},{id:'api',name:'API',port:4000},{id:'worker',name:'Worker',port:5000},{id:'debug',name:'Debug',port:6000}]:[],status:i===0?'listeners observed':'no associated listener',ports:i===0?[3000,4000,5000,6000]:[],ownership:'observe-only'}}));
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
   else if(path.endsWith('list_projects')){activeCatalog++;peakCatalog=Math.max(peakCatalog,activeCatalog);const failed=failCatalog;await pause(delayCatalog);activeCatalog--;status=failed?503:200;body=failed?{message:'Controlled catalog failure'}:{projects,nextCursor:null,warnings:[],observedAt:'2026-10-10T01:00:00Z'};}
   else if(path.endsWith('get_project')){const failed=failProject;await pause(delayProject);status=failed?503:200;body=failed?{message:'Controlled project failure'}:{project:projects.find(p=>p.id===payload.projectId),checkoutIds:[payload.projectId],http:[{checkoutId:'p0',port:3000,http:{status:200,checkedAt:'2026-10-10T01:00:00Z'}}],services:[],approvedTargetIds:payload.projectId==='p0'?['api']:[],previews:payload.projectId==='p0'?[{previewId,checkoutId:'p0',serviceId:'web'}]:[],logServices:payload.projectId==='p0'?[{environmentId:'env',serviceId:'web'}]:[]};}
   else if(path.endsWith('get_environment')){const second=payload.environmentId==='env2',url=second?'https://neo.example.ts.net:19485/':'https://neo.example.ts.net:19484/';status=failEnvironment?503:200;body=failEnvironment?{message:'Controlled environment failure'}:{ports:{web:second?7000:3000,api:4000},previews:[{serviceId:'web',label:'Console',port:second?19485:19484,url}],id:payload.environmentId,profileRevision:'test',effects:'test',dataRequirements:'None',startAllowed:true,ownership:'rootlane',desiredState:'running',application:'ready',preview:'available',links:[],services:[{id:'web',port:second?7000:3000,unit:'rootlane-web.service',state:'active'},{id:'api',port:4000,unit:'rootlane-api.service',state:'active'}],observedAt:'2026-10-10T01:00:00Z',latestOperation:null,recentOperations:[],previewRoutes:[{url,target:'http://127.0.0.1:7000',route:'matching',https:second?'unverified':'verified',upstream:'ready'}],observationError:null};}
   else if(path.endsWith('get_preview')){status=failPreview?503:200;body=failPreview?{message:'Controlled preview failure'}:{id:previewId,targetId:'web',projectPath:'/code',checkoutPath:projects[0].path,serviceId:'web',serviceName:'Web',port:3000,httpsPort:19484,ownership:'rootlane route only',approved:true,removed:false,url:'https://neo.example.ts.net:19484/',route:'matching',actualConfiguration:{},upstream:'ready',https:'verified',errors:[],observedAt:'2026-10-10T01:00:00Z',verifiedAt:'2026-10-10T01:00:00Z',latestOperation:null};}
   else if(failActionOnce && (path.endsWith('start_environment') || path.endsWith('stop_environment'))) {failActionOnce=false;status=503;body={code:'OPERATION_IN_PROGRESS',message:'Controlled action failure'};}
   else if(path.endsWith('start_environment') || path.endsWith('stop_environment')) body={operation:{id:previewId,environmentId:'env',action:payload.environmentId?'stop':'start',status:'succeeded',error:null,createdAt:'2026-10-10T01:00:00Z',finishedAt:'2026-10-10T01:00:01Z'}};
   else if(path.endsWith('list_operations')) body={operations:[]};
   else if(path.endsWith('request_environment')){pendingApproval=true;projects[0].recipe.approval='pending';body={status:'pending',approvalUrl:'https://rootlane.test/?approval='+previewId,resolvedPreview:approval.preview};}
   else if(path.endsWith('publish_preview') || path.endsWith('unpublish_preview')) body={operation:{id:previewId,previewId,action:payload.targetId?'publish':'unpublish',status:'succeeded',error:null,createdAt:'2026-10-10T01:00:00Z',finishedAt:'2026-10-10T01:00:01Z'},previewId,url:'https://neo.example.ts.net:19484/',verification:'verified'};
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
 await page('Page.navigate',{url:'https://rootlane.test/'});await wait('document.querySelectorAll(".project").length===12');
 await wait('document.querySelector(".proj-head").textContent.includes("Stop")');
 assert.equal(await evaluate('document.querySelectorAll(".project-details").length'),0); assert(!requests.some(r=>r.path.endsWith('get_environment')||r.path.endsWith('get_preview')),'Collapsed projects do not trigger readiness probes');
 assert(await evaluate('document.querySelector("#project-p1 .pv").textContent.includes("Link") && !!document.querySelector("#project-p1 .pv a")'),'Known URL is not a published preview');
 assert(await evaluate('document.querySelector(".mark.codex svg") !== null && document.querySelector(".mark.claude svg") !== null'),'Both vendor marks render in collapsed agent rows');
 const mobileChecks=[];
 const mobileLayout=async(surface,width)=>{
  await page('Emulation.setDeviceMetricsOverride',{width,height:width>760?390:844,deviceScaleFactor:1,mobile:true});await pause(50);
  const metrics=await evaluate(`({overflow:document.documentElement.scrollWidth>innerWidth,tableOverflow:[...document.querySelectorAll('.tbl-wrap')].some(el=>el.scrollWidth>el.clientWidth+1),unlabeledCells:[...document.querySelectorAll('.tbl td')].filter(el=>!el.dataset.label).length,smallControls:[...document.querySelectorAll('button,select,input')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0 && r.height>0 && (r.height<43 || r.width<43)}).map(el=>el.getAttribute('aria-label')||el.textContent)})`);
  assert.equal(metrics.overflow,false,`${surface} ${width}: page overflow`);
  assert(await evaluate(`[...document.querySelectorAll('.links-list')].every(list=>{const rows=[...list.querySelectorAll('.link-row')].map(el=>el.getBoundingClientRect());return rows.every((row,i)=>i===0 || row.top>=rows[i-1].bottom)})`),`${surface} ${width}: overlapping link rows`);
  if(width<=760){assert(await evaluate('[...document.querySelectorAll(".tab")].every(el=>{const r=el.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth})'),`${surface}: hidden detail tab`);assert.equal(metrics.tableOverflow,false,`${surface} ${width}: table overflow`);assert.equal(metrics.unlabeledCells,0,`${surface}: missing mobile labels`);assert.deepEqual(metrics.smallControls,[],`${surface} ${width}: touch targets`);}
  mobileChecks.push({surface,width,...metrics});
 };
 const captures=[];
 const capture=async name=>{await evaluate('document.fonts.ready');await page('Page.captureScreenshot').then(({data})=>writeFile(`${evidence}/${name}.png`,Buffer.from(data,'base64')));};
 for(const [width,name] of [[1440,'desktop'],[1000,'tablet'],[390,'mobile']]) {
  await page('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<500});
  await evaluate('window.scrollTo(0,0)');await pause(100);
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,`Overflow at ${width}`);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".cols")).gridTemplateColumns.split(" ").length'),width>1100?3:width>760?2:1);
  await capture(name);
  await evaluate(`(()=>{const button=[...document.querySelectorAll('.project-actions > button')].at(-1);button.scrollIntoView({block:'end'});button.click();})()`);await pause(100);
  const bounds=await evaluate(`(()=>{const r=document.querySelector(':popover-open').getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}})()`);
  assert(bounds.top>=0 && bounds.bottom<=1000 && bounds.left>=0 && bounds.right<=width,JSON.stringify({width,bounds}));
  await page('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await wait('!document.querySelector(":popover-open")');
  await wait(`document.activeElement===[...document.querySelectorAll('.project-actions > button')].at(-1)`);
  captures.push({width,...bounds,escape:true});
 }
 await page('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await evaluate('window.scrollTo(0,0)');
 await page('Input.dispatchKeyEvent',{type:'keyDown',key:'k',code:'KeyK',modifiers:2,windowsVirtualKeyCode:75});
 assert(await evaluate('document.activeElement===document.querySelector(".cmd input")'));
 await page('Input.insertText',{text:'6000'});await wait('document.querySelectorAll(".project").length===1');
 await evaluate(`(()=>{const input=document.querySelector('.cmd input');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait('document.querySelectorAll(".project").length===12');
 const openTab=async tab=>{await evaluate(`document.querySelector('#project-p0 .dbar').click()`);await evaluate(`document.getElementById('tab-p0-${tab}').click()`);};
 for(const width of [320,360,390,430,760,844])await mobileLayout('Projects',width);
 await page('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await openTab('Worktrees');await wait('document.querySelectorAll("#project-p0 .link-row").length===3');assert.deepEqual(await evaluate('[...document.querySelectorAll("#project-p0 .link-row .chip")].map(el=>el.textContent)'),['Available','Published','Link']);assert(await evaluate(`(()=>{const rows=[...document.querySelectorAll('#project-p0 .link-row')].map(el=>el.getBoundingClientRect());return rows.every((row,i)=>i===0 || row.top>=rows[i-1].bottom)})()`),'Desktop link rows do not overlap');await wait('document.querySelector(".project-details table")');await wait('document.querySelector(".proj-head").textContent.includes("Stop")');await capture('expanded');for(const width of [320,390,430])await mobileLayout('Worktrees',width);await mobileLayout('Worktrees',390);await evaluate('window.scrollTo(0,document.querySelector(".tabs").getBoundingClientRect().top+scrollY-document.querySelector(".topbar").getBoundingClientRect().height-8)');await capture('mobile-worktrees');await page('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await evaluate('window.scrollTo(0,0)');
 for(const tab of ['Agents','Services','Links','Environment','Activity']) {await evaluate(`document.getElementById('tab-p0-${tab}').click()`);await wait(`document.querySelector('[role=tabpanel]').getAttribute('aria-labelledby')==='tab-p0-${tab}'`);if(tab==='Agents')assert(await evaluate('document.querySelector(".project-details .mark.codex svg") !== null'),'Codex mark renders in Agents details');await capture('tab-'+tab.toLowerCase());for(const width of [320,390,430])await mobileLayout(tab,width);await mobileLayout(tab,390);await evaluate('window.scrollTo(0,document.querySelector(".tabs").getBoundingClientRect().top+scrollY-document.querySelector(".topbar").getBoundingClientRect().height-8)');await capture('mobile-'+tab.toLowerCase());await page('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await evaluate('window.scrollTo(0,0)');}
 await evaluate(`document.getElementById('tab-p0-Services').click()`);
 await evaluate(`document.querySelector('#project-p0 .project-actions > button').click()`);await wait('document.querySelector(":popover-open")');await evaluate(`[...document.querySelectorAll(':popover-open button')].find(b=>b.textContent.includes('Request environment')).click()`);
 await wait('document.querySelector(".approval-review pre")');assert(await evaluate('document.querySelector(".approval-review").textContent.includes("API_TOKEN") && document.querySelector(".approval-review").textContent.includes("Rootlane never executes")'));
 for(const [width,name] of [[1440,'approval-desktop'],[1000,'approval-tablet'],[390,'approval-mobile']]) {await page('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<500});await evaluate('document.querySelector(".approval-review").scrollIntoView({block:"start"})');await pause(100);assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await capture(name);}
 for(const width of [320,390,430])await mobileLayout('Approval',width);
 await evaluate('document.querySelector(".approval-review .environment-actions").scrollIntoView({block:"center"})');await capture('approval-mobile-actions');
 approval.stale=true;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait('document.querySelector(".approval-review .notice.bad")');assert(!await evaluate('!!document.querySelector(".approval-review .primary")'));await capture('approval-stale-mobile');approval.stale=false;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait('document.querySelector(".approval-review .primary")');
 await evaluate('document.querySelector(".approval-review .primary").click()');await wait('!document.querySelector(".approval-review")');assert(requests.some(r=>r.path.endsWith('/approve')));
 await page('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false}); await evaluate('window.scrollTo(0,0)');
 await evaluate(`document.getElementById('tab-p0-Environment').click()`);
 await evaluate(`document.querySelector('.environment-actions button:last-child').click()`);await wait('document.querySelector(".logs pre").textContent.includes("bounded")');
 await evaluate(`document.querySelector('.logs').scrollIntoView({block:'center'})`);await capture('environment-logs');await evaluate('window.scrollTo(0,0)');
 failLogs=true;await evaluate(`document.querySelector('.environment-actions button:last-child').click()`);await wait('document.querySelector(".logs").textContent.includes("Controlled logs failure")');failLogs=false;
 failActionOnce=true; const actionRefreshBefore=requests.filter(r=>r.path.endsWith('list_projects')).length;
 await evaluate(`document.querySelector('#project-p0 .proj-head .btn').click()`);await wait(`document.querySelector('.notice.bad')?.textContent.includes('OPERATION_IN_PROGRESS')`);await evaluate(`document.querySelector('.notice.bad .btn').click()`);await wait(`!document.querySelector('main > .notice.bad') && document.querySelector('#project-p0 .proj-head .btn')`);const retries=requests.filter(r=>r.path.endsWith('stop_environment')).slice(-2);assert.equal(retries[0].payload.requestId,retries[1].payload.requestId,'Retry preserves click UUID');await wait(`document.querySelector('#project-p0 .proj-head .btn')`);
 assert(requests.some(r=>r.path.endsWith('stop_environment') && r.payload.environmentId==='env'));assert(requests.filter(r=>r.path.endsWith('list_projects')).length>actionRefreshBefore,'Immediate refresh after lifecycle action');
 failProject=true;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait('document.querySelector(".project-details").textContent.includes("Controlled project failure")');failProject=false;
 failEnvironment=true;failPreview=true;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait('document.querySelector(".project-details").textContent.includes("Controlled environment failure")');
 assert(!await evaluate('!!document.querySelector(".proj-head .btn")'),'No lifecycle controls for stale environment');
 await evaluate(`document.getElementById('tab-p0-Links').click()`);await wait('document.querySelector(".project-details").textContent.includes("Controlled preview failure")');assert(await evaluate('document.querySelector("#project-p0 .pv .chip").textContent.includes("Unknown")'));
 failEnvironment=false;failPreview=false;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait('!document.querySelector(".project-details").textContent.includes("Controlled")');
 await pause(150); delayCatalog=400;const before=requests.filter(r=>r.path.endsWith('list_projects')).length;
 await evaluate(`(()=>{const button=document.querySelector('[aria-label="Refresh projects"]');button.click();button.click();button.click();})()`);await pause(1600);assert.equal(requests.filter(r=>r.path.endsWith('list_projects')).length-before>=2,true);assert.equal(peakCatalog,1);delayCatalog=0;
 failCatalog=true;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait(`document.querySelector('.notice.bad')?.textContent.includes('Controlled catalog failure')`);failCatalog=false;
 disconnect=true;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait(`document.querySelector('.conn').textContent.includes('Disconnected')`);assert.equal(await evaluate('document.querySelectorAll(".project").length'),12);
 disconnect=false;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait(`document.querySelector('.conn').textContent.includes('Connected') && !document.querySelector('.notice.bad')`);
 await evaluate(`document.querySelector('.main-nav button:last-child').click()`);await capture('settings');for(const width of [320,390,430])await mobileLayout('Settings',width);await mobileLayout('Settings',390);await capture('settings-mobile');await page('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await evaluate(`document.querySelector('.settings-nav button:last-child').click()`);await capture('mcp-desktop');
 await page('Emulation.setDeviceMetricsOverride',{width:390,height:1000,deviceScaleFactor:1,mobile:true});await pause(100);assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await capture('mcp-mobile');for(const width of [320,390,430])await mobileLayout('MCP',width);await mobileLayout('MCP',390);await evaluate('document.querySelector(".mcp-tools").scrollIntoView({block:"center"})');await capture('mcp-tools-mobile');await evaluate('window.scrollTo(0,0)');
 await page('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});assert.equal(await evaluate('getComputedStyle(document.querySelector(".seg button")).transitionDuration'),'0s');
 await evaluate(`document.querySelector('.main-nav button:first-child').click()`);await evaluate('window.scrollTo(0,0)');
 await page('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await page('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
 assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineStyle'),'solid','Visible keyboard focus');
 assert(await evaluate(`!!document.querySelector('a[href^="vscode:"]')`));
 editorTemplate=null;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait('document.querySelector(".path .copy-path")');
 assert(!await evaluate(`!!document.querySelector('a[href^="vscode:"]')`));
 await evaluate('window.originalCopy=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=async()=>{throw Error("Controlled clipboard denial")};document.querySelector(".copy-path").click()');await wait('document.querySelector(".path").textContent.includes("Copy unavailable. Select the path.")');
 await evaluate('navigator.clipboard.writeText=window.originalCopy;document.querySelector(".copy-path").click()');await wait('document.querySelector(".path .copy-path").textContent==="Copied"');
 await capture('editor-fallback-mobile');
 unlocked=false;await page('Page.reload');await wait('document.querySelector("#credential")');assert(!await evaluate('!!document.querySelector(".topbar")'));await capture('unlock-mobile');for(const width of [320,390,430])await mobileLayout('Unlock',width);
 await page('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await capture('unlock');
 assert(!await evaluate('!!document.querySelector("[style],img[src^=\\"data:\\"]")'),'No inline styles or data images'); assert(await evaluate('document.querySelector(".mark.claude svg") !== null') || !await evaluate('document.querySelector(".mark.claude") !== null'));
 assert.deepEqual(consoleErrors,[]);await writeFile(evidence+'/browser-results.json',JSON.stringify({captures,mobileChecks,peakCatalog,requests,consoleErrors},null,2));
 console.log('PASS Signal desktop/tablet/mobile, collapsed summaries, tabs, logs, search shortcut, stale observations, menu focus, coalesced refresh, settings, unlock and reduced motion');
} finally {socket?.close();child.kill('SIGTERM');if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
