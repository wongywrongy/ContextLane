import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
const { findClaudePid, statuslineSnapshot, claimStatusline, ingestSettings } = await import(pathToFileURL(resolve('deploy/telemetry-hook.mjs')).href);

const run = (command: string, args: string[], input: Buffer | string, env: NodeJS.ProcessEnv = {}) => new Promise<{ code: number | null; stdout: Buffer; stderr: Buffer; durationMs: number }>((resolveRun, reject) => {
  const start = performance.now(), stdout: Buffer[] = [], stderr: Buffer[] = [];
  const child = spawn(resolve(command), args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.on('error', reject); child.stdout.on('data', value => stdout.push(value)); child.stderr.on('data', value => stderr.push(value));
  child.on('close', code => resolveRun({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), durationMs: performance.now() - start }));
  child.stdin.end(input);
});

test('session hook walks through a shell to Claude using the same agent detector, bounded to eight parents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rootlane-hook-proc-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (let pid = 10; pid <= 19; pid++) {
    const path = join(root, String(pid)); await mkdir(path);
    await writeFile(join(path, 'stat'), `${pid} (hook ) parent) S ${pid + 1} ${Array(17).fill('0').join(' ')} 123`);
    await symlink('/usr/bin/node', join(path, 'exe'));
    await writeFile(join(path, 'cmdline'), pid === 12 ? 'node\0/npm/@anthropic-ai/claude-code/cli.js\0' : 'node\0/script.js\0');
  }
  assert.equal(await findClaudePid(root, 10), 12);
  await writeFile(join(root, '12', 'cmdline'), 'node\0/script.js\0');
  await writeFile(join(root, '18', 'cmdline'), 'node\0/npm/@anthropic-ai/claude-code/cli.js\0');
  assert.equal(await findClaudePid(root, 10), null);
  assert.equal(await findClaudePid(root, 11), 18);
  assert.equal(await findClaudePid(root, 100), null);
});

test('session hook always exits zero and prints nothing when Rootlane is down or input is malformed', async t => {
  const home = await mkdtemp(join(tmpdir(), 'rootlane-hook-down-')); t.after(() => rm(home, { recursive: true, force: true }));
  for (const input of ['invalid', JSON.stringify({ session_id: 'session-down', cwd: '/known/project', source: 'startup', hook_event_name: 'SessionStart', transcript_path: 'DROP_CONTENT' })]) {
    const result = await run('deploy/rootlane-session-hook', [], input, { HOME: home, ROOTLANE_TELEMETRY_URL: 'http://127.0.0.1:1', ROOTLANE_INGEST_TOKEN: 'i'.repeat(40) });
    assert.equal(result.code, 0); assert.equal(result.stdout.length, 0); assert.equal(result.stderr.length, 0); assert(result.durationMs < 800);
  }
});

test('session hook reports the owning Claude PID through a shell and caps a stalled receiver at 300ms', async t => {
  const home = await mkdtemp(join(tmpdir(), 'rootlane-hook-owner-')); t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, '@anthropic-ai/claude-code'); await mkdir(directory, { recursive: true });
  await writeFile(join(home, 'package.json'), '{"type":"module"}');
  const script = join(directory, 'cli.js');
  await writeFile(script, `
    import { spawn } from 'node:child_process';
    process.stdout.write(String(process.pid));
    const child = spawn('/bin/sh', ['-c', 'exec "$ROOTLANE_TEST_NODE" "$ROOTLANE_TEST_HOOK"'], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.end(JSON.stringify({ session_id: 'hook-matched', cwd: ${JSON.stringify(home)}, source: 'startup', hook_event_name: 'SessionStart', transcript_path: 'DROP_CONTENT', prompt: 'DROP_CONTENT' }));
    child.on('exit', code => { process.exitCode = code; });
  `);
  const received: Record<string, unknown>[] = [];
  const server = createServer(async request => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk); received.push(JSON.parse(Buffer.concat(chunks).toString())); });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise<void>(resolveClose => server.close(() => resolveClose())));
  const result = await run(process.execPath, [script], '', { HOME: home, ROOTLANE_TELEMETRY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ROOTLANE_INGEST_TOKEN: 'i'.repeat(40), ROOTLANE_TEST_NODE: process.execPath, ROOTLANE_TEST_HOOK: resolve('deploy/rootlane-session-hook') });
  assert.equal(result.code, 0); assert.equal(result.stderr.length, 0); assert(result.durationMs >= 300 && result.durationMs < 800);
  assert.deepEqual(received, [{ agent: 'claude', sessionId: 'hook-matched', pid: Number(result.stdout), cwd: home, event: 'start', source: 'startup' }]);
});

test('statusline executable forwards bytes and exit status when the receiver is down', async t => {
  const home = await mkdtemp(join(tmpdir(), 'rootlane-statusline-down-')); t.after(() => rm(home, { recursive: true, force: true }));
  const input = Buffer.from('{"session_id":"byte-pass","prompt":"DROP_CONTENT"}\r\n');
  const tail = Buffer.from([0, 255, 13, 10]);
  const result = await run('deploy/rootlane-statusline', ['--', process.execPath, '-e', 'process.stdin.pipe(process.stdout);process.stdin.on("end",()=>{process.stdout.write(Buffer.from([0,255,13,10]));process.exitCode=7;})'], input, { HOME: home, ROOTLANE_TELEMETRY_URL: 'http://127.0.0.1:1', ROOTLANE_INGEST_TOKEN: 'i'.repeat(40) });
  assert.equal(result.code, 7); assert.deepEqual(result.stdout, Buffer.concat([input, tail])); assert.equal(result.stderr.length, 0); assert(result.durationMs < 1000);
  const noCommand = await run('deploy/rootlane-statusline', [], input, { HOME: home });
  assert.equal(noCommand.code, 0); assert.equal(noCommand.stdout.length, 0); assert.equal(noCommand.stderr.length, 0);
});

test('statusline executable keeps foreground overhead under 20ms against the original command', async t => {
  const home = await mkdtemp(join(tmpdir(), 'rootlane-statusline-timing-')); t.after(() => rm(home, { recursive: true, force: true }));
  const input = '{"session_id":"timed"}';
  const env = { HOME: home, ROOTLANE_TELEMETRY_URL: 'http://127.0.0.1:1', ROOTLANE_INGEST_TOKEN: 'i'.repeat(40) };
  assert.equal(claimStatusline('timed', join(home, '.cache/rootlane/statusline')), true);
  const original: number[] = [], wrapped: number[] = [];
  for (let i = 0; i < 12; i++) {
    const baseline = await run('/bin/cat', [], input, env);
    const result = await run('deploy/rootlane-statusline', ['--', '/bin/cat'], input, env);
    assert.equal(result.code, 0); assert.equal(result.stderr.length, 0); assert.equal(result.stdout.toString(), input);
    original.push(baseline.durationMs); wrapped.push(result.durationMs);
    // Normal status-line calls are spaced apart; let each background reporter finish.
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const originalMs = median(original), wrappedMs = median(wrapped), addedMs = wrappedMs - originalMs;
  t.diagnostic(`Full executable median: original ${originalMs.toFixed(2)}ms, wrapped ${wrappedMs.toFixed(2)}ms, added ${addedMs.toFixed(2)}ms`);
  assert(addedMs < 20, `Statusline added ${addedMs.toFixed(2)}ms`);
});

test('statusline streams input over 1MiB unchanged and discards its telemetry', async t => {
  const home = await mkdtemp(join(tmpdir(), 'rootlane-statusline-large-')); t.after(() => rm(home, { recursive: true, force: true }));
  let received = 0;
  const server = createServer((request, response) => { received++; request.resume(); response.end('{}'); });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise<void>(resolveClose => server.close(() => resolveClose())));
  const input = Buffer.from(JSON.stringify({ session_id: 'oversized', prompt: 'DROP_CONTENT'.repeat(110000) }));
  assert(input.length > 1024 * 1024);
  const result = await run('deploy/rootlane-statusline', ['--', '/bin/cat'], input, { HOME: home, ROOTLANE_TELEMETRY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ROOTLANE_INGEST_TOKEN: 'i'.repeat(40) });
  assert.equal(result.code, 0); assert.equal(result.stderr.length, 0); assert.deepEqual(result.stdout, input);
  // A reporter that cannot start must not break tee's other output stream.
  const bin = join(home, 'bin'); await mkdir(bin);
  await symlink('/usr/bin/tee', join(bin, 'tee')); await symlink('/usr/bin/readlink', join(bin, 'readlink'));
  const noReporter = await run('deploy/rootlane-statusline', ['--', '/bin/cat'], input, { HOME: home, PATH: bin });
  assert.equal(noReporter.code, 0); assert.equal(noReporter.stderr.length, 0); assert.deepEqual(noReporter.stdout, input);
  await new Promise(resolveWait => setTimeout(resolveWait, 150));
  assert.equal(received, 0);
});

test('statusline sends only allowlisted fields, detaches slow HTTP, and throttles each session for five seconds', async t => {
  const home = await mkdtemp(join(tmpdir(), 'rootlane-statusline-send-')); t.after(() => rm(home, { recursive: true, force: true }));
  const received: { body: Record<string, unknown>; authorization: string | undefined }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    received.push({ body: JSON.parse(Buffer.concat(chunks).toString()), authorization: request.headers.authorization });
    setTimeout(() => response.end('{}'), 500).unref();
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise<void>(resolveClose => server.close(() => resolveClose())));
  const env = { HOME: home, ROOTLANE_TELEMETRY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ROOTLANE_INGEST_TOKEN: 'i'.repeat(40) };
  const input = { session_id: 'safe-snapshot', model: { id: 'claude-opus', display_name: 'Opus', secret: 'DROP_CONTENT' }, context_window: { used_percentage: 71, context_window_size: 200000, current_usage: { input_tokens: 1000, output_tokens: 120, cache_read_input_tokens: 900, cache_creation_input_tokens: 200, prompt: 'DROP_CONTENT' }, transcript: 'DROP_CONTENT' }, rate_limits: { five_hour: { used_percentage: 15, resets_at: 1900000000, email: 'DROP_CONTENT' }, seven_day: { used_percentage: 40, resets_at: 1900000001 }, spend_limit: { used_usd: 12 } }, cost: { total_cost_usd: 1.23, prompt: 'DROP_CONTENT' }, exceeds_200k_tokens: false, cwd: 'DROP_CONTENT', transcript_path: 'DROP_CONTENT', prompt: 'DROP_CONTENT' };
  const result = await run('deploy/rootlane-statusline', [], JSON.stringify(input), env);
  assert.equal(result.code, 0); assert.equal(result.stdout.length, 0); assert.equal(result.stderr.length, 0); assert(result.durationMs < 400);
  await run('deploy/rootlane-statusline', [], JSON.stringify(input), env);
  for (let i = 0; i < 20 && !received.length; i++) await new Promise(resolveWait => setTimeout(resolveWait, 25));
  assert.equal(received.length, 1); assert.equal(received[0].authorization, `Bearer ${env.ROOTLANE_INGEST_TOKEN}`);
  assert.deepEqual(received[0].body, statuslineSnapshot(input)); assert(!JSON.stringify(received).includes('DROP_CONTENT'));
  assert.equal((received[0].body.current_usage as { input_tokens: number }).input_tokens, 1000);
  const directory = join(home, '.cache/rootlane/statusline');
  const { createHash } = await import('node:crypto');
  const path = join(directory, createHash('sha256').update('safe-snapshot').digest('hex'));
  const old = new Date(Date.now() - 6000); await utimes(path, old, old);
  assert.equal(claimStatusline('safe-snapshot', directory), true);
});

test('hook configuration rejects non-loopback destinations before credentials can leave the host', () => {
  assert.throws(() => ingestSettings({ ROOTLANE_TELEMETRY_URL: 'http://example.com:9480', ROOTLANE_INGEST_TOKEN: 'i'.repeat(40) }), /loopback/);
  assert.throws(() => ingestSettings({ ROOTLANE_TELEMETRY_URL: 'https://127.0.0.1:9480', ROOTLANE_INGEST_TOKEN: 'i'.repeat(40) }), /loopback/);
  assert.equal(ingestSettings({ ROOTLANE_TELEMETRY_URL: 'http://127.0.0.1:19480', ROOTLANE_INGEST_TOKEN: 'i'.repeat(40) }).endpoint.port, '19480');
});
