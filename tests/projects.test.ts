import test from 'node:test';
import assert from 'node:assert/strict';
import { groupProjects, loadCatalog, projectStatus, groupAgents, agentLabel } from '../web/projects.js';
import type { Project } from '../src/shared/contracts.js';
const project = (path: string, overrides: Partial<Project> = {}): Project => ({ id:path,name:path.split('/').at(-1)!,path,gitCommonDir:null,branch:null,detached:false,manifests:[],links:[],agents:[],environmentIds:[],logServices:[],runtime:{services:[],status:'no associated listener',ports:[],ownership:'observe-only'},...overrides });
test('primary projects group detached/external worktrees and nested environments, while container folders disappear', () => {
  const main=project('/code/app',{gitCommonDir:'/code/app/.git',manifests:['package.json']});
  const tree=project('/code/app-worktrees/feature',{gitCommonDir:main.gitCommonDir,detached:true});
  const external=project('/allowed/other',{gitCommonDir:main.gitCommonDir});
  const fixture=project('/code/app/fixtures/native',{environmentIds:['native-dev']});
  const plain=project('/code/plain');
  const groups=groupProjects([tree,project('/code/app-worktrees'),fixture,plain,external,main]);
  assert.equal(groups.length,2); const group=groups.find(g=>g.primary===main)!;
  assert.equal(group.worktreeCount,2); assert.equal(group.checkouts.length,4); assert.deepEqual(group.environmentIds,['native-dev']);
  assert.equal(projectStatus(group,{}),'Unknown');
  assert.equal(projectStatus(groups.find(g=>g.primary===plain)!,{}),'Not observed');
  const independent=project('/code/app-worktrees',{manifests:['pyproject.toml']});
  assert.equal(groupProjects([main,tree,independent]).length,2);
});
test('all bounded pages load before grouping and incomplete snapshots are rejected',async()=>{
  const main=project('/code/app',{gitCommonDir:'/code/app/.git'});
  const tree=project('/allowed/feature',{gitCommonDir:main.gitCommonDir});
  const calls:number[]=[];
  const result=await loadCatalog(async cursor=>{calls.push(cursor);return {projects:cursor?[tree]:[main],nextCursor:cursor?null:1,warnings:['warning'],observedAt:'same'};});
  assert.deepEqual(calls,[0,1]);assert.equal(groupProjects(result.projects).length,1);assert.deepEqual(result.warnings,['warning']);
  await assert.rejects(loadCatalog(async cursor=>({projects:[main],nextCursor:cursor?null:1,warnings:[],observedAt:cursor?'new':'old'})),/changed/);
  await assert.rejects(loadCatalog(async()=>({projects:[main],nextCursor:0,warnings:[],observedAt:'same'})),/advance/);
  const bounded=await loadCatalog(async cursor=>({projects:Array.from({length:50},(_,i)=>project('/code/'+(cursor+i))),nextCursor:cursor+50,warnings:[],observedAt:'same'}));
  assert.equal(bounded.projects.length,1000);assert(bounded.warnings.some(w=>w.includes('1,000')));
});
test('listeners are not readiness and missing observation is not stopped',()=>{
 const listening=groupProjects([project('/code/plain',{logServices:[],runtime:{services:[],status:'listeners observed',ports:[3000],ownership:'observe-only'}})])[0];
 assert.equal(projectStatus(listening,{}),'Listening');
 const unknown=groupProjects([project('/code/unknown',{logServices:[],runtime:{services:[],status:'unknown',ports:[],ownership:'observe-only'}})])[0];
 assert.equal(projectStatus(unknown,{}),'Unknown');
});

 test('grouped agents preserve same-name processes and label registration separately', () => {
 const main = project('/code/app', {gitCommonDir:'/code/app/.git', agents:[{name:'Codex',source:'owner registration'},{name:'Codex',source:'detected process',id:'a'.repeat(24)}]});
 const tree = project('/allowed/tree', {gitCommonDir:main.gitCommonDir, agents:[{name:'Codex',source:'detected process',id:'b'.repeat(24)}]});
 const agents = groupAgents(groupProjects([main,tree])[0]);
 assert.equal(agents.length,3); assert.deepEqual(agents.map(agentLabel).sort(),['Detected process','Detected process','Registered']);
 });

test('Signal search includes worktree branches and configured or observed ports; filters retain evidence semantics', async () => {
  const { matchesProject, matchesFilter, groupServices, branchLabel, editorHref, chipTone } = await import('../web/projects.js');
  const main = project('/code/a space', {gitCommonDir:'/code/a space/.git', branch:'main', environmentIds:['dev'], runtime:{services:[{id:'web', name:'Web', port:5173}], ports:[], status:'no associated listener', ownership:'observe-only'}});
  const tree = project('/allowed/tree', {gitCommonDir:main.gitCommonDir, branch:'fix/login', agents:[{name:'Codex',source:'owner registration'}],runtime:{services:[],ports:[3000],status:'listeners observed',ownership:'observe-only'}});
  const group = groupProjects([main, tree])[0];
  assert(matchesProject(group,' FIX/LOGIN ')); assert(matchesProject(group,'5173')); assert(matchesProject(group,'3000')); assert(!matchesProject(group,'missing'));
  assert(matchesFilter(group,'With agents',{})); assert(matchesFilter(group,'Managed',{})); assert(matchesFilter(group,'Running',{}));
  assert(!matchesFilter(groupProjects([project('/code/registered',{agents:[{name:'Codex',source:'owner registration'}]})])[0], 'Running', {}));
  assert.deepEqual(groupServices(group,{}).map(s => s.state).sort(),['Listening','Unknown']);
  assert.equal(branchLabel(project('/code/detached',{detached:true,detachedSha:'abcd123'})), 'detached @ abcd123');
  assert.equal(branchLabel(project('/code/unknown',{detached:true})), 'detached @ —');
  assert.equal(editorHref('/code/a space/#x','vscode://file{path}'), 'vscode://file/code/a%20space/%23x');
  assert.equal(chipTone('Listening'),'info'); assert.equal(chipTone('Published'),'info'); assert.equal(chipTone('Detected'),'idle'); assert.equal(chipTone('Available'),'ok');
});

test('service readiness is never inferred from an observed listener or owner-reviewed name', async () => {
  const { groupServices } = await import('../web/projects.js');
  const group=groupProjects([project('/code/app',{runtime:{services:[{id:'web',name:'Web',port:3000}],ports:[3000],status:'listeners observed',ownership:'observe-only'}})])[0];
  assert.equal(groupServices(group,{})[0].state,'Listening'); assert.equal(groupServices(group,{})[0].managed,false);
});

test('same service name across environments cannot transfer readiness to another port', async () => {
  const { groupServices } = await import('../web/projects.js');
  const { environmentOutput } = await import('../src/shared/contracts.js');
  const group = groupProjects([project('/code/app',{environmentIds:['one','two'],runtime:{services:[{id:'web',name:'Web',port:3000},{id:'web',name:'Web',port:4000}],ports:[3000],status:'listeners observed',ownership:'observe-only'}})])[0];
  const env = (id:string,port:number,application:'ready'|'stopped') => environmentOutput.parse({id,profileRevision:'revision',effects:'fixture',dataRequirements:'none',startAllowed:true,ownership:'rootlane',desiredState:application==='ready'?'running':'stopped',application,preview:'unavailable',links:[],services:[{id:'web',port,unit:id+'.service',state:application==='ready'?'active':'inactive'}],observedAt:'time',latestOperation:null,observationError:null});
  const services=groupServices(group,{one:env('one',3000,'ready'),two:env('two',4000,'stopped')});
  assert.deepEqual(services.map(s=>s.state),['Ready','Stopped']); assert.deepEqual(services.map(s=>s.unit),['one.service','two.service']);
});


test('editor URLs require an approved template; host and paths are safely encoded',async()=>{
  const {editorHref}=await import('../web/projects.js');
  assert.equal(editorHref('/code/app'),null);
  assert.equal(editorHref('/code/a space','vscode://vscode-remote/ssh-remote+{host}{path}','neo'), 'vscode://vscode-remote/ssh-remote+neo/code/a%20space');
  assert.equal(editorHref('/code/app','javascript:alert(1)'),null);
  assert.equal(editorHref('/code/app','vscode://{host}{path}'),null);
});

test('links dedupe by source, retain independent states and branch labels, sort, and fail closed when stale', async t => {
  const { groupLinks } = await import('../web/projects.js');
  const { environmentOutput, previewOutput } = await import('../src/shared/contracts.js');
  const main = project('/code/app', { gitCommonDir: '/code/app/.git', branch: 'main', environmentIds: ['one'],
    links: [{ label: 'Docs', url: 'https://docs.test/' }, { label: 'Duplicate', url: 'https://one.test/' }],
    routeSummaries: [{ url: 'https://one.test/', upstreamPort: 3000, target: 'http://127.0.0.1:3000', route: 'matching' },
      { url: 'https://observed.test/', upstreamPort: 5000, target: 'http://127.0.0.1:5000', route: 'matching' }],
    runtime: { services: [{ id: 'web', name: 'Console', port: 3000 }], status: 'listeners observed', ports: [3000], ownership: 'observe-only' } });
  const tree = project('/code/tree', { gitCommonDir: main.gitCommonDir, branch: 'feature', environmentIds: ['two'] });
  const group = groupProjects([main, tree])[0];
  const env = (id: string, url: string, ready: boolean) => environmentOutput.parse({ id, profileRevision: 'rev', effects: 'fixture',
    dataRequirements: 'none', startAllowed: true, ownership: 'rootlane', desiredState: 'running', application: ready ? 'ready' : 'unhealthy',
    preview: ready ? 'available' : 'unavailable', links: [], services: [], observedAt: 'now', latestOperation: null, observationError: null,
    previews: [{ serviceId: 'web', label: 'Console', port: 443, url }],
    previewRoutes: [{ url, target: 'http://127.0.0.1:3000', upstream: ready ? 'ready' : 'unready', route: 'matching', https: ready ? 'verified' : 'failed' }] });
  const envs = { one: env('one', 'https://one.test/', true), two: env('two', 'https://two.test/', false) };
  const publication = previewOutput.parse({ id: '12345678-1234-4234-8234-123456789abc', targetId: 'gone', projectPath: main.path,
    checkoutPath: main.path, serviceId: 'gone', serviceName: 'Gone', port: 6000, httpsPort: 443, ownership: 'rootlane route only',
    approved: true, removed: true, url: 'https://gone.test/', route: 'absent', upstream: 'unknown', https: 'unverified',
    actualConfiguration: null, errors: [], observedAt: 'now', latestOperation: null });
  const links = groupLinks(group, envs, { [publication.id]: publication }, null);
  assert.deepEqual(links.map(l => l.state), ['Available', 'Published', 'Attention', 'Link', 'Not exposed']);
  assert.equal(links.find(l => l.url === 'https://one.test/')!.label, 'Console · main');
  assert.equal(links.find(l => l.url === 'https://two.test/')!.label, 'Console · feature');
  assert.equal(links.find(l => l.source === 'Observed route')!.label, ':5000');
  assert.equal(links.filter(l => l.url === 'https://one.test/').length, 1);
  assert.equal(links.find(l => l.label === 'Docs')!.state, 'Link');
  main.runtime.status = 'unknown';
  assert(groupLinks(group, envs, { [publication.id]: publication }, null).every(l => l.state === 'Unknown'));
  main.runtime.status = 'listeners observed';
  const duplicate = { ...publication, removed: false, url: 'https://one.test/', serviceName: 'Publication label',
    route: 'matching' as const, https: 'verified' as const, upstream: 'ready' as const };
  assert.equal(groupLinks(group, envs, { [duplicate.id]: duplicate }, null).find(l => l.url === duplicate.url)!.source, 'Publication');
});


test('recipe presentation distinguishes invalid, pending, stale and approved review states', async () => {
  const { recipePresentation } = await import('../web/projects.js');
  const recipe = { found: true, valid: true, errors: [], approval: 'none' as const };
  assert.deepEqual(recipePresentation(recipe), { state: 'Detected', text: 'Needs approval' });
  assert.deepEqual(recipePresentation({ ...recipe, valid: false }), { state: 'Attention', text: 'Invalid' });
  assert.equal(recipePresentation({ ...recipe, approval: 'pending' }).text, 'Pending approval');
  assert.equal(recipePresentation({ ...recipe, approval: 'approved' }).state, 'Ready');
  assert.equal(recipePresentation({ ...recipe, approval: 'stale' }).state, 'Attention');
});
