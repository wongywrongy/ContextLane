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
  if(message.method==='Fetch.requestPaused')void respond(message.params).catch(error=>{ if(!String(error).includes('Invalid InterceptionId')) consoleErrors.push(String(error)); });
 };
 const {targetId}=await send('Target.createTarget',{url:'about:blank'});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 const page=(method,params={})=>send(method,params,sessionId);
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 let unlocked=true; let failProject=false,failLogs=false,failCatalog=false,failEnvironment=false,failPreview=false,disconnect=false,delayProject=0,delayCatalog=0,delayLogs=0,activeCatalog=0,peakCatalog=0;
 const previewId='12345678-1234-4234-8234-123456789abc';
 const projects=Array.from({length:12},(_,i)=>({id:'p'+i,name:i===0?'Disposable fixture':'Project '+i,path:'/code/'+('long-checkout-path/'.repeat(i===1?8:1))+i,gitCommonDir:null,branch:'feature/a-very-long-branch-name',detached:false,manifests:['package.json'],links:i===1?[{label:'Homepage',url:'https://example.invalid/'}]:[],agents:i===0?Array.from({length:5},(_,a)=>({name:a%2?'Claude Code':'Codex',source:'detected process',id:String(a).repeat(24),cwd:'/code',worktreePath:'/code/long-checkout-path/0'})):[],previewIds:i===0?[previewId]:[],environmentIds:i===0?['env']:[],logServices:i===0?[{environmentId:'env',serviceId:'web'}]:[],runtime:{services:i===0?[{id:'web',name:'Web',port:3000},{id:'api',name:'API',port:4000},{id:'worker',name:'Worker',port:5000},{id:'debug',name:'Debug',port:6000}]:[],status:i===0?'listeners observed':'no associated listener',ports:i===0?[3000,4000,5000,6000]:[],ownership:'observe-only'}}));
 async function respond(event) {
  const {requestId,request}=event;const url=new URL(request.url);const path=url.pathname;
  let status=200,body,contentType='application/json';
  if(path.startsWith('/api/')) {
   const payload=request.postData?JSON.parse(request.postData):{};requests.push({path,payload,at:Date.now()});
   if(disconnect){await page('Fetch.failRequest',{requestId,errorReason:'ConnectionRefused'});return;}
   if(path==='/api/session'){status=unlocked?200:401;body=unlocked?{csrf:'test'}:{message:'Unlock required'};}
   else if(path==='/api/login'){unlocked=true;body={csrf:'test'};}
   else if(path==='/api/status')body={connected:true,tailscale:{status:'connected',hostname:'neo.example.ts.net'},lifecycleAvailable:true,projectRoots:['/code'],observationRoots:['/code','/worktrees']};
   else if(path.endsWith('list_projects')){activeCatalog++;peakCatalog=Math.max(peakCatalog,activeCatalog);const failed=failCatalog;await pause(delayCatalog);activeCatalog--;status=failed?503:200;body=failed?{message:'Controlled catalog failure'}:{projects,nextCursor:null,warnings:[],observedAt:'2026-10-10T01:00:00Z'};}
   else if(path.endsWith('get_project')){const failed=failProject;await pause(delayProject);status=failed?503:200;body=failed?{message:'Controlled project failure'}:{project:projects.find(p=>p.id===payload.projectId),checkoutIds:[payload.projectId],services:[],approvedTargetIds:[],previews:payload.projectId==='p0'?[{previewId,checkoutId:'p0',serviceId:'web'}]:[],logServices:payload.projectId==='p0'?[{environmentId:'env',serviceId:'web'}]:[]};}
   else if(path.endsWith('get_environment')){status=failEnvironment?503:200;body=failEnvironment?{message:'Controlled environment failure'}:{id:'env',profileRevision:'test',effects:'test',dataRequirements:'None',startAllowed:true,ownership:'rootlane',desiredState:'running',application:'ready',preview:'available',links:[],services:[{id:'web',port:3000,unit:'rootlane-web.service',state:'active'},{id:'api',port:4000,unit:'rootlane-api.service',state:'active'}],observedAt:'2026-10-10T01:00:00Z',latestOperation:null,recentOperations:[],previewRoutes:[],observationError:null};}
   else if(path.endsWith('get_preview')){status=failPreview?503:200;body=failPreview?{message:'Controlled preview failure'}:{id:previewId,targetId:'web',projectPath:'/code',checkoutPath:projects[0].path,serviceId:'web',serviceName:'Web',port:3000,httpsPort:19484,ownership:'rootlane route only',approved:true,removed:false,url:'https://neo.example.ts.net:19484/',route:'matching',actualConfiguration:{},upstream:'ready',https:'verified',errors:[],observedAt:'2026-10-10T01:00:00Z',verifiedAt:'2026-10-10T01:00:00Z',latestOperation:null};}
   else if(path.endsWith('start_environment') || path.endsWith('stop_environment')) body={};
   else if(path.endsWith('get_logs')){const failed=failLogs;await pause(delayLogs);status=failed?503:200;body=failed?{message:'Controlled logs failure'}:{lines:['bounded log output '.repeat(80)],nextCursor:null,truncated:true};}
   else throw Error('Unexpected API '+path);
   body=Buffer.from(JSON.stringify(body));
  } else if(path==='/favicon.ico') { body=Buffer.alloc(0);status=204;contentType='image/x-icon'; } else {
   const file=resolve('dist/web',path==='/'?'index.html':'.'+path);assert(file.startsWith(resolve('dist/web')+'/'));
   body=await readFile(file);contentType={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'}[extname(file)] ?? 'text/plain';
  }
  await page('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:contentType}],body:body.toString('base64')});
 }
 await page('Page.enable');await page('Runtime.enable');await page('Fetch.enable',{patterns:[{urlPattern:'https://rootlane.test/*'}]});
 const evaluate=async expression=>{const r=await page('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const wait=async expression=>{for(let i=0;i<120;i++){if(await evaluate(`!!(${expression})`))return;await pause(50);}throw Error('Wait failed: '+expression);};
 await page('Page.navigate',{url:'https://rootlane.test/'});await wait('document.querySelectorAll(".project").length===12');
 await wait('document.querySelector(".proj-head").textContent.includes("Stop")');
 assert.equal(await evaluate('document.querySelectorAll(".project-details").length'),0);
 assert(await evaluate('document.querySelector("#project-p1 .pv").textContent.includes("Not exposed") && !document.querySelector("#project-p1 .pv a")'),'Known URL is not a published preview');
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
 await openTab('Worktrees');await wait('document.querySelector(".project-details table")');await capture('expanded');
 for(const tab of ['Agents','Services','Preview','Environment','Activity']) {await evaluate(`document.getElementById('tab-p0-${tab}').click()`);await wait(`document.querySelector('[role=tabpanel]').getAttribute('aria-labelledby')==='tab-p0-${tab}'`);await capture('tab-'+tab.toLowerCase());}
 await evaluate(`document.getElementById('tab-p0-Environment').click()`);
 await evaluate(`document.querySelector('.environment-actions button:last-child').click()`);await wait('document.querySelector(".logs pre").textContent.includes("bounded")');
 await evaluate(`document.querySelector('.logs').scrollIntoView({block:'center'})`);await capture('environment-logs');await evaluate('window.scrollTo(0,0)');
 failLogs=true;await evaluate(`document.querySelector('.environment-actions button:last-child').click()`);await wait('document.querySelector(".logs").textContent.includes("Controlled logs failure")');failLogs=false;
 const actionRefreshBefore=requests.filter(r=>r.path.endsWith('list_projects')).length;
 await evaluate(`document.querySelector('#project-p0 .proj-head .btn').click()`);await wait(`document.querySelector('#project-p0 .proj-head .btn')`);
 assert(requests.some(r=>r.path.endsWith('stop_environment') && r.payload.environmentId==='env'));assert(requests.filter(r=>r.path.endsWith('list_projects')).length>actionRefreshBefore,'Immediate refresh after lifecycle action');
 failProject=true;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait('document.querySelector(".project-details").textContent.includes("Controlled project failure")');failProject=false;
 failEnvironment=true;failPreview=true;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait('document.querySelector(".project-details").textContent.includes("Controlled environment failure")');
 assert(!await evaluate('!!document.querySelector(".proj-head .btn")'),'No lifecycle controls for stale environment');
 await evaluate(`document.getElementById('tab-p0-Preview').click()`);await wait('document.querySelector(".project-details").textContent.includes("Controlled preview failure")');assert(await evaluate('document.querySelector("#project-p0 .pv .chip").textContent.includes("Unknown")'));
 failEnvironment=false;failPreview=false;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait('!document.querySelector(".project-details").textContent.includes("Controlled")');
 delayCatalog=400;const before=requests.filter(r=>r.path.endsWith('list_projects')).length;
 await evaluate(`(()=>{const button=document.querySelector('[aria-label="Refresh projects"]');button.click();button.click();button.click();})()`);await pause(1600);assert.equal(requests.filter(r=>r.path.endsWith('list_projects')).length-before>=2,true);assert.equal(peakCatalog,1);delayCatalog=0;
 failCatalog=true;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait(`document.querySelector('.notice.bad')?.textContent.includes('Controlled catalog failure')`);failCatalog=false;
 disconnect=true;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait(`document.querySelector('.conn').textContent.includes('Disconnected')`);assert.equal(await evaluate('document.querySelectorAll(".project").length'),12);
 disconnect=false;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait(`document.querySelector('.conn').textContent.includes('Connected') && !document.querySelector('.notice.bad')`);
 await evaluate(`document.querySelector('.main-nav button:last-child').click()`);await capture('settings');
 await evaluate(`document.querySelector('.settings-nav button:last-child').click()`);await capture('mcp-desktop');
 await page('Emulation.setDeviceMetricsOverride',{width:390,height:1000,deviceScaleFactor:1,mobile:true});await pause(100);assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await capture('mcp-mobile');
 await page('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});assert.equal(await evaluate('getComputedStyle(document.querySelector(".seg button")).transitionDuration'),'0s');
 await evaluate(`document.querySelector('.main-nav button:first-child').click()`);await evaluate('window.scrollTo(0,0)');
 await page('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await page('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
 assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineStyle'),'solid','Visible keyboard focus');
 unlocked=false;await page('Page.reload');await wait('document.querySelector("#credential")');assert(!await evaluate('!!document.querySelector(".topbar")'));await capture('unlock-mobile');
 await page('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await capture('unlock');
 assert.deepEqual(consoleErrors,[]);await writeFile(evidence+'/browser-results.json',JSON.stringify({captures,peakCatalog,requests,consoleErrors},null,2));
 console.log('PASS Signal desktop/tablet/mobile, collapsed summaries, tabs, logs, search shortcut, stale observations, menu focus, coalesced refresh, settings, unlock and reduced motion');
} finally {socket?.close();child.kill('SIGTERM');if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
