import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readlink, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { preflightPorts } from '../src/host/preflight-ports.js';
import type { Config } from '../src/config.js';
const run = promisify(execFile);
test('installed preflight exempts operator ports and still checks application ports', () => {
  const config = { port: 9480, origin: 'https://host.example:19483', profiles: [{ services: [{ port: 3100 }], previews: [{ httpsPort: 18443 }] }] } as Pick<Config, 'port' | 'origin' | 'profiles'>;
  assert.deepEqual(preflightPorts(config, false), [9480, 19483, 3100, 18443]);
  assert.deepEqual(preflightPorts(config, true), [3100, 18443]);
  assert.deepEqual(preflightPorts({ ...config, origin: 'https://host.example', profiles: [] }, false), [9480, 443]);
});
test('release setup creates private owner files, preserves credentials and rejects a changed root', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rootlane-release-'));
  try {
    for (const dir of ['deploy', 'bin', 'projects', 'other']) await mkdir(join(temp, dir));
    for (const name of ['setup.mjs', 'rootlane-session-hook', 'rootlane-statusline', 'rootlane-statusline.mjs', 'telemetry-hook.mjs']) await copyFile(join('deploy', name), join(temp, 'deploy', name));
    await writeFile(join(temp, 'bin/tailscale'), '#!/bin/sh\nprintf \'%s\\n\' \'{"BackendState":"Running","Self":{"DNSName":"workstation.example.ts.net."}}\'\n', { mode: 0o700 });
    const env = { ...process.env, HOME: temp, PATH: `${temp}/bin:${process.env.PATH}` };
    await run(process.execPath, [join(temp, 'deploy/setup.mjs'), join(temp, 'projects')], { env });
    const directory = join(temp, '.config/rootlane');
    const credential = await readFile(join(directory, 'owner.credential'), 'utf8');
    assert(credential.trim().length >= 32);
    assert.notEqual(credential, await readFile(join(directory, 'agent.credential'), 'utf8'));
    const ingest = await readFile(join(directory, 'ingest.credential'), 'utf8');
    assert(ingest.trim().length >= 32); assert.notEqual(credential, ingest); assert.notEqual(ingest, await readFile(join(directory, 'agent.credential'), 'utf8'));
    for (const file of ['config.json', 'owner.credential', 'agent.credential', 'ingest.credential', 'ingest.env']) assert.equal((await stat(join(directory, file))).mode & 0o077, 0);
    const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
    assert.deepEqual(config.profiles, []);
    assert.equal(config.origin, 'https://workstation.example.ts.net:19483');
    assert.deepEqual(config.telemetry, { enabled: false, port: 9481, retentionDays: 7 });
    assert.equal(await readFile(join(directory, 'ingest.env'), 'utf8'), `ROOTLANE_TELEMETRY_URL=http://127.0.0.1:9481\nROOTLANE_INGEST_TOKEN=${ingest.trim()}\n`);
    for (const name of ['rootlane-session-hook', 'rootlane-statusline']) assert.equal(await readlink(join(temp, '.local/bin', name)), join(temp, 'deploy', name));
    const wrappedRun = run(join(temp, '.local/bin/rootlane-statusline'), ['--', '/bin/echo', 'unchanged'], { env });
    wrappedRun.child.stdin!.end();
    const wrapped = await wrappedRun;
    assert.equal(wrapped.stdout, 'unchanged\n'); assert.equal(wrapped.stderr, '');
    await run(process.execPath, [join(temp, 'deploy/setup.mjs'), join(temp, 'projects')], { env });
    assert.equal(await readFile(join(directory, 'owner.credential'), 'utf8'), credential);
    assert.equal(await readFile(join(directory, 'ingest.credential'), 'utf8'), ingest);
    await assert.rejects(run(process.execPath, [join(temp, 'deploy/setup.mjs'), join(temp, 'other')], { env }), /different state\/roots/);
    const executable = join(temp, 'bin/node'); await writeFile(executable, '', {mode:0o700});
    config.toolchains={node:executable,python:executable,venvs:{fixture:join(temp,'venv')}};await mkdir(join(temp,'venv'));config.observationRoots.push(join(temp, 'other')); config.profiles = [{ services: [{executable}] }];
    config.telemetry.port = 9481;
    await writeFile(join(directory, 'config.json'), JSON.stringify(config));
    await run(process.execPath, [join(temp, 'deploy/setup.mjs'), join(temp, 'projects')], { env });
    assert((await readFile(join(directory, 'ingest.env'), 'utf8')).startsWith('ROOTLANE_TELEMETRY_URL=http://127.0.0.1:9481\n'));
    const override = JSON.parse(await readFile(join(temp, 'compose.override.yaml'), 'utf8'));
    assert.deepEqual(override.services.rootlane.volumes.map((v: {source:string;read_only:boolean}) => [v.source,v.read_only]), [[temp,true],[join(temp,'other'),true],[join(temp,'venv'),true],[join(temp,'bin'),true]]);
    config.observationRoots.push('/etc'); await writeFile(join(directory,'config.json'),JSON.stringify(config));
    await assert.rejects(run(process.execPath,[join(temp,'deploy/setup.mjs'),join(temp,'projects')],{env}), /Refusing sensitive bind/);

    assert.deepEqual(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')), config);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('disposable Vite configuration uses the reviewed host rather than a built-in hostname', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rootlane-vite-'));
  try {
    const config = join(temp, 'config.json');
    await writeFile(config, JSON.stringify({ tailnetHostname: 'laptop.different.ts.net' }));
    const result = await run(process.execPath, ['--input-type=module', '-e', "const {default:c}=await import('./fixtures/disposable/vite.config.mjs'); console.log(JSON.stringify(c.server));"], { env: { ...process.env, ROOTLANE_CONFIG: config } });
    const server = JSON.parse(result.stdout);
    assert.deepEqual(server.allowedHosts, ['laptop.different.ts.net']);
    assert.equal(server.hmr.host, 'laptop.different.ts.net'); assert.equal(server.strictPort, true); assert.equal(server.host, '127.0.0.1');
    await writeFile(config, JSON.stringify({ tailnetHostname: '*' }));
    await assert.rejects(run(process.execPath, ['--input-type=module', '-e', "await import('./fixtures/disposable/vite.config.mjs')"], { env: { ...process.env, ROOTLANE_CONFIG: config } }), /owner-configured/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('host acceptance refuses to touch the host without its explicit opt-in gate',async()=>{
  await assert.rejects(run(process.execPath,['tests/host-acceptance.mjs'],{env:{...process.env,ROOTLANE_HOST_ACCEPTANCE:'0'}}),/Host acceptance is opt-in/);
});
