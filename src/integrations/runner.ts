// Runs on the host through an owned, bounded systemd job; uses only Node's standard library.
import { readFile, writeFile, rename, stat, mkdir, chmod, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash,randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
export type IntegrationInput = {client:'codex'|'claude';action:'inspect'|'apply'|'verify';home:string;adapter:string;fingerprint?:string;telemetry?:boolean;replaceExporters?:boolean;endpoint?:string;token?:string;tools:string[]};
const hash = (value:string)=>createHash('sha256').update(value).digest('hex');
function registration(server:any,adapter:string) {
  return server?.command===adapter && (!server.args || (Array.isArray(server.args) && server.args.length===0)) && !server.url && server.enabled!==false;
}
function missingTools(server:any,tools:string[]) {
  if(!server || server.enabled===false)return [...tools];
  return tools.filter(tool=>(Array.isArray(server?.enabled_tools) && !server.enabled_tools.includes(tool)) || server?.disabled_tools?.includes(tool));
}
function projectResult(value:any) {return value && Array.isArray(value.projects);}
function structuredResult(call:any) {
  if(call?.isError || call?.is_error)return false;
  if(projectResult(call?.structuredContent))return true;
  const content=typeof call?.content==='string'?[{type:'text',text:call.content}]:call?.content;
  return Array.isArray(content) && content.some((item:any)=>{try{return item.type==='text' && projectResult(JSON.parse(item.text));}catch{return false;}});
}
async function read(path:string) {
  try { const info=await stat(path); if(!info.isFile() || info.size>1048576)throw new Error('Client configuration exceeds 1 MiB'); return await readFile(path,'utf8'); }
  catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return '';throw error; }
}
async function clientExecutable(home:string,name:string) {
  for(const path of [join(home,'.local/bin',name),`/usr/local/bin/${name}`,`/usr/bin/${name}`]) {
    try { await stat(path);return path; }catch { /* Try the next standard location. */ }
  }
  return null;
}
export function codexRpc(executable:string,home:string) {
  const child=spawn(executable,['app-server'],{env:{...process.env,HOME:home,CODEX_HOME:join(home,'.codex')},stdio:['pipe','pipe','ignore']});
  let id=0;
  const waiting=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const lines=createInterface({input:child.stdout});
  const fail=()=>{for(const request of waiting.values()){clearTimeout(request.timer);request.reject(new Error('Codex app-server unavailable'));}waiting.clear();};
  child.on('error',fail);child.on('exit',fail);
  lines.on('line',line=>{
    if(line.length>1048576){fail();child.kill();return;}
    try {const message=JSON.parse(line),request=waiting.get(message.id);if(request){clearTimeout(request.timer);waiting.delete(message.id);message.error?request.reject(new Error('Codex rejected configuration or tool request')):request.resolve(message.result);}}
    catch { /* Non-protocol output cannot verify a connection. */ }
  });
  const call=(method:string,params:unknown={})=>new Promise<any>((resolve,reject)=>{
    const requestId=++id,timer=setTimeout(()=>{waiting.delete(requestId);reject(new Error('Codex app-server timeout'));},10000);
    waiting.set(requestId,{resolve,reject,timer});child.stdin.write(JSON.stringify({id:requestId,method,params})+'\n');
  });
  return {call,async initialize(){await call('initialize',{clientInfo:{name:'rootlane',version:'0.9.0'},capabilities:{experimentalApi:true}});child.stdin.write('{"method":"initialized","params":{}}\n');},close(){lines.close();child.kill();fail();}};
}
async function atomicJson(path:string,value:unknown,expected:string) {
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temporary=path+'.rootlane-'+randomUUID();
  try {
    if(hash(await read(path))!==expected)throw new Error('Client settings changed; inspect and review again');
    await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
    if(hash(await read(path))!==expected)throw new Error('Client settings changed; inspect and review again');
    await rename(temporary,path);
  } finally { await unlink(temporary).catch(()=>{}); }
}
export async function integrate(input:IntegrationInput) {
  const executable=await clientExecutable(input.home,input.client);
  const configPath=input.client==='codex'?join(input.home,'.codex/config.toml'):join(input.home,'.claude.json');
  const settingsPath=join(input.home,'.claude/settings.json');
  const contents=await read(configPath),settingsText=input.client==='claude'?await read(settingsPath):'';
  const fingerprint=hash(JSON.stringify({contents,settingsText,adapter:input.adapter,telemetry:!!input.telemetry,replace:!!input.replaceExporters,endpoint:input.endpoint}));
  const clientEnv:NodeJS.ProcessEnv={...process.env,HOME:input.home,CODEX_HOME:join(input.home,'.codex')};
  delete clientEnv.CLAUDE_CONFIG_DIR;
  const result={client:input.client,version:null as string|null,executable,configPath,adapter:input.adapter,adapterAvailable:false,configured:false,connectionChecked:false,toolCallVerified:false,tools:[] as string[],missingTools:[] as string[],fingerprint,changes:[`Register Rootlane adapter ${input.adapter} with args=[]; preserve unrelated permissions and client settings.`],blockers:[] as string[]};
  try { const info=await stat(input.adapter);result.adapterAvailable=info.isFile() && !!(info.mode&0o111); }catch { /* Report the absent installation adapter. */ }
  if(!result.adapterAvailable)result.blockers.push('Installed Rootlane MCP adapter is unavailable; configure ROOTLANE_MCP_ADAPTER with its host path.');
  if(!executable){result.blockers.push(`Install ${input.client} on the host.`);return result;}
  try {result.version=execFileSync(executable,['--version'],{env:clientEnv,encoding:'utf8',timeout:3000,maxBuffer:4096,stdio:['ignore','pipe','ignore']}).trim();}catch {result.blockers.push('Client version could not be detected.');return result;}
  if(input.telemetry)result.changes.push(`Enable counts-only client telemetry to ${input.endpoint}; preserve hooks, status-line output and unrelated exporters. Credential-bearing client files become owner read/write only (0600).`);
  if(input.client!=='codex' && input.action==='apply' && input.fingerprint!==fingerprint)throw new Error('Client configuration changed; inspect and review again');
  if(input.action==='apply' && result.blockers.length)throw new Error(result.blockers.join('; '));
  if(input.client==='codex') {
    const rpc=codexRpc(executable,input.home);
    try {
      await rpc.initialize();
      const config=await rpc.call('config/read',{includeLayers:true});
      const server=config.config?.mcp_servers?.rootlane;
      result.fingerprint=hash(JSON.stringify({fingerprint,server,tools:input.tools}));
      if(input.action==='apply' && input.fingerprint!==result.fingerprint)throw new Error('Effective Codex configuration changed; inspect and review again');
      result.missingTools=missingTools(server,input.tools);
      result.configured=registration(server,input.adapter) && !result.missingTools.length;
      const disabled=(server?.disabled_tools ?? []).filter((tool:string)=>!input.tools.includes(tool));
      const edits=[{keyPath:'mcp_servers.rootlane.command',value:input.adapter,mergeStrategy:'replace'},{keyPath:'mcp_servers.rootlane.args',value:[],mergeStrategy:'replace'},{keyPath:'mcp_servers.rootlane.enabled',value:true,mergeStrategy:'replace'},{keyPath:'mcp_servers.rootlane.enabled_tools',value:input.tools,mergeStrategy:'replace'},{keyPath:'mcp_servers.rootlane.disabled_tools',value:disabled,mergeStrategy:'replace'}];
      result.changes.push(JSON.stringify(edits,null,2));
      if(server?.url)result.blockers.push('Rootlane is registered as a remote server. Remove only that registration with the native client, then inspect the local adapter again.');
      const user=config.layers?.find((layer:any)=>layer.name?.type==='user' && layer.name.file===configPath);
      if(!user?.version)result.blockers.push('Codex did not supply a writable user configuration revision. Initialize its user config with the native client, then inspect again.');
      const currentOtel=config.config?.otel?.exporter;
      if(input.telemetry && currentOtel && currentOtel!=='none' && !JSON.stringify(currentOtel).includes(input.endpoint ?? 'http://127.0.0.1:9481') && !input.replaceExporters)result.blockers.push('An existing Codex telemetry exporter requires explicit replacement review.');
      if(input.action==='apply') {
        if(!user?.version)throw new Error('This Codex version did not supply a user configuration revision; native version-checked writes are required.');
        if(hash(await read(configPath))!==hash(contents))throw new Error('Codex configuration changed during review');
        if(result.blockers.length)throw new Error(result.blockers.join('; '));
        if(input.telemetry) {
          if(!input.token || !input.endpoint)throw new Error('Opt in to the receiver before configuring client telemetry');
          const info=await stat(configPath);if(info.uid!==process.getuid?.())throw new Error('Codex configuration must be owner-owned before storing telemetry credentials');
          await chmod(configPath,0o600);
          edits.push({keyPath:'otel.log_user_prompt',value:false as any,mergeStrategy:'replace'},{keyPath:'otel.exporter',value:{'otlp-http':{endpoint:input.endpoint+'/otlp/v1/logs',protocol:'json',headers:{Authorization:`Bearer ${input.token}`}}} as any,mergeStrategy:'replace'});
        }
        await rpc.call('config/batchWrite',{filePath:configPath,expectedVersion:user.version,edits});
        const saved=await rpc.call('config/read',{includeLayers:false}),effective=saved.config?.mcp_servers?.rootlane;
        result.missingTools=missingTools(effective,input.tools);result.configured=registration(effective,input.adapter) && !result.missingTools.length;
        result.fingerprint=hash(JSON.stringify({fingerprint:hash(JSON.stringify({contents:await read(configPath),settingsText,adapter:input.adapter,telemetry:!!input.telemetry,replace:!!input.replaceExporters,endpoint:input.endpoint})),server:effective,tools:input.tools}));
        if(!result.configured)result.blockers.push('Another Codex configuration layer overrides the reviewed Rootlane repair. Inspect the effective configuration before retrying.');
      }
      if(input.action==='verify') {
        const thread=await rpc.call('thread/start',{ephemeral:true,cwd:input.home,sandbox:'read-only'});
        const status=await rpc.call('mcpServerStatus/list',{threadId:thread.thread.id,serverName:'rootlane',detail:'toolsAndAuthOnly',limit:100});
        const registered=status.data?.find((s:any)=>s.name==='rootlane');
        result.tools=Object.keys(registered?.tools ?? {});result.connectionChecked=result.tools.length>0;
        result.missingTools=input.tools.filter(tool=>!result.tools.includes(tool));
        result.configured &&= !result.missingTools.length;
        if(result.tools.includes('list_projects')) {
          const call=await rpc.call('mcpServer/tool/call',{threadId:thread.thread.id,server:'rootlane',tool:'list_projects',arguments:{limit:1}});
          result.toolCallVerified=structuredResult(call);
        }
      }
    } finally {rpc.close();}
  } else {
    const settings=settingsText?JSON.parse(settingsText):{},config=contents?JSON.parse(contents):{};
    result.configured=registration(config.mcpServers?.rootlane,input.adapter);
    const signalKeys=['METRICS','LOGS'].flatMap(signal=>['ENDPOINT','HEADERS','PROTOCOL'].map(key=>`OTEL_EXPORTER_OTLP_${signal}_${key}`));
    const foreignEndpoint=Object.entries(settings.env ?? {}).some(([key,value])=>{
      if(!/^OTEL_EXPORTER_OTLP(?:_(?:METRICS|LOGS))?_ENDPOINT$/.test(key) || !value)return false;
      try{return new URL(String(value)).origin!==input.endpoint;}catch{return true;}
    });
    const foreignExporter=['OTEL_METRICS_EXPORTER','OTEL_LOGS_EXPORTER'].some(key=>settings.env?.[key] && !['none','otlp'].includes(settings.env[key]));
    if(input.telemetry && (foreignEndpoint || foreignExporter) && !input.replaceExporters)result.blockers.push('An existing Claude telemetry exporter requires explicit replacement review.');
    if(input.action==='apply') {
      if(result.blockers.length)throw new Error(result.blockers.join('; '));
      if(hash(await read(configPath))!==hash(contents))throw new Error('Claude registration changed during review');
      if(config.mcpServers?.rootlane && !result.configured)await atomicJson(configPath,{...config,mcpServers:{...config.mcpServers,rootlane:{type:'stdio',command:input.adapter,args:[]}}},hash(contents));
      else if(!result.configured)execFileSync(executable,['mcp','add','--transport','stdio','--scope','user','rootlane','--',input.adapter],{env:clientEnv,stdio:'ignore',timeout:10000});
      if(input.telemetry) {
        if(!input.token || !input.endpoint)throw new Error('Opt in to the receiver before configuring client telemetry');
        if(input.replaceExporters)for(const key of signalKeys)delete settings.env?.[key];
        settings.env={...settings.env,CLAUDE_CODE_ENABLE_TELEMETRY:'1',OTEL_METRICS_EXPORTER:'otlp',OTEL_LOGS_EXPORTER:'otlp',OTEL_EXPORTER_OTLP_PROTOCOL:'http/json',OTEL_EXPORTER_OTLP_ENDPOINT:input.endpoint+'/otlp',OTEL_EXPORTER_OTLP_HEADERS:`Authorization=Bearer ${input.token}`,OTEL_LOG_USER_PROMPTS:'false',OTEL_LOG_TOOL_DETAILS:'false'};
        await atomicJson(settingsPath,settings,hash(settingsText));
      }
      result.configured=registration(JSON.parse(await read(configPath)).mcpServers?.rootlane,input.adapter);
      if(!result.configured)throw new Error('Claude did not save the reviewed registration');
    }
    if(input.action==='verify') {
      const readTool='mcp__rootlane__list_projects';
      try {
        const {stdout}=await promisify(execFile)(executable,['--print','--verbose','--output-format','stream-json','--no-session-persistence','--disable-slash-commands','--setting-sources','user','--settings',JSON.stringify({disableAllHooks:true}),'--strict-mcp-config','--mcp-config',JSON.stringify({mcpServers:{rootlane:{type:'stdio',command:input.adapter,args:[]}}}),'--tools','','--allowedTools',readTool,'--disallowedTools',input.tools.filter(tool=>tool!=='list_projects').map(tool=>'mcp__rootlane__'+tool).join(','),'--permission-mode','dontAsk','--max-turns','3','--max-budget-usd','1','Call mcp__rootlane__list_projects with limit 1 once. Return only its result. Do not call any other tool.'],{env:clientEnv,cwd:input.home,encoding:'utf8',timeout:45000,maxBuffer:1048576});
        const calls=new Set<string>();
        for(const line of stdout.split('\n')) {
          let event:any;try{event=JSON.parse(line);}catch{continue;}
          if(event.type==='system' && event.mcp_servers?.some((server:any)=>server.name==='rootlane' && server.status==='connected'))result.connectionChecked=true;
          for(const item of event.message?.content ?? []) {
            if(event.type==='assistant' && item.type==='tool_use' && item.name===readTool)calls.add(item.id);
            if(event.type==='user' && item.type==='tool_result' && calls.has(item.tool_use_id) && structuredResult(item))result.toolCallVerified=true;
          }
        }
        if(result.toolCallVerified){result.connectionChecked=true;result.tools=['list_projects'];}
      }catch {/* Authentication, timeouts and client errors cannot establish a tool call. */}
      if(!result.toolCallVerified)result.blockers.push('Authenticated Claude read-only tool call was not verified. Check sign-in and retry.');
    }
  }
  return result;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const [inputPath,outputPath]=process.argv.slice(2);
  try {const result=await integrate(JSON.parse(await readFile(inputPath,'utf8')));await writeFile(outputPath,JSON.stringify({result}),{mode:0o600});}
  catch {await writeFile(outputPath,JSON.stringify({error:'Client operation failed or configuration changed. Inspect the client version, registration and revisions before retrying.'}),{mode:0o600});process.exitCode=1;}
}
