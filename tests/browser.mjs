// Run after npm run build. CHROME may point to an installed Chromium executable.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
const evidence=process.env.ROOTLANE_EVIDENCE ?? '/tmp/rootlane-preview-evidence';await mkdir(evidence,{recursive:true});
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
 let failProject=false,failLogs=false,failCatalog=false,failEnvironment=false,failPreview=false,disconnect=false,delayProject=0,delayCatalog=0,delayLogs=0,activeCatalog=0,peakCatalog=0;
 const previewId='12345678-1234-4234-8234-123456789abc';
 const projects=Array.from({length:12},(_,i)=>({id:'p'+i,name:i===0?'A very long project name with deliberate wrapping and real content':'Project '+i,path:'/code/'+('long-checkout-path/'.repeat(i===0?8:1))+i,gitCommonDir:null,branch:'feature/a-very-long-branch-name',detached:false,manifests:['package.json'],links:[],agents:[],environmentIds:i===0?['env']:[],logServices:i===0?[{environmentId:'env',serviceId:'web'}]:[],runtime:{services:[],status:i===0?'listeners observed':'no associated listener',ports:i===0?[3000]:[],ownership:'observe-only'}}));
 async function respond(event) {
  const {requestId,request}=event;const url=new URL(request.url);const path=url.pathname;
  let status=200,body,contentType='application/json';
  if(path.startsWith('/api/')) {
   const payload=request.postData?JSON.parse(request.postData):{};requests.push({path,payload,at:Date.now()});
   if(disconnect){await page('Fetch.failRequest',{requestId,errorReason:'ConnectionRefused'});return;}
   if(path==='/api/session')body={csrf:'test'};
   else if(path==='/api/status')body={connected:true,tailscale:{status:'connected',hostname:'neo.example.ts.net'},lifecycleAvailable:true};
   else if(path.endsWith('list_projects')){activeCatalog++;peakCatalog=Math.max(peakCatalog,activeCatalog);const failed=failCatalog;await pause(delayCatalog);activeCatalog--;status=failed?503:200;body=failed?{message:'Controlled catalog failure'}:{projects,nextCursor:null,warnings:[],observedAt:'2026-10-10T01:00:00Z'};}
   else if(path.endsWith('get_project')){const failed=failProject;await pause(delayProject);status=failed?503:200;body=failed?{message:'Controlled project failure'}:{project:projects.find(p=>p.id===payload.projectId),checkoutIds:[payload.projectId],services:[],approvedTargetIds:[],previews:payload.projectId==='p0'?[{previewId,checkoutId:'p0',serviceId:'web'}]:[],logServices:payload.projectId==='p0'?[{environmentId:'env',serviceId:'web'}]:[]};}
   else if(path.endsWith('get_environment')){status=failEnvironment?503:200;body=failEnvironment?{message:'Controlled environment failure'}:{id:'env',profileRevision:'test',effects:'test',dataRequirements:'None',startAllowed:true,ownership:'rootlane',desiredState:'running',application:'ready',preview:'available',links:[],services:[],observedAt:'time',latestOperation:null,observationError:null};}
   else if(path.endsWith('get_preview')){status=failPreview?503:200;body=failPreview?{message:'Controlled preview failure'}:{id:previewId,targetId:'web',projectPath:'/code',checkoutPath:projects[0].path,serviceId:'web',serviceName:'Web',port:3000,httpsPort:19484,ownership:'rootlane route only',approved:true,removed:false,url:'https://neo.example.ts.net:19484/',route:'matching',actualConfiguration:{},upstream:'ready',https:'verified',errors:[],observedAt:'time',latestOperation:null};}
   else if(path.endsWith('get_logs')){const failed=failLogs;await pause(delayLogs);status=failed?503:200;body=failed?{message:'Controlled logs failure'}:{lines:['bounded log output '.repeat(80)],nextCursor:null,truncated:true};}
   else throw Error('Unexpected API '+path);
   body=Buffer.from(JSON.stringify(body));
  } else if(path==='/favicon.ico') { body=Buffer.alloc(0);status=204;contentType='image/x-icon'; } else {
   const file=resolve('dist/web',path==='/'?'index.html':'.'+path);assert(file.startsWith(resolve('dist/web')+'/'));
   body=await readFile(file);contentType={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'}[extname(file)] ?? 'text/plain';
  }
  await page('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:contentType}],body:body.toString('base64')});
 }
 await page('Page.enable');await page('Runtime.enable');await page('Fetch.enable',{patterns:[{urlPattern:'https://rootlane.test/*'}]});
 const evaluate=async expression=>{const r=await page('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const wait=async expression=>{for(let i=0;i<120;i++){if(await evaluate(`!!(${expression})`))return;await pause(50);}throw Error('Wait failed: '+expression);};
 await page('Page.navigate',{url:'https://rootlane.test/'});await wait('document.querySelectorAll(".project").length===12');
 assert(!requests.some(r=>r.path.endsWith('get_environment')),'No eager environment fan-out');
 const captures=[];
 for(const width of [360,390,768,1280,1440]) {
  await page('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<500});
  await evaluate(`(()=>{const button=[...document.querySelectorAll('.project-actions > button')].at(-1);button.scrollIntoView({block:'end'});button.click();})()`);await pause(100);
  const bounds=await evaluate(`(()=>{const r=document.querySelector(':popover-open').getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  assert(bounds.top>=0 && bounds.bottom<=844 && bounds.left>=0 && bounds.right<=width,JSON.stringify({width,bounds}));assert.equal(bounds.overflow,false);
  await page('Page.captureScreenshot').then(({data})=>writeFile(`${evidence}/after-${width}.png`,Buffer.from(data,'base64')));
  await page('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await wait('!document.querySelector(":popover-open")');
  await wait(`document.activeElement===[...document.querySelectorAll('.project-actions > button')].at(-1)`);
  await evaluate(`[...document.querySelectorAll('.project-actions > button')].at(-1).click()`);
  await page('Input.dispatchMouseEvent',{type:'mousePressed',x:5,y:5,button:'left',clickCount:1});await page('Input.dispatchMouseEvent',{type:'mouseReleased',x:5,y:5,button:'left',clickCount:1});await wait('!document.querySelector(":popover-open")');
  captures.push({width,...bounds,escape:true,outside:true});
 }
 const select=async id=>{await evaluate(`document.getElementById('actions-${id}').click()`);await evaluate(`document.querySelector('#menu-${id} button').click()`);};
 await select('p0');await wait('document.querySelector(".environment")');
 await evaluate(`document.querySelector('.worktree > button').click()`);await wait('document.querySelector(".log-panel pre").textContent.includes("bounded")');
 await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await pause(300);assert(await evaluate('document.querySelector(".log-panel pre").textContent.includes("bounded")'));
 failLogs=true;await evaluate(`document.querySelector('.worktree > button').click()`);await wait('document.querySelector(".log-panel").textContent.includes("Controlled logs failure")');assert(await evaluate(`document.querySelector('.connection').textContent.includes('Connected')`));failLogs=false;
 failProject=true;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait('document.querySelector(".project-details").textContent.includes("Controlled project failure")');assert(await evaluate('document.querySelectorAll(".project").length===12'));failProject=false;
 failEnvironment=true;failPreview=true;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait('document.querySelector(".project-details").textContent.includes("Controlled preview failure")');await wait('document.querySelector(".project-details").textContent.includes("Controlled environment failure")');failEnvironment=false;failPreview=false;
 await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait('!document.querySelector(".project-details").textContent.includes("Controlled")');
 delayProject=500;await select('p1');await pause(80);await select('p2');await wait(`document.querySelector('.project-details').id==='details-p2' && !document.querySelector('.project-details').textContent.includes('Loading project')`);assert.equal(await evaluate('document.querySelectorAll(".project-details").length'),1);delayProject=0;
 delayCatalog=400;const before=requests.filter(r=>r.path.endsWith('list_projects')).length;
 await evaluate(`(()=>{const button=document.querySelector('[aria-label="Refresh projects"]');button.click();button.click();button.click();})()`);await pause(1100);assert.equal(requests.filter(r=>r.path.endsWith('list_projects')).length-before,2);assert.equal(peakCatalog,1);delayCatalog=0;
 failCatalog=true;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait(`document.querySelector('.error-banner')?.textContent.includes('Controlled catalog failure')`);assert(await evaluate(`document.querySelector('.connection').textContent.includes('Connected')`));failCatalog=false;
 disconnect=true;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait(`document.querySelector('.connection').textContent.includes('Disconnected')`);assert.equal(await evaluate('document.querySelectorAll(".project").length'),12);
 disconnect=false;await evaluate(`document.querySelector('[aria-label="Refresh projects"]').click()`);await wait(`document.querySelector('.connection').textContent.includes('Connected') && !document.querySelector('.error-banner')`);
 await select('p0');await wait('document.querySelector(".worktree > button")');delayLogs=400;await evaluate(`document.querySelector('.worktree > button').click()`);await select('p2');await pause(650);assert(!await evaluate('!!document.querySelector(".log-panel")'));delayLogs=0;
 // Touch activates the same native popover trigger.
 const coordinates=await evaluate(`(()=>{const b=document.getElementById('actions-p2');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.x+20,y:r.y+20}})()`);
 await page('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[coordinates]});await page('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await wait('!!document.querySelector(":popover-open")');
 await page('Page.navigate',{url:'about:blank'});await pause(100);
 assert.deepEqual(consoleErrors,[]);await writeFile(evidence+'/browser-results.json',JSON.stringify({captures,peakCatalog,requests,consoleErrors},null,2));
 console.log('PASS five viewport captures, native dismissal/focus/touch, long content, local failures, stale responses, coalesced refresh, disconnect/reconnect and unmount');
} finally {socket?.close();child.kill('SIGTERM');if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
