import { routeLock } from '../host/routes.js';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { orderedServices, revision, type Config, type Profile } from '../config.js';
import { Store, type Resource, type Observation } from '../state/store.js';
import { Problem, problem, mutation, environmentInput, logsInput, type Environment } from '../shared/contracts.js';
import type { Host, Preview, Unit } from '../host/types.js';

export class Lifecycle {
  private tasks = new Map<string, Promise<void>>();
  private reconciling = true;
  constructor(readonly config: Config, readonly store: Store, readonly host: Host) { for (const p of config.profiles) store.ensure(p); }
  private routeLock<T>(work: () => Promise<T>): Promise<T> {
    return routeLock(this.host, work);
  }
  private profile(id: string): Profile {
    const profile = this.config.profiles.find(p => p.id === id);
    if (!profile) throw new Problem('PROFILE_NOT_APPROVED', `No approved profile for ${id}`);
    return profile;
  }
  private exists(id: string) { if (!this.store.environment(id)) throw new Problem('NOT_FOUND', `No Rootlane-owned environment ${id}`); }
  accept(action: 'start' | 'stop', input: unknown) {
    const { environmentId, requestId } = mutation.parse(input); this.exists(environmentId);
    const prior = this.store.retry(environmentId, action, requestId);
    if (prior) return { operation: prior, ownership: 'rootlane' as const };
    if (this.reconciling) throw new Problem('RECONCILING', 'Host reconciliation must finish before lifecycle actions');
    if (action === 'start') this.profile(environmentId);
    const result = this.store.accept(environmentId, action, requestId);
    if (result.fresh) {
      const task = Promise.resolve().then(async () => {
        this.store.finish(result.operation.id, 'running');
        try {
          if (action === 'start') await this.start(environmentId, result.operation.id);
          else await this.stop(environmentId, result.operation.id);
        } catch (error) {
          if (!(error instanceof Problem)) console.error('Rootlane operation failed:', error instanceof Error ? error.message.slice(0, 2048) : 'Unknown error');
          this.store.finish(result.operation.id, 'failed', problem(error));
        }
      }).finally(() => this.tasks.delete(environmentId));
      this.tasks.set(environmentId, task);
    }
    return { operation: result.operation, ownership: 'rootlane' as const };
  }
  get available() { return !this.reconciling; }
  async drain() { await Promise.all(this.tasks.values()); }
  private unit(profile: Profile, serviceId: string, operation: string): Unit {
    const svc = profile.services.find(s => s.id === serviceId)!;
    const hash = createHash('sha256').update(`${profile.id}/${svc.id}`).digest('hex').slice(0, 20);
    return { name: `rootlane-${this.store.installation}-${hash}.service`, marker: `rootlane:${this.store.installation}:${operation}:${svc.id}`, serviceId: svc.id, port: svc.port, readiness: svc.readiness, invocation: null };
  }
  private async start(id: string, operation: string) {
    const profile = this.profile(id);
    await this.host.capabilities(profile.services);
    const connection = await this.host.connection();
    if (connection.status !== 'connected' || connection.hostname !== this.config.tailnetHostname) throw new Problem('MISSING_CAPABILITY', 'The configured Tailscale node is not connected');
    if (this.store.resources(id).length) {
      const state = await this.get({ environmentId: id });
      if (state.profileRevision === revision(profile) && state.application === 'ready' && state.preview === 'available') { this.store.finish(operation, 'succeeded'); return; }
      throw new Problem('NEEDS_STOP', 'Existing resources are not fully healthy or the profile changed; stop before starting again');
    }
    const units = orderedServices(profile).map(s => this.unit(profile, s.id, operation));
    const routes: Preview[] = profile.previews.map(p => ({ hostname: this.config.tailnetHostname, port: p.httpsPort, upstream: `http://127.0.0.1:${profile.services.find(s => s.id === p.serviceId)!.port}`, label: p.label }));
    await this.routeLock(async () => {
      const live = await this.host.listeners(); const config = await this.host.routes();
      for (const port of [...units.map(u => u.port), ...routes.map(r => r.port)]) if (live.some(l => l.port === port)) throw new Problem('PORT_CONFLICT', `TCP port ${port} is already bound`);
      for (const unit of units) if (await this.host.inspectUnit(unit.name)) throw new Problem('OWNERSHIP_CONFLICT', `${unit.name} already exists`);
      for (const route of routes) if (this.host.routeState(config, route) !== 'absent') throw new Problem('ROUTE_CONFLICT', `HTTPS port ${route.port} is already configured`);
      this.store.reserve(profile, operation, [...units.map(u => ({ kind: 'unit' as const, data: u, keys: [`tcp:${u.port}`, `unit:${u.name}`] })), ...routes.map(r => ({ kind: 'route' as const, data: r, keys: [`tcp:${r.port}`] }))]);
    });
    try {
      for (const row of this.store.resources(id).filter(r => r.kind === 'unit')) {
        const unit = JSON.parse(row.data) as Unit;
        const service = profile.services.find(s => s.id === unit.serviceId)!;
        this.store.attempted(row.id);
        await this.host.startUnit(unit, service);
        const current = await this.host.inspectUnit(unit.name);
        if (!current || current.marker !== unit.marker) throw new Problem('START_FAILED', `Cannot verify ${unit.serviceId} ownership`);
        unit.invocation = current.invocation; this.store.updateData(row.id, unit);
        const deadline = Date.now() + service.readiness.timeoutMs;
        let ready = false;
        while (Date.now() < deadline) {
          if (await this.host.ready(unit)) { ready = true; break; }
          const status = await this.host.inspectUnit(unit.name);
          if (!status || status.state === 'failed' || status.state === 'inactive') throw new Problem('START_FAILED', `${unit.serviceId} exited before readiness`);
          await delay(150);
        }
        if (!ready) throw new Problem('READINESS_TIMEOUT', `${unit.serviceId} did not pass application readiness within ${service.readiness.timeoutMs}ms`);
      }
      for (const row of this.store.resources(id).filter(r => r.kind === 'unit')) if (!await this.host.ready(JSON.parse(row.data))) throw new Problem('START_FAILED', 'A dependency lost readiness during startup');
    } catch (error) {
      this.store.db.prepare('UPDATE operations SET error=? WHERE id=?').run(JSON.stringify(problem(error)), operation);
      const cleanup = await this.cleanup(id, operation);
      this.store.finish(operation, 'failed', cleanup.length ? { code: 'ROLLBACK_INCOMPLETE', message: `${problem(error).message}; ${cleanup.join('; ')}`.slice(0, 1024) } : problem(error));
      return;
    }
    try {
      await this.routeLock(async () => {
        for (const row of this.store.resources(id).filter(r => r.kind === 'route')) {
          const route = JSON.parse(row.data) as Preview;
          const port = Number(new URL(route.upstream).port);
          const listener = (await this.host.listeners()).filter(l => l.port === port);
          if (listener.length && listener.every(l => l.address === '::1')) { route.upstream = `http://[::1]:${port}`; this.store.updateData(row.id,route); }
          if (this.host.routeState(await this.host.routes(), route) !== 'absent') throw new Problem('ROUTE_CONFLICT', `HTTPS port ${route.port} changed before publication`);
          this.store.attempted(row.id);
          try { await this.host.addRoute(route); }
          catch (error) { if (error instanceof Problem && error.code === 'ROUTE_CONFLICT') this.store.attempted(row.id, 0); throw error; }
        }
      });
      this.store.finish(operation, 'succeeded');
    } catch (error) { this.store.finish(operation, 'partial', problem(error)); }
  }
  private async capture(row: Resource, unit: Unit) {
    try {
      const current = await this.host.inspectUnit(unit.name);
      if (current?.marker === unit.marker && current.invocation) { unit.invocation = current.invocation; this.store.updateData(row.id, unit); }
      const page = await this.host.logs(unit, undefined, 100); if (page.lines.length) this.store.saveLogs(row.id, page.lines);
    } catch { /* Preserve any previous failure snapshot if the journal is unavailable. */ }
  }
  private async cleanup(id: string, onlyOperation?: string): Promise<string[]> {
    const errors: string[] = [];
    const rows = this.store.resources(id).filter(r => !onlyOperation || r.operation === onlyOperation);
    await this.routeLock(async () => {
      for (const row of rows.filter(r => r.kind === 'route')) {
        try { if (row.attempted) await this.host.removeRoute(JSON.parse(row.data)); this.store.release(row.id); }
        catch (error) { errors.push(problem(error).message); }
      }
    });
    // Keep upstream ports reserved while any route could still direct traffic to them.
    const routesRemain = this.store.resources(id).some(r => r.kind === 'route');
    for (const row of rows.filter(r => r.kind === 'unit').reverse()) {
      try {
        if (row.attempted) {
          const unit = JSON.parse(row.data) as Unit; await this.capture(row, unit); await this.host.stopUnit(unit);
          const state = await this.host.inspectUnit(unit.name);
          if (state && (state.marker !== unit.marker || !['inactive', 'failed'].includes(state.state))) throw new Problem('STOP_FAILED', `${unit.name} teardown could not be verified`);
        }
        if (!routesRemain) this.store.release(row.id);
      } catch (error) { errors.push(problem(error).message); }
    }
    return errors;
  }
  private async stop(id: string, operation: string) {
    const errors = await this.cleanup(id);
    this.store.finish(operation, errors.length ? 'failed' : 'succeeded', errors.length ? { code: 'STOP_INCOMPLETE', message: errors.join('; ').slice(0, 1024) } : null);
  }
  async get(input: unknown): Promise<Environment> {
    const { environmentId: id } = environmentInput.parse(input); this.exists(id);
    const env = this.store.environment(id)!; const rows = this.store.resources(id);
    const observation = JSON.parse(env.observation) as Observation;
    const result: Environment = { id, profileRevision: env.revision, effects: observation.effects, dataRequirements: observation.dataRequirements, startAllowed: this.config.profiles.some(p => p.id === id), ownership: 'rootlane', desiredState: env.desired, application: 'unknown', preview: 'unknown', links: [], services: [], observedAt: new Date().toISOString(), latestOperation: this.store.latest(id), recentOperations: this.store.recent(id), previewRoutes: [], observationError: null };
    try {
      let healthy = 0; let absent = 0;
      for (const row of rows.filter(r => r.kind === 'unit')) {
        const unit = JSON.parse(row.data) as Unit; const current = await this.host.inspectUnit(unit.name);
        if (current && current.marker !== unit.marker) throw new Problem('OWNERSHIP_CONFLICT', `${unit.name} no longer matches recorded ownership`);
        result.services.push({ id: unit.serviceId, port: unit.port, unit: unit.name, state: current?.state ?? 'absent' });
        if (!current || current.state === 'inactive' || current.state === 'failed') absent++;
        if (await this.host.ready(unit)) healthy++;
      }
      const unitCount = rows.filter(r => r.kind === 'unit').length;
      result.application = unitCount === 0 || absent === unitCount ? 'stopped' : healthy === observation.services.length ? 'ready' : 'unhealthy';
      const config = await this.host.routes(); const routeRows = rows.filter(r => r.kind === 'route');
      for (const row of routeRows) {
        const route = JSON.parse(row.data) as Preview;
        const url = `https://${route.hostname}:${route.port}/`; const state = this.host.routeState(config, route);
        let https: 'verified' | 'unverified' | 'failed' = 'unverified';
        const verifiedKey = `verified:${row.id}`;
        if (row.attempted && state === 'matching') {
          result.links.push({ label: route.label, url });
          const service = observation.services.find(s => Number(new URL(route.upstream).port) === s.port);
          if (service && result.application === 'ready') {
            https = await this.host.probe(url, service.readiness) ? 'verified' : 'failed';
            if (https === 'verified') this.store.setMeta(verifiedKey, result.observedAt);
          }
        }
        const verifiedAt = this.store.meta(verifiedKey);
        result.previewRoutes!.push({ url, target: route.upstream, route: state, https, ...(verifiedAt ? { verifiedAt } : {}) });
      }
      result.preview = result.previewRoutes!.length > 0 && result.previewRoutes!.length === observation.previews.length && result.previewRoutes!.every(r => r.https === 'verified') ? 'available' : 'unavailable';
    } catch (error) { result.observationError = problem(error); result.links = []; }
    for (const service of observation.services) if (!result.services.some(s => s.id === service.id)) result.services.push({ id: service.id, port: service.port, unit: '', state: 'not recorded' });
    return result;
  }
  async logs(input: unknown) {
    const { environmentId, serviceId, cursor, limit } = logsInput.parse(input); this.exists(environmentId);
    const row = this.store.resources(environmentId, true).filter(r => r.kind === 'unit' && (JSON.parse(r.data) as Unit).serviceId === serviceId).at(-1);
    if (!row) throw new Problem('NOT_FOUND', 'No recorded Rootlane unit for that service');
    const unit = JSON.parse(row.data) as Unit;
    let unavailable = false;
    try {
      const current = await this.host.inspectUnit(unit.name);
      if (current && current.marker !== unit.marker && !row.removed) throw new Problem('OWNERSHIP_CONFLICT', 'Current unit is not the recorded owner');
      const page = await this.host.logs(unit, cursor, limit); if (page.lines.length || cursor) return page;
    } catch (error) { if (error instanceof Problem && error.code === 'OWNERSHIP_CONFLICT') throw error; unavailable = true; }
    const saved = this.store.savedLogs(row.id);
    if (unavailable && !saved.length) throw new Problem('LOGS_UNAVAILABLE', 'Journal access failed and no failure snapshot was retained');
    return { lines: saved.slice(-limit), nextCursor: null, truncated: saved.length > limit };
  }
  async reconcile() {
    this.reconciling = true;
    const boot = await this.host.bootId();
    for (const env of this.store.environments()) {
      const latest = this.store.latest(env.id);
      if (latest && ['accepted', 'running'].includes(latest.status)) this.store.finish(latest.id, 'failed', { code: 'INTERRUPTED', message: 'Rootlane restarted during this operation; observed resources were reconciled, no automatic start was attempted' });
      const units = this.store.resources(env.id).filter(r => r.kind === 'unit');
      let live = false;
      for (const row of units) {
        const unit = JSON.parse(row.data) as Unit; const current = await this.host.inspectUnit(unit.name);
        if (current && current.marker !== unit.marker) { live = true; continue; }
        if (current && !['inactive', 'failed'].includes(current.state)) live = true;
        if (current?.marker === unit.marker && current.invocation) { unit.invocation = current.invocation; this.store.updateData(row.id, unit); }
      }
      if ((env.desired === 'stopped' || !live) && this.store.resources(env.id).length) {
        const errors = await this.cleanup(env.id);
        if (errors.length && latest) this.store.finish(latest.id, 'failed', { code: 'RECONCILE_CONFLICT', message: errors.join('; ').slice(0, 1024) });
      }
      if (live && env.desired === 'running' && latest && ['accepted', 'running'].includes(latest.status) && latest.action === 'start') {
        const observed = await this.get({ environmentId: env.id });
        if (observed.application !== 'ready' && observed.application !== 'unknown') {
          const errors = await this.cleanup(env.id, latest.id);
          if (errors.length) this.store.finish(latest.id, 'failed', { code: 'RECONCILE_CONFLICT', message: errors.join('; ').slice(0, 1024) });
        }
      }
      if (this.store.meta('boot') !== boot && !live) this.store.db.prepare("UPDATE environments SET desired='stopped' WHERE id=?").run(env.id);
    }
    this.store.setMeta('boot', boot); this.reconciling = false;
  }
}
