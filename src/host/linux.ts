import { readFile, readlink, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { command } from './command.js';
import type { Host, Unit, Preview, Listener } from './types.js';
import type { Service } from '../config.js';
import { Problem } from '../shared/contracts.js';
import { observeAgents } from './agents.js';

export async function boundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return '';
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) throw new Problem('OUTPUT_LIMIT', 'Upstream response exceeds the allowed size');
      parts.push(chunk.value);
    }
    return Buffer.concat(parts).toString('utf8');
  } finally { await reader.cancel(); }
}
export function routeState(raw: unknown, route: Preview): 'absent' | 'matching' | 'conflict' {
  const config = raw as { TCP?: Record<string, unknown>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>; AllowFunnel?: Record<string, boolean> };
  if (!config || typeof config !== 'object') throw new Problem('ROUTE_CONFIG', 'Unrecognized Serve configuration');
  const key = `${route.hostname}:${route.port}`;
  const web = Object.entries(config.Web ?? {}).filter(([name]) => name.endsWith(`:${route.port}`));
  const tcp = config.TCP?.[String(route.port)];
  if (!web.length && !tcp && !config.AllowFunnel?.[key]) return 'absent';
  const handlers = config.Web?.[key]?.Handlers;
  const httpsOnly = tcp && typeof tcp === 'object' && (tcp as Record<string, unknown>).HTTPS === true && Object.keys(tcp).length === 1;
  return web.length === 1 && httpsOnly && !config.AllowFunnel?.[key] && handlers && Object.keys(handlers).length === 1 && handlers['/']?.Proxy === route.upstream && Object.keys(handlers['/']).length === 1 ? 'matching' : 'conflict';
}
export class LinuxHost implements Host {
  agents = observeAgents;
  bootId() { return readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(s => s.trim()); }
  async capabilities(services: Service[]) {
    for (const service of services) {
      try { await access(service.executable, constants.X_OK); await access(service.cwd, constants.R_OK | constants.X_OK); }
      catch { throw new Problem('MISSING_CAPABILITY', `${service.id}: executable or working directory is unavailable`); }
    }
    await command('systemctl', ['--user', 'show', '--property=Version']);
    const help = await command('systemd-run', ['--help']);
    if (!help.includes('--expand-environment')) throw new Problem('MISSING_CAPABILITY', 'systemd-run requires --expand-environment support');
    await this.routes(); await this.listeners();
  }
  async listeners(): Promise<Listener[]> {
    const output = await command('ss', ['-H', '-ltnp']);
    return Promise.all(output.trim().split('\n').filter(Boolean).map(async line => {
      const local = line.trim().split(/\s+/)[3];
      const match = local?.match(/^(.*):(\d+)$/);
      if (!match) throw new Problem('LISTENER_FORMAT', 'Cannot interpret listener metadata');
      const pidMatch = line.match(/pid=(\d+)/); const pid = pidMatch ? Number(pidMatch[1]) : null;
      let cwd: string | null = null; let cgroup: string | null = null;
      if (pid) {
        try { cwd = await readlink(`/proc/${pid}/cwd`); cgroup = (await readFile(`/proc/${pid}/cgroup`, 'utf8')).split('\n').find(s => s.startsWith('0::'))?.slice(3) ?? null; } catch { /* Processes may exit or be owned by another user. */ }
      }
      return { address: match[1].replace(/^\[|\]$/g, ''), port: Number(match[2]), pid, cwd, cgroup };
    }));
  }
  async inspectUnit(name: string) {
    const output = await command('systemctl', ['--user', 'show', name, '--property=LoadState,ActiveState,Description,ControlGroup,InvocationID'], { allowedExitCodes: [1] });
    const props = Object.fromEntries(output.trim().split('\n').map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
    if (props.LoadState === 'not-found') return null;
    if (!props.LoadState || !props.ActiveState) throw new Problem('UNIT_STATE', `Cannot inspect ${name}`);
    return { state: props.ActiveState, marker: props.Description, cgroup: props.ControlGroup, invocation: props.InvocationID };
  }
  async startUnit(unit: Unit, service: Service) {
    await access(service.executable, constants.X_OK);
    if (await this.inspectUnit(unit.name)) throw new Problem('OWNERSHIP_CONFLICT', `Unit ${unit.name} already exists`);
    await command('systemd-run', ['--user', '--no-ask-password', '--quiet', `--unit=${unit.name}`, `--description=${unit.marker}`, '--service-type=exec', '--expand-environment=no', `--working-directory=${service.cwd.replaceAll('%', '%%')}`, '--property=KillMode=control-group', '--property=TimeoutStopSec=10s', '--property=Restart=no', '--property=StandardOutput=journal', '--property=StandardError=journal', '--', service.executable, ...service.args]);
  }
  async stopUnit(unit: Unit) {
    const current = await this.inspectUnit(unit.name); if (!current) return;
    if (current.marker !== unit.marker) throw new Problem('OWNERSHIP_CONFLICT', `Unit ${unit.name} ownership changed`);
    await command('systemctl', ['--user', '--no-ask-password', 'stop', unit.name], { timeout: 15000 });
    const after = await this.inspectUnit(unit.name);
    if (after && (after.marker !== unit.marker || !['inactive', 'failed'].includes(after.state))) throw new Problem('STOP_FAILED', `Unit ${unit.name} did not stop`);
    if (current.cgroup) {
      try {
        const events = await readFile(`/sys/fs/cgroup${current.cgroup}/cgroup.events`, 'utf8');
        if (/^populated 1$/m.test(events)) throw new Problem('STOP_FAILED', `Processes remain in ${unit.name}'s control group`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (after?.state === 'failed') await command('systemctl', ['--user', 'reset-failed', unit.name]);
  }
  async ready(unit: Unit) {
    const current = await this.inspectUnit(unit.name);
    if (!current || current.marker !== unit.marker || current.state !== 'active' || !current.cgroup) return false;
    const listeners = await this.listeners();
    const owned = listeners.filter(l => l.cgroup === current.cgroup || l.cgroup?.startsWith(`${current.cgroup}/`));
    if (!owned.some(l => l.port === unit.port && l.address === '127.0.0.1')) return false;
    if (owned.some(l => l.port !== unit.port || l.address !== '127.0.0.1')) throw new Problem('UNEXPECTED_BINDING', `${unit.serviceId} must bind only 127.0.0.1:${unit.port}`);
    try {
      const response = await fetch(`http://127.0.0.1:${unit.port}${unit.readiness.path}`, { redirect: 'error', signal: AbortSignal.timeout(1500) });
      if (response.status !== unit.readiness.status) { await response.body?.cancel(); return false; }
      return (await boundedText(response, 16384)).includes(unit.readiness.bodyIncludes);
    } catch { return false; }
  }
  async routes(): Promise<unknown> { return JSON.parse(await command('tailscale', ['serve', 'status', '--json'])); }
  routeState = routeState;
  async addRoute(route: Preview) {
    if (routeState(await this.routes(), route) !== 'absent') throw new Problem('ROUTE_CONFLICT', `HTTPS port ${route.port} is already configured`);
    await command('tailscale', ['serve', '--bg', '--yes', `--https=${route.port}`, route.upstream]);
    if (routeState(await this.routes(), route) !== 'matching') throw new Problem('PREVIEW_UNAVAILABLE', `HTTPS port ${route.port} does not match its reserved upstream`);
  }
  async removeRoute(route: Preview) {
    const state = routeState(await this.routes(), route); if (state === 'absent') return;
    if (state !== 'matching') throw new Problem('OWNERSHIP_CONFLICT', `HTTPS port ${route.port} configuration changed`);
    await command('tailscale', ['serve', `--https=${route.port}`, 'off']);
    if (routeState(await this.routes(), route) !== 'absent') throw new Problem('STOP_FAILED', `HTTPS port ${route.port} remains configured`);
  }
  async logs(unit: Unit, cursor: string | undefined, limit: number) {
    if (!unit.invocation) return { lines: [], nextCursor: null, truncated: false };
    const args = ['--user', '--no-pager', '--output=json', '--output-fields=MESSAGE,__CURSOR', `--unit=${unit.name}`, `_SYSTEMD_INVOCATION_ID=${unit.invocation}`, `--lines=${limit + 1}`];
    if (cursor) args.push(`--after-cursor=${cursor}`);
    const output = await command('journalctl', args, { maxBuffer: 512 * 1024 });
    const entries = output.trim().split('\n').filter(Boolean).map(s => JSON.parse(s) as { MESSAGE?: unknown; __CURSOR?: string });
    // Journal tails are bounded; callers get a cursor for subsequent output, not historical replay.
    const selected = entries.slice(-limit);
    return { lines: selected.map(e => typeof e.MESSAGE === 'string' ? e.MESSAGE.slice(0, 2048) : '[non-text journal entry]'), nextCursor: selected.at(-1)?.__CURSOR ?? null, truncated: entries.length > limit || selected.some(e => typeof e.MESSAGE === 'string' && e.MESSAGE.length > 2048) };
  }
  async connection(): Promise<{ status: 'connected' | 'unavailable'; hostname: string | null }> {
    try {
      const status = JSON.parse(await command('tailscale', ['status', '--json'])) as { BackendState?: string; Self?: { DNSName?: string } };
      return { status: status.BackendState === 'Running' ? 'connected' : 'unavailable', hostname: status.Self?.DNSName?.replace(/\.$/, '') ?? null };
    } catch { return { status: 'unavailable', hostname: null }; }
  }
}
