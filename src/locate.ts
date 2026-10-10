import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { inside } from './config.js';
import type { Rootlane } from './service.js';
import { Problem, locateInput } from './shared/contracts.js';
export async function locate(service: Rootlane, raw:unknown) {
  const {path}=locateInput.parse(raw); const {config,store}=service.lifecycle;
  const actual=await realpath(path).catch(()=>null);
  if(!actual || !config.observationRoots.some(root=>inside(actual,root))) throw new Problem('NOT_FOUND','Path is outside observation roots or unavailable');
  const projects=await service.catalog.projects(); const checkout=[...projects].sort((a,b)=>b.path.length-a.path.length).find(p=>inside(actual,p.path));
  if(!checkout) throw new Problem('NOT_FOUND','No observed checkout contains this path');
  const primary=projects.find(p=>checkout.gitCommonDir && p.gitCommonDir===checkout.gitCommonDir && p.gitCommonDir===join(p.path,'.git')) ?? checkout;
  const recipe=await service.recipes.inspect(checkout.path,checkout.gitCommonDir??undefined);const instances=service.recipes.instances(checkout.path).map(i=>{const a=JSON.parse(i.allocations);return{id:i.id,checkoutPath:i.checkoutPath,status:store.environment(i.id)?.desired??'stopped',ports:a.ports,previews:Object.entries(a.previews).map(([serviceId,port])=>({serviceId,port:port as number,url:`https://${config.tailnetHostname}:${port}/`}))};});
  return {recipe,instances,project:{id:primary.id,name:primary.name,path:primary.path},checkout:{id:checkout.id,path:checkout.path,branch:checkout.branch,...(checkout.detachedSha?{detachedSha:checkout.detachedSha}:{})},ports:checkout.runtime.ports.map(port=>({port,name:checkout.runtime.listeners?.find(l=>l.port===port)?.process?.name??'—'})),environments:checkout.environmentIds.map(id=>({id,status:store.environment(id) ? `desired ${store.environment(id)!.desired}` : '—'})),approvedTargetIds:config.previewTargets.filter(t=>t.checkoutPath===checkout.path).map(t=>t.id),previews:[...store.previews().filter(p=>!p.removed && JSON.parse(p.target).checkoutPath===checkout.path).map(p=>{const route=JSON.parse(p.route);return{id:p.id,url:`https://${route.hostname}:${route.port}/`};}),...checkout.environmentIds.flatMap(id=>store.resources(id).filter(r=>r.kind==='route').map(r=>{const route=JSON.parse(r.data);return{id:r.id,url:`https://${route.hostname}:${route.port}/`};}))]};
}
