import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const run = promisify(execFile);
test('release setup creates private owner files, preserves credentials and rejects a changed root', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rootlane-release-'));
  try {
    for (const dir of ['deploy', 'bin', 'projects', 'other']) await mkdir(join(temp, dir));
    await copyFile('deploy/setup.mjs', join(temp, 'deploy/setup.mjs'));
    await writeFile(join(temp, 'bin/tailscale'), '#!/bin/sh\nprintf \'%s\\n\' \'{"BackendState":"Running","Self":{"DNSName":"neo.test.ts.net."}}\'\n', { mode: 0o700 });
    const env = { ...process.env, HOME: temp, PATH: `${temp}/bin:${process.env.PATH}` };
    await run(process.execPath, [join(temp, 'deploy/setup.mjs'), join(temp, 'projects')], { env });
    const directory = join(temp, '.config/rootlane');
    const credential = await readFile(join(directory, 'owner.credential'), 'utf8');
    assert(credential.trim().length >= 32);
    assert.notEqual(credential, await readFile(join(directory, 'agent.credential'), 'utf8'));
    for (const file of ['config.json', 'owner.credential', 'agent.credential']) assert.equal((await stat(join(directory, file))).mode & 0o077, 0);
    const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
    assert.deepEqual(config.profiles, []);
    assert.equal(config.origin, 'https://neo.test.ts.net:19483');
    await run(process.execPath, [join(temp, 'deploy/setup.mjs'), join(temp, 'projects')], { env });
    assert.equal(await readFile(join(directory, 'owner.credential'), 'utf8'), credential);
    await assert.rejects(run(process.execPath, [join(temp, 'deploy/setup.mjs'), join(temp, 'other')], { env }), /different state\/roots/);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')), config);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
