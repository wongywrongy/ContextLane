import { realpath } from 'node:fs/promises';
import { inside, revision, type PreviewTarget } from '../config.js';
import { routeLock } from '../host/routes.js';
import type { Preview, Listener } from '../host/types.js';
import type { Lifecycle } from '../lifecycle/service.js';
import { Problem, problem, publishInput, previewInput, unpublishInput, type PreviewOperation, type PreviewStatus } from '../shared/contracts.js';
import type { PreviewRow } from '../state/store.js';

export class Publications {
  private tasks = new Set<Promise<void>>();
  private reconciled = false;
  constructor(readonly lifecycle: Lifecycle) {}
  get available() { return this.reconciled; }
  get config() { return this.lifecycle.config; }
  get host() { return this.lifecycle.host; }
  get store() { return this.lifecycle.store; }
  private target(id: string) {
    const target = this.config.previewTargets.find(t => t.id === id);
    if (!target) throw new Problem('TARGET_NOT_APPROVED', 'Owner must approve a preview target in private configuration');
    return target;
  }
  private row(id: string) { const row = this.store.preview(id); if (!row) throw new Problem('NOT_FOUND', 'No recorded preview'); return row; }
  private async listener(target: PreviewTarget): Promise<Listener> {
    const checkout = await realpath(target.checkoutPath);
    if (checkout !== target.checkoutPath || !this.config.observationRoots.some(root => inside(checkout, root))) throw new Problem('TARGET_PATH_CHANGED', 'Approved checkout changed or left observation roots');
    const observed = await this.host.listeners();
    const listeners = observed.filter(l => l.port === target.port);
    if (listeners.some(l => ['0.0.0.0','::','*'].includes(l.address))) throw new Problem('PUBLIC_BINDING', 'bind the dev server to 127.0.0.1 (e.g. --host 127.0.0.1)');
    if (!listeners.length || new Set(listeners.map(l => l.pid)).size !== 1 || listeners.some(l => !['127.0.0.1','::1'].includes(l.address)) || !listeners[0].pid || !listeners[0].cwd) throw new Problem('LOCAL_TARGET_REQUIRED', 'Start the approved service separately, bound only to its fixed 127.0.0.1 port with attributable process metadata');
    const listener = listeners.find(l => l.address === '127.0.0.1') ?? listeners[0];
    if (observed.some(l => l.pid === listener.pid && ['0.0.0.0','::','*'].includes(l.address))) throw new Problem('PUBLIC_BINDING', 'bind the dev server to 127.0.0.1 (e.g. --host 127.0.0.1)');
    if (observed.some(l => l.pid === listener.pid && (l.port !== target.port || !['127.0.0.1','::1'].includes(l.address)))) throw new Problem('UNEXPECTED_BINDING', 'Approved service must listen only on its fixed loopback port');
    const cwd = await realpath(listener.cwd!);
    if (!inside(cwd, checkout)) throw new Problem('TARGET_ASSOCIATION_UNKNOWN', 'Listener is outside the approved checkout');
    return listener;
  }
  private response(operation: PreviewOperation) {
    const row = this.row(operation.previewId); const route = JSON.parse(row.route) as Preview;
    return { operation, previewId: row.id, url: `https://${route.hostname}:${route.port}/`, verification: 'unverified' as const };
  }
  async accept(action: 'publish' | 'unpublish', input: unknown) {
    const parsed = action === 'publish' ? publishInput.parse(input) : unpublishInput.parse(input);
    const identity = 'targetId' in parsed ? parsed.targetId : parsed.previewId;
    const payload = JSON.stringify(action === 'publish' ? { targetId: identity, action } : { previewId: identity, action });
    const prior = this.store.retryPreview(payload, parsed.requestId); if (prior) return this.response(prior);
    if (!this.reconciled || !this.lifecycle.available) throw new Problem('RECONCILING', 'Host reconciliation unavailable; retrying');
    const result = await routeLock(this.host, async () => {
      let target: PreviewTarget | undefined; let route: Preview | undefined;
      if (action === 'publish') {
        target = this.target(identity); await this.listener(target);
        const connection = await this.host.connection();
        if (connection.status !== 'connected' || connection.hostname !== this.config.tailnetHostname) throw new Problem('MISSING_CAPABILITY', 'Connect the configured Tailscale node before publication');
        if (!await this.host.guardedRoutes()) throw new Problem('GUARDED_WRITES_UNAVAILABLE', 'Daemon must support ETag guarded writes');
        route = { hostname: this.config.tailnetHostname, port: target.httpsPort, upstream: `http://${(await this.listener(target)).address === '::1' ? '[::1]' : '127.0.0.1'}:${target.port}`, label: target.serviceName };
        const existing = this.store.previews().find(p => p.targetId === identity && !p.removed);
        if (existing && existing.revision !== revision(target)) throw new Problem('NEEDS_UNPUBLISH', 'Target changed; remove recorded preview before replacing it');
        const state = this.host.routeState(await this.host.routes(), route);
        if (state === 'conflict' || (!existing && state !== 'absent')) throw new Problem('ROUTE_CONFLICT', 'HTTPS route belongs to another configuration');
        if (!existing && (await this.host.listeners()).some(l => l.port === target!.httpsPort)) throw new Problem('PORT_CONFLICT', 'HTTPS port already has a listener');
      }
      return this.store.acceptPreview(action, identity, parsed.requestId, target, route);
    });
    if (result.fresh) {
      const task = Promise.resolve().then(() => this.run(result.operation)).finally(() => this.tasks.delete(task));
      this.tasks.add(task);
    }
    return this.response(result.operation);
  }
  private async remove(row: PreviewRow) {
    await routeLock(this.host, async () => {
      if (row.attempted) await this.host.removeRoute(JSON.parse(row.route));
      this.store.releasePreview(row.id);
    });
  }
  private async run(operation: PreviewOperation) {
    this.store.finishPreview(operation.id, 'running');
    try {
      const row = this.row(operation.previewId);
      if (operation.action === 'unpublish') { await this.remove(row); this.store.finishPreview(operation.id, 'succeeded'); return; }
      const target = this.target(row.targetId);
      if (row.revision !== revision(target)) throw new Problem('TARGET_CHANGED', 'Approved target changed before publication');
      await routeLock(this.host, async () => {
        const before = await this.listener(target);
        if (!await this.host.probe((JSON.parse(row.route) as Preview).upstream, target.readiness)) throw new Problem('UPSTREAM_UNREADY', 'Approved upstream failed readiness; application remains independently owned');
        const after = await this.listener(target);
        if (before.pid !== after.pid || before.cwd !== after.cwd) throw new Problem('TARGET_CHANGED', 'Listener changed during readiness verification');
        const route = JSON.parse(row.route) as Preview;
        if (this.host.routeState(await this.host.routes(), route) !== 'absent') throw new Problem('ROUTE_CONFLICT', 'Route changed before publication');
        this.store.db.prepare('UPDATE previews SET attempted=1 WHERE id=?').run(row.id);
        try { await this.host.addRoute(route); }
        catch (error) { if (error instanceof Problem && ['ROUTE_CONFLICT', 'ROUTE_CHANGED', 'GUARDED_WRITES_UNAVAILABLE'].includes(error.code)) this.store.db.prepare('UPDATE previews SET attempted=0 WHERE id=?').run(row.id); throw error; }
      });
      const state = await this.get({ previewId: row.id });
      this.store.finishPreview(operation.id, state.https === 'verified' ? 'succeeded' : 'partial', state.https === 'verified' ? null : { code: 'HTTPS_UNVERIFIED', message: 'Route recorded; inspect get_preview for independent forwarding verification' });
    } catch (error) { this.store.finishPreview(operation.id, 'failed', problem(error)); }
  }
  async get(input: unknown): Promise<PreviewStatus> {
    const { previewId } = previewInput.parse(input); const row = this.row(previewId);
    const target = JSON.parse(row.target) as PreviewTarget; const route = JSON.parse(row.route) as Preview;
    const status: PreviewStatus = { id: row.id, targetId: row.targetId, projectPath: target.projectPath, checkoutPath: target.checkoutPath, serviceId: target.serviceId, serviceName: target.serviceName, port: target.port, httpsPort: route.port, ownership: 'rootlane route only', approved: this.config.previewTargets.some(t => t.id === row.targetId && revision(t) === row.revision), removed: !!row.removed, url: `https://${route.hostname}:${route.port}/`, route: 'unknown', actualConfiguration: null, upstream: 'unknown', https: 'unverified', errors: [], observedAt: new Date().toISOString(), latestOperation: this.store.latestPreview(row.id) };
    try { const config = await this.host.routes(); status.route = this.host.routeState(config, route); status.actualConfiguration = config; if (!row.removed && status.route !== 'matching') status.errors.push({ code: 'ROUTE_DRIFT', message: `Recorded route is ${status.route}; no automatic replacement is performed` }); } catch (error) { status.errors.push(problem(error)); }
    try { await this.listener(target); status.upstream = await this.host.probe(route.upstream, target.readiness) ? 'ready' : 'unready'; } catch (error) { status.errors.push(problem(error)); }
    if (!row.removed && row.attempted && status.route === 'matching' && status.upstream === 'ready') {
      status.https = await this.host.probe(status.url, target.readiness) ? 'verified' : 'failed';
      if (status.https === 'verified') this.store.setMeta(`verified-preview:${row.id}`, status.observedAt);
      if (status.https === 'failed') status.errors.push({ code: 'HTTPS_FAILED', message: 'Route matches but HTTPS readiness failed; check tailnet connectivity and forwarding' });
    }
    const verifiedAt = this.store.meta(`verified-preview:${row.id}`);
    if (verifiedAt) status.verifiedAt = verifiedAt;
    return status;
  }
  async reconcile() {
    this.reconciled = false;
    await this.host.routes();
    for (const row of this.store.previews().filter(p => !p.removed)) {
      const op = this.store.latestPreview(row.id);
      if (row.desired === 'removed') {
        try { await this.remove(row); if (op) this.store.finishPreview(op.id, 'succeeded'); }
        catch (error) { if (op) this.store.finishPreview(op.id, 'failed', problem(error)); }
      } else if (op && ['accepted', 'running'].includes(op.status)) this.store.finishPreview(op.id, 'failed', { code: 'INTERRUPTED', message: 'Rootlane restarted; recorded route retained for inspection; no application or route was started' });
    }
    this.reconciled = true;
  }
  async drain() { await Promise.all(this.tasks); }
}
