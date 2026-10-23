import { readFile, readlink, access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { command } from './command.js';
import type { Host, Unit, Preview, Listener } from './types.js';
import type { Service } from '../config.js';
import { Problem } from '../shared/contracts.js';
import { ServeRoutes, routeState } from './routes.js';
export { routeState } from './routes.js';
import { procText, processStat, processClock, startedAt, serviceName } from './process.js';
import { observeAgents } from './agents.js';

export async function boundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) throw new Problem('OUTPUT_LIMIT', 'Upstream response exceeds the allowed size');
      parts.push(chunk.value);
    }
    return Buffer.concat(parts).toString('utf8');
  } finally {
    await reader.cancel();
  }
}
export class LinuxHost implements Host {
  private tools: {expires:number;node:string;value:Promise<Record<string,string>>}|undefined;
  toolchains(node:string) {
    if(this.tools && this.tools.node===node && this.tools.expires>Date.now())return this.tools.value;
    const script="const fs=require('node:fs'),p=require('node:path');const roots=[p.dirname(process.execPath),...(process.env.PATH||'/usr/local/bin:/usr/bin:/bin').split(':')];const out={node:process.execPath};for(const name of ['python3','npm','pnpm','yarn','bun'])for(const root of roots){const file=p.join(root,name);try{fs.accessSync(file,fs.constants.X_OK);out[name==='python3'?'python':name]=fs.realpathSync(file);break;}catch{}}console.log(JSON.stringify(out));";
    const value=command('systemd-run',['--user','--no-ask-password','--quiet','--pipe','--wait','--collect','--property=RuntimeMaxSec=5s','--expand-environment=no','--',node,'-e',script],{timeout:8000,maxBuffer:16384}).then(text=>{
      const value=JSON.parse(text);if(!value || typeof value!=='object' || Object.values(value).some(v=>typeof v!=='string' || !v.startsWith('/')))throw new Problem('TOOLCHAIN_MISSING','Host toolchain probe returned invalid paths');return value as Record<string,string>;
    });
    this.tools={expires:Date.now()+30000,node,value};return value;
  }
  private async checkServices(services:Pick<Service,'cwd'|'executable'>[]) {
    if(this.tools?.node) {
      const script="const fs=require('node:fs'),p=require('node:path');const wrappers=new Set(['env','sh','bash','dash','zsh','fish','ksh','csh','tcsh','pwsh','powershell']);for(const s of JSON.parse(process.argv[1])){fs.accessSync(s.executable,fs.constants.X_OK);fs.accessSync(s.cwd,fs.constants.R_OK|fs.constants.X_OK);if(wrappers.has(p.basename(fs.realpathSync(s.executable))))process.exit(1);}";
      await command('systemd-run',['--user','--no-ask-password','--quiet','--pipe','--wait','--collect','--property=RuntimeMaxSec=5s','--expand-environment=no','--',this.tools.node,'-e',script,JSON.stringify(services.map(s=>({cwd:s.cwd,executable:s.executable})))],{timeout:8000,maxBuffer:4096});
      return;
    }
    for(const service of services){await access(service.executable,constants.X_OK);await access(service.cwd,constants.R_OK|constants.X_OK);}
  }
  private serve = new ServeRoutes();
  agents = observeAgents;
  guardedRoutes() {
    return this.serve.guarded();
  }
  async probe(url: string, readiness: Service['readiness']) {
    try {
      const response = await fetch(new URL(readiness.path, url), { redirect: 'error', signal: AbortSignal.timeout(1500) });
      if (response.status !== readiness.status) {
        await response.body?.cancel();
        return false;
      }
      return (await boundedText(response, 16384)).includes(readiness.bodyIncludes);
    } catch {
      return false;
    }
  }
  bootId() {
    return readFile('/proc/sys/kernel/random/boot_id', 'utf8').then((s) => s.trim());
  }
  async capabilities(services: Service[]) {
    try {await this.checkServices(services);}catch{throw new Problem('MISSING_CAPABILITY','A service executable or directory is unavailable on the host, or resolves to a shell/env wrapper');}
    await command('systemctl', ['--user', 'show', '--property=Version']);
    const help = await command('systemd-run', ['--help']);
    if (!help.includes('--expand-environment')) throw new Problem('MISSING_CAPABILITY', 'systemd-run requires --expand-environment support');
    await this.routes();
    await this.listeners();
  }
  async listeners(): Promise<Listener[]> {
    const output = await command('ss', ['-H', '-ltnp'], { timeout: 2000 });
    const clock = await processClock();
    const deadline = Date.now() + 2000;
    return Promise.all(
      output
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(0, 1024)
        .map(async (line) => {
          const local = line.trim().split(/\s+/)[3];
          const match = local?.match(/^(.*):(\d+)$/);
          if (!match) throw new Problem('LISTENER_FORMAT', 'Cannot interpret listener metadata');
          const pidMatch = line.match(/pid=(\d+)/);
          const pid = pidMatch ? Number(pidMatch[1]) : null;
          let cwd: string | null = null;
          let cgroup: string | null = null;
          let processInfo: Listener['process'];
          if (pid && Date.now() < deadline) {
            try {
              if ((await stat(`/proc/${pid}`)).uid !== process.getuid!()) throw new Error('Other user');
              const before = processStat(await procText(`/proc/${pid}/stat`));
              cwd = await readlink(`/proc/${pid}/cwd`);
              cgroup =
                (await procText(`/proc/${pid}/cgroup`))
                  .split('\n')
                  .find((s) => s.startsWith('0::'))
                  ?.slice(3) ?? null;
              const comm = await procText(`/proc/${pid}/comm`, 256);
              const argv = (await procText(`/proc/${pid}/cmdline`, 16384)).split('\0');
              const after = processStat(await procText(`/proc/${pid}/stat`));
              if (!before || before.ticks !== after?.ticks || (await stat(`/proc/${pid}`)).uid !== process.getuid!())
                throw new Error('Process changed');
              processInfo = {
                name: serviceName(comm, argv),
                pid,
                ...(startedAt(before.ticks, clock) ? { startedAt: startedAt(before.ticks, clock) } : {}),
              };
            } catch {
              cwd = null;
              cgroup = null;
              processInfo = undefined;
            }
          }
          return {
            address: match[1].replace(/^\[|\]$/g, ''),
            port: Number(match[2]),
            pid,
            cwd,
            cgroup,
            ...(processInfo ? { process: processInfo } : {}),
          };
        }),
    );
  }
  async inspectUnit(name: string) {
    const output = await command('systemctl', ['--user', 'show', name, '--property=LoadState,ActiveState,Description,ControlGroup,InvocationID,NRestarts,ExecMainStatus,Result,Restart'], {
      allowedExitCodes: [1],
    });
    const props = Object.fromEntries(
      output
        .trim()
        .split('\n')
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i), l.slice(i + 1)];
        }),
    );
    if (props.LoadState === 'not-found') return null;
    if (!props.LoadState || !props.ActiveState) throw new Problem('UNIT_STATE', `Cannot inspect ${name}`);
    return { state: props.ActiveState, marker: props.Description, cgroup: props.ControlGroup, invocation: props.InvocationID,
      ...(props.NRestarts ? {restarts:Number(props.NRestarts)} : {}), ...(props.ExecMainStatus ? {exitCode:Number(props.ExecMainStatus)} : {}),
      ...(props.Result ? {result:props.Result} : {}), ...(props.Restart ? {restart:props.Restart} : {}) };
  }
  async startUnit(unit: Unit, service: Service) {
    await this.checkServices([service]);
    if (await this.inspectUnit(unit.name)) throw new Problem('OWNERSHIP_CONFLICT', `Unit ${unit.name} already exists`);
    await command('systemd-run', [
      '--user',
      '--no-ask-password',
      '--quiet',
      `--unit=${unit.name}`,
      `--description=${unit.marker}`,
      '--service-type=exec',
      '--expand-environment=no',
      `--working-directory=${service.cwd.replaceAll('%', '%%')}`,
      '--property=KillMode=control-group',
      '--property=TimeoutStopSec=10s',
      `--property=Restart=${service.restart ?? 'no'}`,
      ...(service.restart === 'on-failure' ? ['--property=RestartSec=2s','--property=StartLimitIntervalSec=60s','--property=StartLimitBurst=3'] : []),
      '--property=StandardOutput=journal',
      '--property=StandardError=journal',
      ...(service.envFile ? [`--property=EnvironmentFile=${service.envFile.replaceAll('%', '%%')}`] : []),
      ...Object.entries(service.env ?? {}).map(([key, value]) => `--setenv=${key}=${value}`),
      '--',
      service.executable,
      ...service.args,
    ]);
  }
  async runPreparation(unit: Unit, step: {command:string[];cwd:string;timeoutMs:number}) {
    await this.checkServices([{cwd:step.cwd,executable:step.command[0]}]);
    if (await this.inspectUnit(unit.name)) throw new Problem('OWNERSHIP_CONFLICT','Preparation unit already exists');
    const ownerHome = process.env.ROOTLANE_OWNER_HOME ?? process.env.HOME ?? '/tmp';
    await command('systemd-run',[
      '--user','--no-ask-password','--quiet',`--unit=${unit.name}`,`--description=${unit.marker}`,
      '--service-type=exec','--expand-environment=no',`--working-directory=${step.cwd.replaceAll('%','%%')}`,
      '--property=RemainAfterExit=yes','--property=KillMode=control-group','--property=TimeoutStopSec=10s',
      `--property=RuntimeMaxSec=${Math.ceil(step.timeoutMs/1000)}s`,'--property=Restart=no',
      '--property=StandardOutput=journal','--property=StandardError=journal',
      '--','/usr/bin/env','-i',`HOME=${ownerHome}`,`PATH=${dirname(this.tools?.node ?? step.command[0])}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
      ...step.command,
    ]);
    try {
      const deadline = Date.now() + step.timeoutMs;
      while (Date.now() < deadline) {
        const current = await this.inspectUnit(unit.name);
        if (!current || current.marker !== unit.marker) throw new Problem('OWNERSHIP_CONFLICT','Preparation ownership could not be verified');
        if (current.state === 'failed' || (current.exitCode !== undefined && current.exitCode !== 0)) throw new Problem('PREPARATION_FAILED',`Preparation failed (${current.result ?? 'exit'}; status ${current.exitCode ?? 'unknown'}). Inspect ${unit.name} in the host journal.`);
        // RemainAfterExit preserves successful short jobs until ownership and exit status are checked.
        const sub = await command('systemctl',['--user','show',unit.name,'--property=SubState','--value']);
        if (current.state === 'active' && sub.trim() === 'exited') return;
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      throw new Problem('PREPARATION_TIMEOUT',`Preparation exceeded ${step.timeoutMs} ms`);
    } finally { await this.stopUnit(unit); }
  }
  async stopUnit(unit: Unit) {
    const current = await this.inspectUnit(unit.name);
    if (!current) return;
    if (current.marker !== unit.marker) throw new Problem('OWNERSHIP_CONFLICT', `Unit ${unit.name} ownership changed`);
    await command('systemctl', ['--user', '--no-ask-password', 'stop', unit.name], { timeout: 15000 });
    const after = await this.inspectUnit(unit.name);
    if (after && (after.marker !== unit.marker || !['inactive', 'failed'].includes(after.state)))
      throw new Problem('STOP_FAILED', `Unit ${unit.name} did not stop`);
    if (current.cgroup) {
      try {
        const events = await readFile(`/sys/fs/cgroup${current.cgroup}/cgroup.events`, 'utf8');
        if (/^populated 1$/m.test(events)) throw new Problem('STOP_FAILED', `Processes remain in ${unit.name}'s control group`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (after?.state === 'failed') await command('systemctl', ['--user', 'reset-failed', unit.name]);
  }
  async ready(unit: Unit) {
    const current = await this.inspectUnit(unit.name);
    if (!current || current.marker !== unit.marker || current.state !== 'active' || !current.cgroup) return false;
    const listeners = await this.listeners();
    const owned = listeners.filter((l) => l.cgroup === current.cgroup || l.cgroup?.startsWith(`${current.cgroup}/`));
    if (owned.some((l) => ['0.0.0.0', '::', '*'].includes(l.address)))
      throw new Problem('PUBLIC_BINDING', 'bind the dev server to 127.0.0.1 (e.g. --host 127.0.0.1)');
    if (!owned.some((l) => l.port === unit.port && ['127.0.0.1', '::1'].includes(l.address))) return false;
    if (new Set(owned.map((l) => l.pid)).size !== 1) return false;
    if (owned.some((l) => l.port !== unit.port || !['127.0.0.1', '::1'].includes(l.address)))
      throw new Problem('UNEXPECTED_BINDING', `${unit.serviceId} must bind only 127.0.0.1:${unit.port}`);
    try {
      const response = await fetch(
        `http://${owned.some((l) => l.address === '127.0.0.1') ? '127.0.0.1' : '[::1]'}:${unit.port}${unit.readiness.path}`,
        { redirect: 'error', signal: AbortSignal.timeout(1500) },
      );
      if (response.status !== unit.readiness.status) {
        await response.body?.cancel();
        return false;
      }
      return (await boundedText(response, 16384)).includes(unit.readiness.bodyIncludes);
    } catch {
      return false;
    }
  }
  routes(): Promise<unknown> {
    return this.serve.read();
  }
  routeState = routeState;
  addRoute(route: Preview) {
    return this.serve.change(route, false);
  }
  removeRoute(route: Preview) {
    return this.serve.change(route, true);
  }
  async logs(unit: Unit, cursor: string | undefined, limit: number, redact = (value: string) => value) {
    if (!unit.invocation) return { lines: [], nextCursor: null, truncated: false };
    const args = [
      '--user',
      '--no-pager',
      '--output=json',
      '--output-fields=MESSAGE,__CURSOR,__REALTIME_TIMESTAMP',
      `--unit=${unit.name}`,
      `_SYSTEMD_INVOCATION_ID=${unit.invocation}`,
      `--lines=${limit + 1}`,
    ];
    if (cursor) { args[args.length - 1] = `--lines=+${limit + 1}`; args.push(`--after-cursor=${cursor}`); }
    const output = await command('journalctl', args, { maxBuffer: 512 * 1024 });
    const entries = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(0, 1024)
      .map((s) => JSON.parse(s) as { MESSAGE?: unknown; __CURSOR?: string; __REALTIME_TIMESTAMP?: string });
    // Journal tails are bounded; callers get a cursor for subsequent output, not historical replay.
    const selected = cursor ? entries.slice(0,limit) : entries.slice(-limit);
    return {
      lines: selected.map((e) => {
        const millis = Number(e.__REALTIME_TIMESTAMP) / 1000;
        const stamp = e.__REALTIME_TIMESTAMP && Number.isFinite(millis) && millis > 0 && millis < 8640000000000000 ? new Date(millis).toISOString() + ' ' : '';
        return (stamp + (typeof e.MESSAGE === 'string' ? redact(e.MESSAGE) : '[non-text journal entry]')).slice(0,2048);
      }),
      nextCursor: selected.at(-1)?.__CURSOR ?? null,
      truncated: entries.length > limit || selected.some((e) => typeof e.MESSAGE === 'string' && e.MESSAGE.length > 2048),
    };
  }
  private connectionCache: { expires: number; value: { status: 'connected' | 'unavailable'; hostname: string | null } } | null = null;
  async connection(): Promise<{ status: 'connected' | 'unavailable'; hostname: string | null }> {
    if (this.connectionCache && this.connectionCache.expires > Date.now()) return this.connectionCache.value;
    try {
      const status = JSON.parse(await command('tailscale', ['status', '--json'])) as { BackendState?: string; Self?: { DNSName?: string } };
      const value = {
        status: status.BackendState === 'Running' ? ('connected' as const) : ('unavailable' as const),
        hostname: status.Self?.DNSName?.replace(/\.$/, '') ?? null,
      };
      this.connectionCache = { expires: Date.now() + 10000, value };
      return value;
    } catch {
      return { status: 'unavailable', hostname: null };
    }
  }
}
