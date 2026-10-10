import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { configSchema, type Service } from '../src/config.js';
import { Store } from '../src/state/store.js';
import { Lifecycle } from '../src/lifecycle/service.js';
import { Problem } from '../src/shared/contracts.js';
import type { Host, Unit, UnitState, Preview, Listener } from '../src/host/types.js';
export class FakeHost implements Host {
  agentObservations: { agents: import('../src/host/types.js').AgentObservation[]; warnings: string[] } = { agents: [], warnings: [] };
  async agents() { return this.agentObservations; }
  units = new Map<string, UnitState>(); routesMap = new Map<number, string>(); busyPorts: number[] = [];
  starts = 0; stops: string[] = []; failService = ''; unready = ''; failPreview = false; failStop = false; missing = false; boot = 'boot-1';
  async bootId() { return this.boot; }
  async capabilities() { if (this.missing) throw new Problem('MISSING_CAPABILITY', 'systemd unavailable'); }
  async listeners(): Promise<Listener[]> { return this.busyPorts.map(port => ({ address: '127.0.0.1', port, pid: null, cwd: null, cgroup: null })); }
  async inspectUnit(name: string) { return this.units.get(name) ?? null; }
  async startUnit(unit: Unit, service: Service) {
    this.starts++;
    if (service.id === this.failService) throw new Problem('START_FAILED', 'fixture startup failed');
    if (this.units.has(unit.name)) throw new Problem('OWNERSHIP_CONFLICT', 'Existing unit');
    this.units.set(unit.name, { state: 'active', marker: unit.marker, invocation: randomUUID().replaceAll('-', ''), cgroup: `/${unit.name}` });
  }
  async stopUnit(unit: Unit) {
    const current = this.units.get(unit.name); if (!current) return;
    if (current.marker !== unit.marker) throw new Problem('OWNERSHIP_CONFLICT', 'Unit ownership changed');
    if (this.failStop) throw new Problem('STOP_FAILED', 'Cannot stop unit');
    this.stops.push(unit.name); this.units.delete(unit.name);
  }
  async ready(unit: Unit) { return this.units.get(unit.name)?.marker === unit.marker && this.unready !== unit.serviceId; }
  async routes() { return new Map(this.routesMap); }
  routeState(config: unknown, route: Preview): 'absent' | 'matching' | 'conflict' { const upstream = (config as Map<number, string>).get(route.port); return upstream === undefined ? 'absent' : upstream === route.upstream ? 'matching' : 'conflict'; }
  async addRoute(route: Preview) { if (this.failPreview) throw new Problem('PREVIEW_UNAVAILABLE', 'preview unavailable'); if (this.routesMap.has(route.port)) throw new Problem('ROUTE_CONFLICT', 'Existing route'); this.routesMap.set(route.port, route.upstream); }
  async removeRoute(route: Preview) { if (this.routeState(await this.routes(), route) === 'conflict') throw new Problem('OWNERSHIP_CONFLICT', 'Route changed'); this.routesMap.delete(route.port); }
  async logs(_unit: Unit, _cursor: string | undefined, limit: number) { return { lines: Array.from({ length: limit }, (_, i) => `fixture line ${i}`), nextCursor: 's=test;i=1', truncated: true }; }
  async connection() { return { status: 'connected' as const, hostname: 'neo.example.ts.net' }; }
}
export async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rootlane-test-'));
  const config = configSchema.parse({ projectRoots: [root], observationRoots: [root], stateDirectory: root, origin: 'https://neo.example.ts.net:19483', tailnetHostname: 'neo.example.ts.net', profiles: [{ id: 'fixture', projectPath: root, approved: true, effects: 'Starts two disposable services and a private route.', dataRequirements: 'None', services: [{ id: 'api', cwd: root, executable: '/usr/bin/node', args: [], port: 19481, readiness: { path: '/health', bodyIncludes: 'api', timeoutMs: 100 } }, { id: 'web', cwd: root, executable: '/usr/bin/node', args: [], port: 19482, dependencies: ['api'], readiness: { path: '/', bodyIncludes: 'web', timeoutMs: 100 } }], previews: [{ serviceId: 'web', httpsPort: 19484, label: 'Fixture' }] }] });
  const store = new Store(join(root, 'state.sqlite')); const host = new FakeHost(); const lifecycle = new Lifecycle(config, store, host);
  await lifecycle.reconcile();
  t.after(async () => { await lifecycle.drain(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, config, store, host, lifecycle };
}
export const request = (environmentId = 'fixture') => ({ environmentId, requestId: randomUUID() });
