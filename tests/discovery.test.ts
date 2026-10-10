import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Catalog } from '../src/catalog/discovery.js';
import { command } from '../src/host/command.js';
import { setup } from './helpers.js';

test('real bounded discovery groups Git worktrees, includes non-Git projects and excludes unapproved paths', async t => {
  const { root, config, host } = await setup(t); config.profiles = [];
  const projects = join(root, 'projects'); const external = join(root, 'allowed-worktrees'); const forbidden = join(root, 'outside');
  await Promise.all([mkdir(projects), mkdir(external), mkdir(forbidden)]);
  config.projectRoots = [projects]; config.observationRoots = [projects, external];
  const repo = join(projects, 'repository'); const plain = join(projects, 'plain'); await Promise.all([mkdir(repo), mkdir(plain)]);
  await writeFile(join(plain, 'package.json'), '{"scripts":{"start":"MUST NOT EXECUTE"}}'); await mkdir(join(plain, 'nested')); await mkdir(join(plain, 'nested', 'not-a-project'));
  await command('git', ['init', repo]); await command('git', ['-C', repo, '-c', 'user.name=Rootlane test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  const detached = join(external, 'detached'); await command('git', ['-C', repo, 'worktree', 'add', '--detach', detached]);
  await command('git', ['-C', repo, 'worktree', 'add', '--detach', join(forbidden, 'hidden')]); await symlink(forbidden, join(projects, 'escaped'));
  host.agentObservations.agents = [{ id: 'a'.repeat(24), name: 'Codex', cwd: detached }];
  const catalog = new Catalog(config, host); const result = await catalog.list({ limit: 50 });
  assert(result.projects.some(p => p.path === plain && p.manifests.includes('package.json')));
  const main = result.projects.find(p => p.path === repo)!; const worktree = result.projects.find(p => p.path === detached)!;
  assert.equal(main.gitCommonDir, worktree.gitCommonDir); assert.equal(worktree.detached, true); assert.equal(worktree.agents[0].source, 'detected process');
  assert(!result.projects.some(p => p.path.startsWith(forbidden) || p.path.includes('not-a-project')));
  assert(result.warnings.some(w => w.includes('outside observation roots')));
  const bounded = await catalog.list({ limit: 1 }); assert.equal(bounded.projects.length, 1); assert.equal(bounded.nextCursor, 1);
});

test('agents attach to the deepest approved checkout; unknown directories stay unassigned', async t => {
  const { root, config, host } = await setup(t); const profile = config.profiles[0]; config.profiles = [];
  const projects = join(root, 'projects'); const app = join(projects, 'app'); const sibling = join(projects, 'app-other');
  await mkdir(join(app, 'web'), { recursive: true }); await mkdir(sibling); await mkdir(join(app, 'fixture'));
  config.projectRoots = [projects]; config.observationRoots = [projects];
  config.projects = [{ path: app, links: [], agents: [{ name: 'Owner agent' }] }];
  // Reviewed paths are existing catalog seeds, not directories discovered from processes.
  config.profiles = [{ ...profile, projectPath: join(app, 'fixture') }];
  host.agentObservations.agents = [
    { id: 'a'.repeat(24), name: 'Codex', cwd: join(app, 'web') },
    { id: 'b'.repeat(24), name: 'Codex', cwd: join(app, 'fixture') },
    { id: 'c'.repeat(24), name: 'Claude Code', cwd: sibling },
    { id: 'd'.repeat(24), name: 'Codex', cwd: projects },
    { id: 'e'.repeat(24), name: 'Codex', cwd: root },
  ];
  await symlink(root, join(app, 'escaped')); host.agentObservations.agents.push({ id: 'f'.repeat(24), name: 'Codex', cwd: join(app, 'escaped') });
  const catalog = new Catalog(config, host); const result = await catalog.list({});
  assert.deepEqual(result.projects.find(p => p.path === app)!.agents.map(a => a.source), ['owner registration', 'detected process']);
  assert.equal(result.projects.find(p => p.path === join(app, 'fixture'))!.agents.length, 1);
  assert.equal(result.projects.find(p => p.path === sibling)!.agents[0].name, 'Claude Code');
  assert(result.warnings.some(w => w.startsWith('3 detected')));
  host.agentObservations.agents = [];
  const now = Date.now(); const clock = t.mock.method(Date, 'now', () => now + 6000);
  const refreshed = await catalog.list({}); clock.mock.restore();
  assert(refreshed.projects.every(p => p.agents.every(a => a.source === 'owner registration')));
  host.agents = async () => { throw new Error('unavailable'); };
  const failed = await new Catalog(config, host).list({});
  assert(failed.warnings.includes('Agent detection unavailable'));
  assert.equal(failed.projects.find(p => p.path === app)!.agents.length, 1);
});
