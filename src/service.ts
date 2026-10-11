import { Catalog } from './catalog/discovery.js';
import { Lifecycle } from './lifecycle/service.js';
import { Publications } from './preview/service.js';
import { Recipes } from './recipes.js';
import { locate } from './locate.js';
import { toolContracts, problem, type ToolName } from './shared/contracts.js';
export class Rootlane {
  readonly publications: Publications;
  readonly recipes: Recipes;
  lastError: ReturnType<typeof problem> | null = null;
  configError: ReturnType<typeof problem> | null = null;
  get reconciling() {
    return !this.lifecycle.available || !this.publications.available;
  }
  constructor(
    readonly catalog: Catalog,
    readonly lifecycle: Lifecycle,
  ) {
    this.publications = new Publications(lifecycle);
    this.recipes = new Recipes(this);
    lifecycle.recipeProfiles = this.recipes.profiles;
    catalog.enrich = async (p) => {
      p.recipe = await this.recipes.inspect(p.path, p.gitCommonDir ?? undefined);
      const instances = this.recipes.instances(p.path);
      for (const control of p.controls ?? []) {
        const instance = instances.find((i) => i.id === control.id);
        control.startAllowed = instance
          ? p.recipe.valid && p.recipe.approval === 'approved' && p.recipe.approvalId === instance.approvalId
          : lifecycle.config.profiles.some((profile) => profile.id === control.id);
      }
      for (const instance of instances) {
        const observation = JSON.parse(lifecycle.store.environment(instance.id)?.observation ?? '{}') as import('./state/store.js').Observation;
        for (const s of observation.services ?? []) {
          if (!p.runtime.services.some((existing) => existing.port === s.port)) p.runtime.services.push({ id: s.id, name: s.id, port: s.port });
        }
      }
    };
  }
  async capabilities() {
    const { config, host } = this.lifecycle;
    const blockers = [];
    let listeners = 'unavailable' as 'available' | 'unavailable';
    let routes = listeners;
    let guardedWrites = 'unverified' as 'supported' | 'unverified';
    try {
      await host.listeners();
      listeners = 'available';
    } catch (error) {
      blockers.push(problem(error));
    }
    try {
      await host.routes();
      routes = 'available';
      if (await host.guardedRoutes()) guardedWrites = 'supported';
      else blockers.push({ code: 'GUARDED_WRITES_UNAVAILABLE', message: 'Update the Tailscale daemon to support ETag guarded Serve writes' });
    } catch (error) {
      blockers.push(problem(error));
    }
    for (const p of config.profiles)
      if (p.services.some((s) => ['env', 'sh', 'bash', 'dash', 'zsh', 'fish', 'ksh', 'csh', 'tcsh'].includes(s.executable.split('/').at(-1)!)))
        blockers.push({
          code: 'IMPLICIT_ENV_WRAPPER',
          message: `${p.id}: convert shell/env wrapper services to a .rootlane.json recipe with direct commands and envFile`,
        });
    const connection = await host.connection();
    if (connection.status !== 'connected' || connection.hostname !== config.tailnetHostname)
      blockers.push({ code: 'TAILSCALE_UNAVAILABLE', message: 'Connect the configured Tailscale node' });
    if (this.reconciling) blockers.push({ code: 'RECONCILING', message: 'Host observation unavailable; reconciliation will retry' });
    if (!config.previewTargets.length && !this.recipes.db.prepare("SELECT id FROM approvals WHERE status='approved' LIMIT 1").get())
      blockers.push({
        code: 'NO_APPROVED_TARGETS',
        message: 'Request owner approval for a project recipe, or review previewTargets in private host configuration',
      });
    return {
      operations: Object.keys(toolContracts),
      approvalScope: {
        lifecycleProfileIds: config.profiles.map((p) => p.id),
        previewTargetIds: config.previewTargets.map((t) => t.id),
        publication: 'owner-approved targets only; discovery grants no approval',
      },
      observed: {
        listeners,
        routes,
        tailscale: connection.status,
        hostname: connection.hostname,
        guardedWrites,
        routeWritePermission: 'unverified',
        lifecyclePermission: 'unverified',
      },
      blockers,
      reconciling: this.reconciling,
      lastError: this.lastError,
      configError: this.configError,
    };
  }
  async call(name: ToolName, raw: unknown) {
    const contract = toolContracts[name];
    const input = contract.input.parse(raw);
    if (name === 'start_environment') {
      const m = input as {
        environmentId: string;
        requestId: string;
      };
      if (!this.lifecycle.store.retry(m.environmentId, 'start', m.requestId)) await this.recipes.prepare(m.environmentId);
    }
    if (name === 'list_checks' || name === 'list_events') {
      const scope = await this.catalog.checkouts((input as { projectId: string }).projectId);
      const ids = scope.map(p => p.id);
      return contract.output.parse(name === 'list_checks' ? { checks: this.lifecycle.store.listChecks(ids) } : { events: this.lifecycle.store.listEvents(ids, (input as { limit: number }).limit) });
    }
    const output =
      name === 'request_environment'
        ? await this.recipes.request(
            (
              input as {
                path: string;
              }
            ).path,
            (
              input as {
                requestId: string;
              }
            ).requestId,
          )
        : name === 'locate'
          ? await locate(this, input)
          : name === 'list_operations'
            ? {
                operations: this.lifecycle.store.listOperations(
                  (
                    input as {
                      environmentId?: string;
                    }
                  ).environmentId,
                  (
                    input as {
                      previewId?: string;
                    }
                  ).previewId,
                  (
                    input as {
                      limit: number;
                    }
                  ).limit,
                ),
              }
            : name === 'list_projects'
              ? await this.catalog.list(input)
              : name === 'get_project'
                ? await this.catalog.get(
                    (
                      input as {
                        projectId: string;
                      }
                    ).projectId,
                  )
                : name === 'get_capabilities'
                  ? await this.capabilities()
                  : name === 'get_preview'
                    ? await this.publications.get(input)
                    : name === 'publish_preview' || name === 'unpublish_preview'
                      ? await this.publications.accept(name === 'publish_preview' ? 'publish' : 'unpublish', input)
                      : name === 'get_environment'
                        ? await this.lifecycle.get(input)
                        : name === 'get_logs'
                          ? await this.lifecycle.logs(input)
                          : this.lifecycle.accept(name === 'start_environment' ? 'start' : 'stop', input);
    if (name === 'get_environment')
      (output as import('./shared/contracts.js').Environment).startAllowed = await this.recipes.startAllowed(
        (
          input as {
            environmentId: string;
          }
        ).environmentId,
      );
    return contract.output.parse(output);
  }
}
