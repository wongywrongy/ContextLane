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

test('Signal payload attributes agents and listeners to a checkout and exposes detached worktrees', async t => {
  const { root, config, host } = await setup(t); config.profiles = [];
  const repo = join(root, 'repo'); const tree = join(root, 'detached');
  await mkdir(repo); await command('git', ['init', repo]);
  await command('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  await command('git', ['-C', repo, 'worktree', 'add', '--detach', tree]);
  await mkdir(join(tree, 'web'));
  host.agentObservations.agents = [{id:'a'.repeat(24),name:'Codex',cwd:join(tree,'web')}];
  host.listeners = async () => [{address:'127.0.0.1',port:3000,pid:1,cwd:tree,cgroup:null},{address:'127.0.0.1',port:4000,pid:null,cwd:null,cgroup:null}];
  config.projects=[{path:repo,links:[{label:'Homepage',url:'https://example.invalid/'}],agents:[]}];
  (host as import('../src/host/types.js').Host).routes=async()=>({TCP:{'8443':{HTTPS:true}},Web:{[config.tailnetHostname+':8443']:{Handlers:{'/':{Proxy:'http://127.0.0.1:3000'}}}}});
  const result = await new Catalog(config, host).list({limit:50});
  const main = result.projects.find(p => p.path === repo)!; const checkout = result.projects.find(p => p.path === tree)!;
  assert.match(checkout.detachedSha!, /^[a-f0-9]+$/);
  assert.deepEqual(checkout.runtime.listeners,[{port:3000,worktreePath:tree}]);
  assert.equal(checkout.agents[0].source,'detected process');
  if (checkout.agents[0].source === 'detected process') { assert.equal(checkout.agents[0].cwd,join(tree,'web')); assert.equal(checkout.agents[0].worktreePath,tree); }
  assert.deepEqual(main.observedPreviews,[]); assert.equal(main.links[0].label,'Homepage');
  assert.equal(checkout.observedPreviews?.[0].url,`https://${config.tailnetHostname}:8443/`);
  assert.equal(main.worktrees?.length,2); assert.deepEqual(main.worktrees?.find(w => w.path === tree)?.ports,[3000]);
  assert(result.projects.every(p => !p.runtime.ports.includes(4000)));
  const { catalogOutput } = await import('../src/shared/contracts.js'); assert.doesNotThrow(() => catalogOutput.parse(result));
});
