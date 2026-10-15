import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentName, observeAgents } from '../src/host/agents.js';

test('recognizes native agents including versioned Claude and deleted binaries, excluding helpers', () => {
  assert.equal(agentName('/opt/codex'), 'Codex');
  assert.equal(agentName('/opt/codex (deleted)'), 'Codex');
  assert.equal(agentName('/home/owner/.local/share/claude/versions/2.1.296'), 'Claude Code');
  assert.equal(agentName('/opt/claude'), 'Claude Code');
  for (const path of ['/usr/bin/node', '/home/owner/.claude/jobs/esbuild', '/opt/codex-code-mode-host', '/tmp/2.1.296', '/home/owner/.local/share/claude/versions/readme']) assert.equal(agentName(path), null);
});

test('bounded metadata observations skip exits and malformed identities without reading prompts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rootlane-proc-')); t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = async (pid: number, executable: string, start = '123') => {
    const path = join(root, String(pid)); await mkdir(path);
    // Linux stat fields 3–22; comm may contain spaces and closing parentheses.
    await writeFile(join(path, 'stat'), `${pid} (agent ) name) S ${Array(18).fill('0').join(' ')} ${start}`);
    await symlink(executable, join(path, 'exe')); await symlink('/approved/app/web', join(path, 'cwd'));
    return path;
  };
  await fixture(1, '/opt/codex'); await fixture(2, '/home/owner/.local/share/claude/versions/2.1.296');
  await fixture(3, '/opt/codex-code-mode-host'); await fixture(4, '/opt/codex', 'invalid');
  const exited = await fixture(5, '/opt/codex'); await rm(join(exited, 'cwd'));
  const first = await observeAgents(root);
  assert.deepEqual(first.agents.map(a => a.name).sort(), ['Claude Code', 'Codex']);
  assert(first.agents.every(a => /^[a-f0-9]{24}$/.test(a.id)));
  assert.equal(first.agents.find(a => a.name === 'Codex')!.pid, 1);
  assert.equal(first.agents.find(a => a.name === 'Codex')!.cwd, '/approved/app/web');
  assert.deepEqual((await observeAgents(root, process.getuid!() + 1)).agents, []);
  const oldId = first.agents.find(a => a.name === 'Codex')!.id;
  await writeFile(join(root, '1', 'stat'), `1 (codex) S ${Array(18).fill('0').join(' ')} 456`);
  assert.notEqual((await observeAgents(root)).agents.find(a => a.name === 'Codex')!.id, oldId);
  const denied = await fixture(6, '/opt/codex'); await writeFile(join(denied, 'stat'), '', { mode: 0o000 });
  await (await import('node:fs/promises')).chmod(join(denied, 'stat'), 0o000);
  if (process.getuid!() !== 0) assert((await observeAgents(root)).warnings.some(w => w.includes('inaccessible')));
  for (let pid = 10; pid < 140; pid++) await fixture(pid, '/opt/codex');
  const bounded = await observeAgents(root); assert.equal(bounded.agents.length, 128); assert(bounded.warnings.some(w => w.includes('limited')));
  await assert.rejects(observeAgents(join(root, 'missing')));
});

test('time and process-entry budgets report incomplete scans', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rootlane-proc-budget-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '1'));
  let calls = 0; const clock = t.mock.method(Date, 'now', () => calls++ ? 2000 : 0);
  assert((await observeAgents(root)).warnings.some(w => w.includes('limited'))); clock.mock.restore();
  for (let start = 2; start <= 8193; start += 64) await Promise.all(Array.from({ length: Math.min(64, 8194 - start) }, (_, i) => mkdir(join(root, String(start + i)))));
  t.mock.method(Date, 'now', () => 0);
  const result = await observeAgents(root); assert.equal(result.agents.length, 0); assert(result.warnings.some(w => w.includes('limited')));
});

test('npm agents are attributed once through wrappers with observed process start time', async t => {
  const root = await mkdtemp(join(tmpdir(),'rootlane-npm-proc-')); t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'stat'),'btime 1700000000\n');
  for (const [pid,ppid,exe,entry] of [[10,0,'node','/npm/@openai/codex/bin/codex.js'],[11,10,'codex',''],[12,0,'bun','/npm/@anthropic-ai/claude-code/cli.js']] as const) {
    const path = join(root,String(pid)); await mkdir(path);
    await writeFile(join(path,'stat'),`${pid} (agent) S ${ppid} ${Array(17).fill('0').join(' ')} 100`);
    await symlink('/usr/bin/'+exe,join(path,'exe')); await symlink('/approved/app',join(path,'cwd'));
    await writeFile(join(path,'cmdline'),[exe,entry,'--secret=SHOULD_NOT_ESCAPE'].join('\0'));
  }
  const result = await observeAgents(root); assert.equal(result.agents.length,2);
  assert.equal(result.agents.find(a=>a.name==='Codex')?.pid,10); assert.match(result.agents[0].startedAt!,/^2023-/);
  assert(!JSON.stringify(result).includes('SHOULD_NOT_ESCAPE'));
});

test('host-side hooks can load process helpers without node_modules', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['agents.ts', 'process.ts']) assert.doesNotMatch(await readFile(join(import.meta.dirname, '../src/host', file), 'utf8'), /^import (?!type ).*from '(?!node:|\.\/(process|types)\.js')/m);
});
