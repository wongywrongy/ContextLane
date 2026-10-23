import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Problem, toolContracts } from '../shared/contracts.js';
import type { Rootlane } from '../service.js';
import type { IntegrationInput } from './runner.js';

export class Integrations {
  private busy = false;
  constructor(readonly service:Rootlane) {}
  async run(input:Pick<IntegrationInput,'client'|'action'|'fingerprint'|'telemetry'|'replaceExporters'>,token:string) {
    if(this.busy)throw new Problem('OPERATION_IN_PROGRESS','Wait for the current client inspection or repair');
    const {config,host,store}=this.service.lifecycle;
    if(!host.runPreparation)throw new Problem('MISSING_CAPABILITY','Host client integration support is unavailable');
    if(input.telemetry && (!config.telemetry.enabled || !token))throw new Problem('TELEMETRY_DISABLED','Opt in to the receiver and configure its credential before client setup');
    this.busy=true;
    const id=randomUUID(),directory=join(config.stateDirectory,'integrations',id);
    try {
      await mkdir(directory,{recursive:true,mode:0o700});
      const script=join(directory,'runner.mjs'),request=join(directory,'request.json'),output=join(directory,'result.json');
      await writeFile(script,await readFile(new URL('./runner.js',import.meta.url)),{mode:0o600,flag:'wx'});
      await writeFile(request,JSON.stringify({...input,home:process.env.ROOTLANE_OWNER_HOME ?? homedir(),adapter:process.env.ROOTLANE_MCP_ADAPTER ?? '/opt/stacks/rootlane/deploy/rootlane-mcp-docker',tools:Object.keys(toolContracts),endpoint:`http://127.0.0.1:${config.telemetry.port}`,...(input.telemetry ? {token} : {})}),{mode:0o600,flag:'wx'});
      try {
        await host.runPreparation({name:`rootlane-integration-${id}.service`,marker:`rootlane:${store.installation}:integration:${id}`,serviceId:'integration',port:0,readiness:{path:'/',status:200,bodyIncludes:'',timeoutMs:1000},invocation:null},{command:[process.env.ROOTLANE_HOST_NODE || config.toolchains.node || process.execPath,script,request,output],cwd:directory,timeoutMs:60000});
      } catch { /* Return only sanitized host results; journals may contain client diagnostics. */ }
      const response=JSON.parse(await readFile(output,'utf8').catch(()=>'{"error":"Host integration job failed; inspect systemd and the configured host Node executable."}'));
      if(response.error)throw new Problem('INTEGRATION_FAILED',response.error);
      const result=response.result;
      if(input.action==='verify')store.setMeta(`integration:${input.client}`,JSON.stringify(result));
      const verified=JSON.parse(store.meta(`integration:${input.client}`) ?? 'null');
      if(verified?.fingerprint===result.fingerprint){result.connectionChecked=verified.connectionChecked;result.toolCallVerified=verified.toolCallVerified;result.tools=verified.tools;}
      const telemetry=await this.service.telemetry.status();
      result.telemetry={receiverAvailable:telemetry.receiving,clientEventsReported:telemetry.reporting[input.client]>0,lastEventAt:telemetry.lastEventAt};
      return result;
    } finally {this.busy=false;await rm(directory,{recursive:true,force:true});}
  }
}
