// Restore a real release backup only into private disposable directories; never start its controller.
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,copyFile,rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../dist/state/store.js';
const backup=process.argv[2];assert(backup?.startsWith('/'),'Pass an absolute backup directory');
const metadata=JSON.parse(await readFile(join(backup,'metadata.json'),'utf8'));
for(const field of ['previousTag','rollbackTag','configDirectory','stateDirectory'])assert.equal(typeof metadata[field],'string',field);
const directory=await mkdtemp('/tmp/rootlane-restore-');let baseline,migrated;
try {
  for(const name of ['installation','config','state']) {
    const destination=join(directory,name);await mkdir(destination,{mode:0o700});
    execFileSync('tar',['-xzf',join(backup,name+'.tar.gz'),'-C',destination],{stdio:'ignore'});
  }
  const state=join(directory,'state/rootlane.sqlite');
  for(const suffix of ['-wal','-shm'])await rm(state+suffix,{force:true});
  await copyFile(join(backup,'rootlane.sqlite'),state);
  const reference=join(directory,'baseline.sqlite');await copyFile(state,reference);baseline=new Database(reference);
  assert.equal(baseline.pragma('integrity_check',{simple:true}),'ok');
  const tables=['approvals','instances','environments','operations','requests','recipe_requests','resources','reservations','meta'];
  const rows=Object.fromEntries(tables.map(table=>[table,baseline.prepare(`SELECT * FROM ${table}`).all()]));
  const oldSchema=baseline.pragma('user_version',{simple:true});migrated=new Store(state);
  assert.equal(migrated.db.pragma('user_version',{simple:true}),6);
  for(const table of tables)assert.deepEqual(migrated.db.prepare(`SELECT * FROM ${table}`).all(),rows[table],table);
  const installed=JSON.parse(await readFile(join(directory,'installation/package.json'),'utf8'));
  const config=JSON.parse(await readFile(join(directory,'config/config.json'),'utf8'));assert.equal(config.stateDirectory,metadata.stateDirectory);
  console.log(JSON.stringify({backup,rollbackTag:metadata.rollbackTag,previousTag:metadata.previousTag,installedVersion:installed.version,oldSchema,newSchema:6,integrity:'ok',preservedTables:tables,liveResourcesChanged:false},null,2));
}finally{migrated?.close();baseline?.close();await rm(directory,{recursive:true,force:true});}
