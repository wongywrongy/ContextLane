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
  const catalog = new Catalog(config, host); const result = await catalog.list({ limit: 50 });
  assert(result.projects.some(p => p.path === plain && p.manifests.includes('package.json')));
  const main = result.projects.find(p => p.path === repo)!; const worktree = result.projects.find(p => p.path === detached)!;
  assert.equal(main.gitCommonDir, worktree.gitCommonDir); assert.equal(worktree.detached, true);
  assert(!result.projects.some(p => p.path.startsWith(forbidden) || p.path.includes('not-a-project')));
  assert(result.warnings.some(w => w.includes('outside observation roots')));
  const bounded = await catalog.list({ limit: 1 }); assert.equal(bounded.projects.length, 1); assert.equal(bounded.nextCursor, 1);
});
