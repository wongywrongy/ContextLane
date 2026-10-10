import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { inside } from './config.js';
import { command } from './host/command.js';
import type { Rootlane } from './service.js';
import { Problem, proposalInput, locateInput, type Project } from './shared/contracts.js';
const readiness = {path:'/' as const,status:200 as const,bodyIncludes:'<CHANGE ME>' as const,timeoutMs:15000 as const};
const steps = ['Edit config.json on the Rootlane host: review the draft, replace <CHANGE ME>, and set approved to true only after review.', 'Run rootlane-reload on the host. Rootlane never writes configuration.'];
async function unusedPort(service: Rootlane, exclude: number[] = []) {
  const {config,host,store}=service.lifecycle; const [min,max]=config.previewPortRange;
  const listeners=await host.listeners(); const routes=await host.routes();
  const reserved=new Set([...exclude,config.port,...[config.origin,...(config.additionalOrigins??[])].map(u=>Number(new URL(u).port||443)),...config.profiles.flatMap(p=>[...p.services.map(s=>s.port),...p.previews.map(p=>p.httpsPort)]),...config.previewTargets.flatMap(t=>[t.port,t.httpsPort]),...listeners.map(l=>l.port)]);
  for(let port=min;port<=max;port++) if(!reserved.has(port) && !store.db.prepare('SELECT key FROM reservations WHERE key=?').get(`tcp:${port}`) && host.routeState(routes,{hostname:config.tailnetHostname,port,upstream:'http://127.0.0.1:1',label:'Proposal'})==='absent') return port;
  throw new Problem('NO_PREVIEW_PORT','No unused HTTPS port in previewPortRange');
}
export async function propose(service: Rootlane, kind: 'target'|'profile', raw: unknown) {
  const input=proposalInput.parse(raw); const projects=await service.catalog.projects();
  const checkout=projects.find(p=>p.id===input.checkoutId); if(!checkout) throw new Problem('NOT_FOUND','Checkout is not in the observed catalog');
  const primary=projects.find(p=>checkout.gitCommonDir && p.gitCommonDir===checkout.gitCommonDir && p.gitCommonDir===join(p.path,'.git')) ?? checkout;
  if(kind==='profile' && !checkout.devCommand) throw new Problem('COMMAND_UNKNOWN','No recognized literal development command; review a profile manually');
  const port=input.port ?? checkout.runtime.ports[0] ?? (kind==='profile' ? await unusedPort(service) : undefined);
  if(!port || kind==='target' && !checkout.runtime.ports.includes(port)) throw new Problem('LISTENER_REQUIRED','Select an observed listener in this checkout');
  const listeners=(await service.lifecycle.host.listeners()).filter(l=>l.port===port);
  if((kind==='target' && !listeners.length) || listeners.some(l=>!l.cwd || !inside(l.cwd,checkout.path)) || listeners.length > 0 && new Set(listeners.map(l=>l.pid)).size!==1) throw new Problem('TARGET_ASSOCIATION_UNKNOWN','Listener ownership cannot be attributed to this checkout');
  if(listeners.some(l=>!['127.0.0.1','::1'].includes(l.address))) throw new Problem('PUBLIC_BINDING','bind the dev server to 127.0.0.1 (e.g. --host 127.0.0.1)');
  const httpsPort=await unusedPort(service,[port]); const suffix=`${checkout.id.slice(0,8)}-${port}`;
  const existing=new Set([...service.lifecycle.config.profiles.map(p=>p.id),...service.lifecycle.config.previewTargets.map(t=>t.id)]);
  let id=`proposal-${suffix}`; for(let i=1;existing.has(id);i++) id=`proposal-${suffix}-${i}`;
  const name=checkout.runtime.listeners?.find(l=>l.port===port)?.process?.name ?? `Port ${port}`;
  if(kind==='target') return {draft:{id,approved:false as const,projectPath:primary.path,checkoutPath:checkout.path,serviceId:`service-${port}`,serviceName:name,port,httpsPort,readiness},steps};
  if(!checkout.devCommand) throw new Problem('COMMAND_UNKNOWN','No recognized literal development command; review a profile manually');
  const npm=(await command('which',['npm'],{timeout:1000,maxBuffer:4096})).trim();
  if(!npm.startsWith('/')) throw new Problem('COMMAND_UNKNOWN','npm executable unavailable');
  const executable=await realpath(npm);
  return {draft:{id,approved:false as const,projectPath:primary.path,effects:'Starts the reviewed development server and a private HTTPS route.',dataRequirements:'<CHANGE ME>',services:[{id:`service-${port}`,cwd:checkout.path,executable,args:['run','dev','--',...(checkout.devCommand==='next dev'?['--hostname','127.0.0.1']:['--host','127.0.0.1']),'--port',String(port)],port,dependencies:[],readiness}],previews:[{serviceId:`service-${port}`,httpsPort,label:name}]},steps};
}
export async function locate(service: Rootlane, raw:unknown) {
  const {path}=locateInput.parse(raw); const {config,store}=service.lifecycle;
  const actual=await realpath(path).catch(()=>null);
  if(!actual || !config.observationRoots.some(root=>inside(actual,root))) throw new Problem('NOT_FOUND','Path is outside observation roots or unavailable');
  const projects=await service.catalog.projects(); const checkout=[...projects].sort((a,b)=>b.path.length-a.path.length).find(p=>inside(actual,p.path));
  if(!checkout) throw new Problem('NOT_FOUND','No observed checkout contains this path');
  const primary=projects.find(p=>checkout.gitCommonDir && p.gitCommonDir===checkout.gitCommonDir && p.gitCommonDir===join(p.path,'.git')) ?? checkout;
  return {project:{id:primary.id,name:primary.name,path:primary.path},checkout:{id:checkout.id,path:checkout.path,branch:checkout.branch,...(checkout.detachedSha?{detachedSha:checkout.detachedSha}:{})},ports:checkout.runtime.ports.map(port=>({port,name:checkout.runtime.listeners?.find(l=>l.port===port)?.process?.name??'—'})),environments:checkout.environmentIds.map(id=>({id,status:store.environment(id) ? `desired ${store.environment(id)!.desired}` : '—'})),approvedTargetIds:config.previewTargets.filter(t=>t.checkoutPath===checkout.path).map(t=>t.id),previews:store.previews().filter(p=>!p.removed && JSON.parse(p.target).checkoutPath===checkout.path).map(p=>{const route=JSON.parse(p.route);return{id:p.id,url:`https://${route.hostname}:${route.port}/`};})};
}
