import test from 'node:test';
import assert from 'node:assert/strict';
import { routeState, boundedText } from '../src/host/linux.js';
import { orderedServices } from '../src/config.js';
import { setup } from './helpers.js';
import { instanceLock } from '../src/host/lock.js';
import { join } from 'node:path';
const route = { hostname: 'neo.example.ts.net', port: 19484, upstream: 'http://127.0.0.1:19482', label: 'Preview' };
test('route matching refuses additional handlers, TCP forwarding, other hosts and Funnel', () => {
  const config = { TCP: { '19484': { HTTPS: true } }, Web: { 'neo.example.ts.net:19484': { Handlers: { '/': { Proxy: route.upstream } } } } };
  assert.equal(routeState({}, route), 'absent'); assert.equal(routeState(config, route), 'matching');
  assert.equal(routeState({ ...config, AllowFunnel: { 'neo.example.ts.net:19484': true } }, route), 'conflict');
  assert.equal(routeState({ ...config, TCP: { '19484': { TCPForward: 'localhost:9999' } } }, route), 'conflict');
  assert.equal(routeState({ ...config, Web: { 'neo.example.ts.net:19484': { Handlers: { '/': { Proxy: route.upstream }, '/other': { Proxy: 'other' } } } } }, route), 'conflict');
});
test('response bounds terminate oversized readiness or adapter output', async () => {
  await assert.rejects(() => boundedText(new Response('x'.repeat(500)), 100), /allowed size/);
  assert.equal(await boundedText(new Response('ok'), 100), 'ok');
});
test('dependency ordering rejects cycles and missing services', async t => {
  const { config } = await setup(t); const profile = config.profiles[0]; assert.deepEqual(orderedServices(profile).map(s => s.id), ['api', 'web']);
  profile.services[0].dependencies = ['web']; assert.throws(() => orderedServices(profile), /dependency/);
});
test('a lifetime file lock excludes a second backend and releases on close', async t => {
  const { root } = await setup(t); const path = join(root, 'lock'); const unlock = await instanceLock(path);
  try { await assert.rejects(() => instanceLock(path), /Another Rootlane/); } finally { unlock(); }
  const second = await instanceLock(path); second();
});

test('direct systemd argv uses setenv without a shell and journal redaction precedes truncation',async t=>{
 const {root,config,store}=await setup(t);const {mkdir,writeFile}=await import('node:fs/promises');const bin=join(root,'bin');await mkdir(bin);const previous=process.env.PATH;process.env.PATH=`${bin}:${previous}`;t.after(()=>{process.env.PATH=previous;});
 const secret='private-secret-'.repeat(200);const {LinuxHost}=await import('../src/host/linux.js');const host=new LinuxHost();const captured=join(root,'argv.json');
 await writeFile(join(bin,'systemd-run'),`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(captured)},JSON.stringify(process.argv.slice(2)))`,{mode:0o700});
 const service={...config.profiles[0].services[0],executable:process.execPath,env:{API_TOKEN:secret,LITERAL:'literal $HOME ; value'}};const unit={name:'fixture.service',marker:'rootlane:fixture',serviceId:'api',port:19481,readiness:service.readiness,invocation:'a'.repeat(32)};
 await host.startUnit(unit,service);const {readFile}=await import('node:fs/promises');const args=JSON.parse(await readFile(captured,'utf8')) as string[];assert(args.includes(`--setenv=API_TOKEN=${secret}`));assert(args.includes('--setenv=LITERAL=literal $HOME ; value'));assert(args.includes('--expand-environment=no'));assert.equal(args[args.indexOf('--')+1],service.executable);assert(!args.includes('/usr/bin/env'));
 await writeFile(join(bin,'journalctl'),`#!${process.execPath}\nconsole.log(JSON.stringify({MESSAGE:${JSON.stringify('x'.repeat(2020)+secret)},__CURSOR:'cursor'}))`,{mode:0o700});store.saveRedactions('fixture',[secret]);const page=await host.logs(unit,undefined,10,store.redactor('fixture'));assert(page.lines[0].endsWith('[redacted]'));assert(!page.lines[0].includes('private-secret'));assert(page.truncated);assert(!store.meta('redactions:fixture')!.includes(secret));
});
