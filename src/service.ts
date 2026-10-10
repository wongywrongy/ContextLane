import { Catalog } from './catalog/discovery.js';
import { Lifecycle } from './lifecycle/service.js';
import { Publications } from './preview/service.js';
import { toolContracts, problem, type ToolName } from './shared/contracts.js';
export class Rootlane {
  readonly publications: Publications;
  lastError: ReturnType<typeof problem> | null = null;
  configError: ReturnType<typeof problem> | null = null;
  get reconciling() { return !this.lifecycle.available || !this.publications.available; }
  constructor(readonly catalog: Catalog, readonly lifecycle: Lifecycle) { this.publications = new Publications(lifecycle); }
  async capabilities() {
    const { config, host } = this.lifecycle; const blockers = [];
    let listeners = 'unavailable' as 'available' | 'unavailable'; let routes = listeners; let guardedWrites = 'unverified' as 'supported' | 'unverified';
    try { await host.listeners(); listeners = 'available'; } catch (error) { blockers.push(problem(error)); }
    try { await host.routes(); routes = 'available'; if (await host.guardedRoutes()) guardedWrites = 'supported'; else blockers.push({ code: 'GUARDED_WRITES_UNAVAILABLE', message: 'Update the Tailscale daemon to support ETag guarded Serve writes' }); } catch (error) { blockers.push(problem(error)); }
    const connection = await host.connection();
    if (connection.status !== 'connected' || connection.hostname !== config.tailnetHostname) blockers.push({ code: 'TAILSCALE_UNAVAILABLE', message: 'Connect the configured Tailscale node' });
    if (this.reconciling) blockers.push({ code: 'RECONCILING', message: 'Host observation unavailable; reconciliation will retry' });
    if (!config.previewTargets.length) blockers.push({ code: 'NO_APPROVED_TARGETS', message: 'Owner must review previewTargets in private host configuration' });
    return { operations: Object.keys(toolContracts), approvalScope: { lifecycleProfileIds: config.profiles.map(p => p.id), previewTargetIds: config.previewTargets.map(t => t.id), publication: 'owner-approved targets only; discovery grants no approval' }, observed: { listeners, routes, tailscale: connection.status, hostname: connection.hostname, guardedWrites, routeWritePermission: 'unverified', lifecyclePermission: 'unverified' }, blockers, reconciling: this.reconciling, lastError: this.lastError, configError: this.configError };
  }
  async call(name: ToolName, raw: unknown) {
    const contract = toolContracts[name]; const input = contract.input.parse(raw);
    const output = name === 'list_projects' ? await this.catalog.list(input)
      : name === 'get_project' ? await this.catalog.get((input as { projectId: string }).projectId)
      : name === 'get_capabilities' ? await this.capabilities()
      : name === 'get_preview' ? await this.publications.get(input)
      : name === 'publish_preview' || name === 'unpublish_preview' ? await this.publications.accept(name === 'publish_preview' ? 'publish' : 'unpublish', input)
      : name === 'get_environment' ? await this.lifecycle.get(input)
      : name === 'get_logs' ? await this.lifecycle.logs(input)
      : this.lifecycle.accept(name === 'start_environment' ? 'start' : 'stop', input);
    return contract.output.parse(output);
  }
}
