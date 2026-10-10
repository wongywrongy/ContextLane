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
