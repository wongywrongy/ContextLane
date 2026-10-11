import { catalogOutput, type Project, type Environment } from '../src/shared/contracts.js';
export type ProjectGroup = { id: string; primary: Project; checkouts: Project[]; environmentIds: string[]; worktreeCount: number };
export const agentKey = (agent: Project['agents'][number]) => (agent.source === 'detected process' ? agent.id : agent.source + ':' + agent.name);
export const agentLabel = (agent: Project['agents'][number]) => (agent.source === 'detected process' ? 'Detected process' : 'Registered');
export const groupAgents = (group: ProjectGroup) => [...new Map(group.checkouts.flatMap((p) => p.agents).map((a) => [agentKey(a), a])).values()];
export async function loadCatalog(fetchPage: (cursor: number, snapshot?: string) => Promise<unknown>) {
  let cursor = 0;
  const projects: Project[] = [];
  const warnings = new Set<string>();
  let observedAt = '';
  while (projects.length < 1000) {
    const page = catalogOutput.parse(await fetchPage(cursor, observedAt || undefined));
    if (observedAt && page.observedAt !== observedAt) throw new Error('Catalog changed during refresh. Retry refresh.');
    observedAt = page.observedAt;
    page.warnings.forEach((w) => warnings.add(w));
    projects.push(...page.projects);
    if (page.nextCursor === null) return { projects, warnings: [...warnings], observedAt };
    if (page.nextCursor <= cursor) throw new Error('Catalog pagination did not advance.');
    cursor = page.nextCursor;
  }
  warnings.add('Catalog limited to 1,000 entries.');
  return { projects: projects.slice(0, 1000), warnings: [...warnings], observedAt };
}
export function groupProjects(projects: Project[]): ProjectGroup[] {
  const independent = (p: Project) =>
    p.gitCommonDir || p.manifests.length || p.agents.length || p.links.length || p.environmentIds.length || p.runtime.ports.length;
  const candidates = projects.filter((p) => independent(p) || !projects.some((child) => child.gitCommonDir && child.path.startsWith(p.path + '/')));
  const groups = new Map<string, Project[]>();
  for (const p of candidates) {
    const parent = !p.gitCommonDir
      ? candidates.filter((other) => other.path !== p.path && p.path.startsWith(other.path + '/')).sort((a, b) => a.path.length - b.path.length)[0]
      : undefined;
    const key = p.gitCommonDir ?? parent?.gitCommonDir ?? parent?.path ?? p.path;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups]
    .map(([id, checkouts]) => {
      checkouts.sort((a, b) => a.path.localeCompare(b.path));
      const primary =
        checkouts.find((p) => p.gitCommonDir === p.path + '/.git') ??
        checkouts.find((p) => !checkouts.some((other) => other !== p && p.path.startsWith(other.path + '/'))) ??
        checkouts[0];
      return {
        id,
        primary,
        checkouts,
        environmentIds: [...new Set(checkouts.flatMap((p) => p.environmentIds))],
        worktreeCount: checkouts.filter((p) => p !== primary && p.gitCommonDir === primary.gitCommonDir && p.gitCommonDir !== null).length,
      };
    })
    .sort((a, b) => a.primary.name.localeCompare(b.primary.name));
}
export function projectStatus(group: ProjectGroup, environments: Record<string, Environment>, errors: Record<string, string> = {}) {
  if (group.environmentIds.some(id => errors[id])) return 'Unknown';
  const values = group.environmentIds.map((id) => environments[id]);
  if (values.some((e) => e && (e.application === 'unhealthy' || e.observationError || e.latestOperation?.status === 'failed'))) return 'Attention';
  if (values.some((e) => e?.latestOperation && ['accepted', 'running'].includes(e.latestOperation.status))) return 'Working';
  if (values.length && values.every((e) => e?.application === 'ready')) return 'Ready';
  if (group.checkouts.some((p) => p.runtime.ports.length)) return 'Listening';
  if (values.some((e) => !e || e.application === 'unknown') || group.checkouts.some((p) => p.runtime.status === 'unknown')) return 'Unknown';
  if (values.length && values.every((e) => e?.application === 'stopped')) return 'Stopped';
  return 'Not observed';
}
export const label = (id: string) => id.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function editorHref(path: string, template?: string | null, host?: string | null) {
  if (!template || (template.includes('{host}') && !host)) return null;
  const url = template.replaceAll('{host}', encodeURIComponent(host ?? '')).replaceAll('{path}', path.split('/').map(encodeURIComponent).join('/'));
  try {
    return ['vscode:', 'vscode-insiders:', 'cursor:', 'zed:', 'jetbrains:'].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}
export const branchLabel = (project: Project) => (project.detached ? `detached @ ${project.detachedSha?.slice(0, 7) ?? '—'}` : (project.branch ?? '—'));
export function matchesProject(group: ProjectGroup, query: string) {
  const text = query.trim().toLowerCase();
  return group.checkouts.some((p) =>
    [p.name, p.path, p.branch ?? '', ...p.runtime.ports.map(String), ...p.runtime.services.map((s) => String(s.port))].some((value) =>
      value.toLowerCase().includes(text),
    ),
  );
}
export type ProjectFilter = 'All' | 'Running' | 'With agents' | 'Managed';
export function matchesFilter(group: ProjectGroup, filter: ProjectFilter, environments: Record<string, Environment>) {
  if (filter === 'Running')
    return group.checkouts.some((p) => p.runtime.ports.length > 0) || group.environmentIds.some((id) => environments[id]?.application === 'ready');
  if (filter === 'With agents') return groupAgents(group).length > 0;
  if (filter === 'Managed') return group.environmentIds.length > 0;
  return true;
}
export function groupServices(group: ProjectGroup, environments: Record<string, Environment>, stale = false) {
  return group.checkouts.flatMap((checkout) => {
    const configured = checkout.runtime.services;
    const ports = [...new Set([...checkout.runtime.ports, ...configured.map((s) => s.port)])].filter(port => !checkout.runtime.listeners?.some(l => l.port === port && l.owner === 'agent'));
    return ports.map((port) => {
      const listener = checkout.runtime.listeners?.find((l) => l.port === port);
      const service = configured.find((s) => s.port === port);
      const environment = checkout.environmentIds
        .map((id) => environments[id])
        .find((e) => e?.services.some((s) => s.id === service?.id && s.port === port));
      const unit = environment?.services.find((s) => s.id === service?.id && s.port === port);
      const listening = checkout.runtime.ports.includes(port);
      const binds = checkout.runtime.listeners?.filter(l => l.port === port) ?? [];
      const managed = !!unit?.unit && (!listening || (binds.length > 0 && binds.every(l => l.managedBy?.environmentId === environment?.id && l.managedBy?.serviceId === unit.id)));
      const state = stale || checkout.runtime.status === 'unknown' ? 'Unknown' : serviceState(managed ? environment : undefined, managed ? unit : undefined, listening);
      return {
        key: `${checkout.id}:${port}`,
        name: listener?.process?.name ?? service?.name ?? 'Listener',
        port,
        checkout,
        unit: managed ? unit!.unit : '—',
        process: listener?.process,
        startedBy: listener?.startedBy,
        managed,
        serviceId: unit?.id ?? service?.id,
        binds,
        state,
      };
    });
  });
}
export const isBeyondLoopback = (bind: string) => !['127.0.0.1', '::1'].includes(bind);
export const chipTone = (state: string) =>
  /^(Ready|Available|Connected|Succeeded)$/.test(state)
    ? 'ok'
    : /^(Listening|Published|Registered|Running|Accepted|Working)$/.test(state)
      ? 'info'
      : /^(Attention|Unhealthy|Partial)$/.test(state)
        ? 'warn'
        : state === 'Failed'
          ? 'bad'
          : 'idle';

export type LinkState = 'Available' | 'Published' | 'Down' | 'Link' | 'Unknown';
export function linkState(value: {
  route?: string;
  https?: string;
  upstream?: string;
  removed?: boolean;
  errors?: unknown[];
  stale?: boolean;
}): LinkState {
  if (value.stale || value.route === 'unknown') return 'Unknown';
  if (value.removed) return 'Down';
  if (value.route === 'matching' && value.https === 'verified' && value.upstream === 'ready') return 'Available';
  if (value.errors?.length || value.route === 'conflict' || value.https === 'failed' || value.upstream === 'unready') return 'Down';
  if (value.route === 'matching') return 'Published';
  return 'Link';
}
export type GroupLink = {
  key: string;
  label: string;
  url: string;
  source: string;
  state: LinkState;
  target?: string;
  verifiedAt?: string;
  checkout: Project;
  https?: string;
  operation?: import('../src/shared/contracts.js').PreviewOperation | null;
};
export function groupLinks(
  group: ProjectGroup,
  environments: Record<string, Environment>,
  previews: Record<string, import('../src/shared/contracts.js').PreviewStatus>,
  details: (import('../src/shared/contracts.js').ProjectDetails & { stale?: boolean }) | null,
): GroupLink[] {
  const links = new Map<string, GroupLink>();
  const add = (item: GroupLink) => {
    if (!links.has(item.url)) links.set(item.url, item);
  };
  const stale =
    !!details?.stale ||
    group.checkouts.some((p) => p.runtime.status === 'unknown') ||
    group.environmentIds.some((id) => environments[id]?.observationError);
  const publications = Object.values(previews).filter((p) => group.checkouts.some((c) => c.path === p.checkoutPath));
  for (const p of publications) {
    add({
      key: p.id,
      label: p.serviceName,
      url: p.url,
      source: 'Publication',
      state: linkState({ ...p, stale }),
      target: p.route === 'matching' ? p.target ?? undefined : undefined,
      https: p.https,
      verifiedAt: p.verifiedAt,
      operation: p.latestOperation,
      checkout: group.checkouts.find((c) => c.path === p.checkoutPath)!,
    });
  }
  for (const id of group.environmentIds) {
    const env = environments[id];
    if (!env) continue;
    const checkout = group.checkouts.find((c) => c.environmentIds.includes(id)) ?? group.primary;
    for (const preview of env.previews ?? []) {
      const route = env.previewRoutes?.find((r) => r.url === preview.url);
      const serviceLabel =
        preview.label ??
        env.links.find((l) => l.url === preview.url)?.label ??
        checkout.runtime.services.find((s) => s.id === preview.serviceId && s.port === env.ports?.[preview.serviceId])?.name ??
        details?.services.find((s) => s.checkoutId === checkout.id && s.serviceId === preview.serviceId)?.name ??
        preview.serviceId;
      add({
        key: `${id}:${preview.serviceId}`,
        label: serviceLabel + (group.environmentIds.length > 1 ? ` · ${branchLabel(checkout)}` : ''),
        url: preview.url,
        source: 'Environment',
        state: linkState({ ...route, upstream: route?.upstream ?? (env.application === 'ready' ? 'ready' : 'unknown'), stale }),
        target: route?.route === 'matching' ? route.target : undefined,
        https: route?.https,
        verifiedAt: route?.verifiedAt,
        checkout,
      });
    }
  }
  for (const checkout of group.checkouts) {
    for (const route of checkout.routeSummaries ?? []) {
      const name =
        details?.services.find((s) => s.checkoutId === checkout.id && s.port === route.upstreamPort)?.name ??
        checkout.runtime.services.find((s) => s.port === route.upstreamPort)?.name ??
        `:${route.upstreamPort}`;
      add({
        key: `${checkout.id}:${route.url}`,
        label: name,
        url: route.url,
        source: 'Observed route',
        state: linkState({ ...route, stale }),
        target: route.route === 'matching' ? route.target : undefined,
        https: 'unverified',
        checkout,
      });
    }
    for (const link of checkout.links) {
      add({ ...link, key: `${checkout.id}:${link.url}`, source: 'Configured link', state: stale ? 'Unknown' : 'Link', checkout });
    }
  }
  const order: LinkState[] = ['Available', 'Published', 'Down', 'Link', 'Unknown'];
  return [...links.values()].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || a.label.localeCompare(b.label));
}

export function recipePresentation(recipe: NonNullable<Project['recipe']>) {
  if (!recipe.valid) return { state: 'Attention', text: 'Invalid' };
  switch (recipe.approval) {
    case 'approved':
      return { state: 'Ready', text: 'Approved' };
    case 'pending':
      return { state: 'Registered', text: 'Pending approval' };
    case 'stale':
      return { state: 'Attention', text: 'Stale' };
    default:
      return { state: 'Detected', text: 'Needs approval' };
  }
}

export function serviceState(environment: Environment | undefined, unit: Environment['services'][number] | undefined, listening: boolean) {
  if (environment?.observationError || environment?.application === 'unknown') return 'Unknown';
  if (unit?.ready === true && unit.state === 'active') return 'Ready';
  if (unit?.state === 'failed' || environment?.application === 'unhealthy') return 'Down';
  if (environment?.application === 'ready' && unit?.state === 'active') return 'Ready';
  if (listening) return 'Listening';
  if (unit && ['inactive', 'absent', 'not recorded'].includes(unit.state)) return 'Stopped';
  return 'Unknown';
}

export const shortPath = (path: string) => path.split('/').filter(Boolean).slice(-2).join('/') || '/';
export function elapsed(value?: string | null, now = Date.now()) {
  const start = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(start) || start > now) return null;
  const seconds = Math.floor((now - start) / 1000);
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}

export function pillState(state: string): 'ok' | 'info' | 'bad' | 'idle' {
  if (['Ready', 'Available'].includes(state)) return 'ok';
  if (['Listening', 'Published'].includes(state)) return 'info';
  if (['Stopped', 'Down', 'Failed', 'Unhealthy', 'Attention'].includes(state)) return 'bad';
  return 'idle';
}
export type Density = 'Compact' | 'Expanded';
export function readDensity(storage: Pick<Storage, 'getItem'>): Density {
  try { return storage.getItem('rootlane-density') === 'Compact' ? 'Compact' : 'Expanded'; } catch { return 'Expanded'; }
}
export function saveDensity(storage: Pick<Storage, 'setItem'>, density: Density) {
  try { storage.setItem('rootlane-density', density); } catch { /* Storage may be disabled. */ }
}

export const detailTabs = (managed: boolean, mobile: boolean) => mobile ? ['Overview', ...(managed ? ['Logs'] : []), 'Links', 'Agents', 'Worktrees'] as const : ['Overview', ...(managed ? ['Logs'] : []), 'Services', 'Agents', 'Worktrees', 'Activity'] as const;
