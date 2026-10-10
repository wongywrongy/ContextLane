import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { ServeRoutes, routeState } from '../src/host/routes.js';
import { setup } from './helpers.js';
const route = { hostname: 'neo.example.ts.net', port: 19485, upstream: 'http://127.0.0.1:19482', label: 'Preview' };

test('guarded Unix-socket changes preserve unrelated config, reject concurrent writes and fail closed without ETag', async t => {
  const { root } = await setup(t); let config: Record<string, unknown> = { TCP: { '8443': { HTTPS: true } }, Web: { 'else.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8000' } } } }, AllowFunnel: { 'else.example.ts.net:8443': false } };
  const original=structuredClone(config); let version=1; let race=false; let etag=true; let writes=0;
  const server=createServer((req,res)=>{
    if(req.method==='GET'){ if(etag)res.setHeader('ETag',`"${version}"`);res.end(JSON.stringify(config));return; }
    writes++; if(race)version++;
    if(req.headers['if-match']!==`"${version}"`){res.statusCode=412;res.end();return;}
    let body='';req.on('data',data=>body+=data);req.on('end',()=>{config=JSON.parse(body);version++;res.end();});
  });
  const socket=join(root,'tailscale.sock'); await new Promise<void>(resolve=>server.listen(socket,resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const routes=new ServeRoutes(socket); await routes.change(route,false); assert.equal(routeState(await routes.read(),route),'matching');
  await routes.change(route,true);assert.deepEqual(config,original);
  race=true;await assert.rejects(routes.change(route,false),/concurrently/);assert.deepEqual(config,original);
  race=false;etag=false;const previous=writes;await assert.rejects(routes.change(route,false),/ETag/);assert.equal(writes,previous);
});

test('foreground and noncanonical routes are conflicts', () => {
  const matching={TCP:{'19485':{HTTPS:true}},Web:{'neo.example.ts.net:19485':{Handlers:{'/':{Proxy:route.upstream}}}}};
  assert.equal(routeState({Foreground:{session:matching}},route),'conflict');
  assert.equal(routeState({...matching,Foreground:{session:matching}},route),'conflict');
  assert.equal(routeState({AllowFunnel:{'else.example.ts.net:19485':true}},route),'conflict');
});
