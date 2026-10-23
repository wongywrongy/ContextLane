import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,writeFile,readFile,symlink } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { viteLauncher } from '../src/configuration.js';
import { setup } from './helpers.js';

test('reviewed Vite launcher loads config, enforces loopback/strict host policy and delivers HMR updates',async t=>{
 const {root}=await setup(t),app=join(root,'vite-app'),launcher=join(root,'vite-launcher.mjs');await mkdir(app);
 await symlink(resolve('node_modules'),join(app,'node_modules'));await writeFile(join(app,'package.json'),'{"type":"module"}');
 await writeFile(join(app,'vite.config.mjs'),`export default {cacheDir:'.vite-cache',define:{__VALUE__:JSON.stringify('loaded-config')},server:{host:'0.0.0.0',port:9999,strictPort:false,allowedHosts:true,hmr:{host:'wrong.example',clientPort:9998}}};`);
 await writeFile(join(app,'index.html'),'<!doctype html><html><body>Vite fixture<script type="module" src="/main.js"></script></body></html>');await writeFile(join(app,'main.js'),'console.log(__VALUE__);');await writeFile(launcher,viteLauncher);
 const reservation=createServer();await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=(reservation.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()));
 const child=spawn(process.execPath,[launcher],{cwd:app,env:{...process.env,ROOTLANE_PORT:String(port),ROOTLANE_PREVIEW_ORIGIN:'https://unit.example.ts.net:19484'},stdio:['ignore','ignore','pipe']});let diagnostics='';child.stderr.on('data',chunk=>diagnostics=(diagnostics+chunk).slice(-4096));
 const base=`http://127.0.0.1:${port}`;
 try {
  let ready=false;for(let attempt=0;attempt<100;attempt++) {
   if(child.exitCode!==null)throw new Error(diagnostics);
   try {const response=await fetch(base,{signal:AbortSignal.timeout(500)});if(response.ok){await response.body?.cancel();ready=true;break;}}catch{/* Wait for the disposable server. */}
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert(ready,diagnostics);
  const status=(host:string)=>new Promise<number|undefined>((resolve,reject)=>{const call=request(base,{headers:{host}},response=>{response.resume();resolve(response.statusCode);});call.on('error',reject);call.end();});
  assert.equal(await status('unit.example.ts.net'),200);assert.equal(await status('unreviewed.example'),403);
  const sockets=await readFile('/proc/net/tcp','utf8'),hex=port.toString(16).toUpperCase().padStart(4,'0');assert(sockets.includes('0100007F:'+hex));assert(!sockets.includes('00000000:'+hex));
  await fetch(base+'/main.js').then(response=>response.text());
  const environment=await(await fetch(base+'/@vite/env')).text();assert(environment.includes('loaded-config'),environment.slice(0,2000));
  const client=await(await fetch(base+'/@vite/client')).text();assert(client.includes('unit.example.ts.net'));assert(client.includes('19484'));assert(client.includes('wss'));assert(!client.includes('wrong.example'));const token=client.match(/const wsToken\s*=\s*"([^"]+)"/)?.[1];assert(token);
  await new Promise<void>((resolve,reject)=>{
   const socket=new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`,'vite-hmr');const timer=setTimeout(()=>{socket.close();reject(new Error('HMR update timeout'));},8000);
   socket.onmessage=event=>{const message=JSON.parse(String(event.data));if(message.type==='connected')void writeFile(join(app,'main.js'),'console.log(__VALUE__, "changed-module");').catch(reject);if(['update','full-reload'].includes(message.type)){clearTimeout(timer);socket.close();resolve();}};socket.onerror=()=>{clearTimeout(timer);socket.close();reject(new Error('HMR socket failed'));};
  });
  assert((await(await fetch(base+'/main.js')).text()).includes('changed-module'));
 } finally {child.kill('SIGTERM');if(child.exitCode===null && child.signalCode===null)await new Promise(resolve=>child.once('exit',resolve));}
});
