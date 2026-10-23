import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { integrate, type IntegrationInput } from '../src/integrations/runner.js';
import { setup } from './helpers.js';
async function fixture(t:Parameters<typeof setup>[0],client:'codex'|'claude') {
  const f=await setup(t),home=join(f.root,'home'),adapter=join(f.root,'adapter');await mkdir(join(home,'.local/bin'),{recursive:true});await mkdir(join(home,'.codex'));await mkdir(join(home,'.claude'));await writeFile(adapter,'#!/bin/sh\nexit 0\n',{mode:0o700});
  const input:IntegrationInput={client,action:'inspect',home,adapter,tools:['list_projects','inspect_environment','recover_environment']};
  return {...f,home,input};
}
test('Claude repair uses native registration and merges telemetry without changing hooks, output or permissions',async t=>{
  const f=await fixture(t,'claude');
  await writeFile(join(f.home,'.local/bin/claude'),`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');if(process.argv.includes('--version'))console.log('2.1.309 (Claude Code)');else if(process.argv.includes('add')){const p=path.join(process.env.HOME,'.claude.json');const value=fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):{};value.mcpServers={...value.mcpServers,rootlane:{command:process.argv.at(-1)}};fs.writeFileSync(p,JSON.stringify(value));}else console.log('Status: Connected');`,{mode:0o700});
  const settings={hooks:{SessionStart:[{hooks:[{type:'command',command:'existing-hook'}]}]},statusLine:{type:'command',command:'existing-status'},permissions:{allow:['Read']},env:{UNRELATED:'keep'}};
  await writeFile(join(f.home,'.claude/settings.json'),JSON.stringify(settings));await writeFile(join(f.home,'.claude.json'),JSON.stringify({mcpServers:{unrelated:{command:'other'}},theme:'existing'}));
  const request={...f.input,telemetry:true,endpoint:'http://127.0.0.1:9481',token:'private-token-sentinel'};
  const review=await integrate(request);assert.equal(review.configured,false);assert(!JSON.stringify(review).includes('private-token-sentinel'));
  const applied=await integrate({...request,action:'apply',fingerprint:review.fingerprint});assert.equal(applied.configured,true);
  const after=JSON.parse(await readFile(join(f.home,'.claude/settings.json'),'utf8'));for(const key of ['hooks','statusLine','permissions'] as const)assert.deepEqual(after[key],settings[key]);assert.equal(after.env.UNRELATED,'keep');
  const config=JSON.parse(await readFile(join(f.home,'.claude.json'),'utf8'));assert.equal(config.mcpServers.unrelated.command,'other');
  const verified=await integrate({...request,action:'verify'});assert.equal(verified.connectionChecked,false);assert.equal(verified.toolCallVerified,false);
  const changed=await integrate(request);await writeFile(join(f.home,'.claude/settings.json'),JSON.stringify({...after,changed:true}));await assert.rejects(integrate({...request,action:'apply',fingerprint:changed.fingerprint}),/changed/);
});
test('existing exporters require explicit replacement review',async t=>{
  const f=await fixture(t,'claude');await writeFile(join(f.home,'.local/bin/claude'),`#!${process.execPath}\nconsole.log('2.1.309 (Claude Code)')`,{mode:0o700});
  await writeFile(join(f.home,'.claude/settings.json'),JSON.stringify({env:{OTEL_EXPORTER_OTLP_ENDPOINT:'https://existing.invalid'}}));
  const input={...f.input,telemetry:true,endpoint:'http://127.0.0.1:9481',token:'private'};const review=await integrate(input);assert(review.blockers.some(b=>b.includes('replacement')));await assert.rejects(integrate({...input,action:'apply',fingerprint:review.fingerprint}),/replacement/);
  await writeFile(join(f.home,'.claude/settings.json'),JSON.stringify({env:{OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:'https://existing.invalid/logs',OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:'https://traces.invalid'}}));
  assert((await integrate(input)).blockers.some(b=>b.includes('replacement')));
  await writeFile(join(f.home,'.claude.json'),JSON.stringify({mcpServers:{rootlane:{command:f.input.adapter}}}));
  const replacement={...input,replaceExporters:true},checked=await integrate(replacement);await integrate({...replacement,action:'apply',fingerprint:checked.fingerprint});
  const env=JSON.parse(await readFile(join(f.home,'.claude/settings.json'),'utf8')).env;assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,undefined);assert.equal(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,'https://traces.invalid');
});
test('Codex repairs use native config versions, preserve unrelated permissions, and verify only a read-only tool',async t=>{
  const f=await fixture(t,'codex');
  await writeFile(join(f.home,'.local/bin/codex'),`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const file=path.join(process.env.CODEX_HOME,'config.toml');
if(process.argv.includes('--version'))console.log('codex-cli 0.163.0');else require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result={};const text=()=>fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';const hash=()=>crypto.createHash('sha256').update(text()).digest('hex');
if(m.method==='config/read')result={config:JSON.parse(text()||'{}'),layers:[{name:{type:'user',file},version:hash()}]};
if(m.method==='config/batchWrite'){if(m.params.expectedVersion!==hash())process.exit(2);const config=JSON.parse(text()||'{}');for(const edit of m.params.edits){const keys=edit.keyPath.split('.');let value=config;for(const key of keys.slice(0,-1))value=value[key]??={};value[keys.at(-1)]=edit.value;}fs.writeFileSync(file,JSON.stringify(config));result={version:hash()};}
if(m.method==='thread/start'){if(m.params.sandbox!=='read-only')process.exit(3);result={thread:{id:'fixture'}};}
if(m.method==='mcpServerStatus/list')result={data:[{name:'rootlane',tools:{list_projects:{}}}]};
if(m.method==='mcpServer/tool/call'){if(m.params.tool!=='list_projects')process.exit(4);result={structuredContent:{projects:[]}};}
console.log(JSON.stringify({id:m.id,result}));});`,{mode:0o700});
  await writeFile(join(f.home,'.codex/config.toml'),JSON.stringify({approval_policy:'on-request',mcp_servers:{other:{command:'keep'},rootlane:{command:f.input.adapter,args:['wrong-endpoint'],enabled:true,enabled_tools:['list_projects'],disabled_tools:['inspect_environment','future_tool'],default_tools_approval_mode:'prompt'}}}));
  const review=await integrate(f.input);assert(!review.configured);assert.deepEqual(review.missingTools,['inspect_environment','recover_environment']);assert(review.changes.some(text=>text.includes('disabled_tools') && text.includes('future_tool')));
  const applied=await integrate({...f.input,action:'apply',fingerprint:review.fingerprint});assert(applied.configured);assert.deepEqual(applied.missingTools,[]);
  const config=JSON.parse(await readFile(join(f.home,'.codex/config.toml'),'utf8'));assert.equal(config.approval_policy,'on-request');assert.equal(config.mcp_servers.other.command,'keep');assert.deepEqual(config.mcp_servers.rootlane.enabled_tools,f.input.tools);
  assert.deepEqual(config.mcp_servers.rootlane.disabled_tools,['future_tool']);assert.deepEqual(config.mcp_servers.rootlane.args,[]);assert.equal(config.mcp_servers.rootlane.default_tools_approval_mode,'prompt');
  for(const rootlane of [{...config.mcp_servers.rootlane,args:['wrong']},{...config.mcp_servers.rootlane,enabled_tools:f.input.tools,disabled_tools:['list_projects']}]) {
    await writeFile(join(f.home,'.codex/config.toml'),JSON.stringify({...config,mcp_servers:{...config.mcp_servers,rootlane}}));assert.equal((await integrate(f.input)).configured,false);
  }
  await writeFile(join(f.home,'.codex/config.toml'),JSON.stringify(config));
  const verified=await integrate({...f.input,action:'verify'});assert(verified.toolCallVerified);assert(verified.connectionChecked);assert.deepEqual(verified.tools,['list_projects']);
});
test('Claude verification requires a correlated structured result and disables write tools',async t=>{
  const f=await fixture(t,'claude'),file=join(f.home,'.local/bin/claude');
  await writeFile(join(f.home,'.claude.json'),JSON.stringify({mcpServers:{rootlane:{command:f.input.adapter,args:['wrong']},other:{command:'keep'}},theme:'existing'}));
  const script=(result:unknown)=>`#!${process.execPath}
if(process.argv.includes('--version'))console.log('2.1.309 (Claude Code)');else {
const args=process.argv.slice(2);if(args.includes('--print')){
const assert=require('node:assert/strict');assert.equal(args[args.indexOf('--tools')+1],'');assert.equal(args[args.indexOf('--allowedTools')+1],'mcp__rootlane__list_projects');assert(args[args.indexOf('--disallowedTools')+1].includes('recover_environment'));assert(args.includes('--strict-mcp-config'));
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'mcp__rootlane__list_projects',id:'actual'}]}}));console.log(JSON.stringify(${JSON.stringify(result)}));}else console.log('Status: Connected');}`;
  await writeFile(file,script({type:'user',message:{content:[{type:'tool_result',tool_use_id:'other',content:'{"projects":[]}' } ]}}),{mode:0o700});
  const review=await integrate(f.input);assert(!review.configured);assert((await integrate({...f.input,action:'apply',fingerprint:review.fingerprint})).configured);
  const saved=JSON.parse(await readFile(join(f.home,'.claude.json'),'utf8'));assert.equal(saved.theme,'existing');assert.equal(saved.mcpServers.other.command,'keep');assert.deepEqual(saved.mcpServers.rootlane.args,[]);
  assert.equal((await integrate({...f.input,action:'verify'})).toolCallVerified,false);
  await writeFile(file,script({type:'user',message:{content:[{type:'tool_result',tool_use_id:'actual',content:'The text "projects" is not a result'}]}}));assert.equal((await integrate({...f.input,action:'verify'})).toolCallVerified,false);
  await writeFile(file,script({type:'user',message:{content:[{type:'tool_result',tool_use_id:'actual',content:'{"projects":[]}' } ]}}));
  const verified=await integrate({...f.input,action:'verify'});assert(verified.connectionChecked);assert(verified.toolCallVerified);
});
