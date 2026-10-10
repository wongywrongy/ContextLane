import { opendir, realpath, lstat, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { command } from '../host/command.js';
import { inside, type Config } from '../config.js';
import { page, Problem, type Project, type ProjectDetails } from '../shared/contracts.js';
import type { Store, Observation } from '../state/store.js';
import type { Host, Listener, AgentObservation } from '../host/types.js';
const manifests = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'web/package.json', 'frontend/package.json', 'apps/api/pyproject.toml'];
export class Catalog {
  private cached: { expires: number; projects: Project[]; warnings: string[]; observedAt: string } | null = null;
  private scan: Promise<NonNullable<Catalog['cached']>> | null = null;
  constructor(readonly config: Config, readonly host: Host, readonly store?: Store) {}
  async list(input: unknown) {
    const { cursor, limit } = page.parse(input);
    if (!this.cached || this.cached.expires < Date.now()) {
      this.scan ??= this.discover().finally(() => { this.scan = null; }); this.cached = await this.scan;
    }
    return { projects: this.cached.projects.slice(cursor, cursor + limit), nextCursor: cursor + limit < this.cached.projects.length ? cursor + limit : null, warnings: this.cached.warnings, observedAt: this.cached.observedAt };
  }
  async get(projectId: string): Promise<ProjectDetails> {
    await this.list({ limit: 1 });
    const projects = this.cached!.projects; const project = projects.find(p => p.id === projectId);
    if (!project) throw new Problem('NOT_FOUND', 'Project is no longer in the observed catalog');
    const checkouts = projects.filter(p => p.id === projectId || (project.gitCommonDir && p.gitCommonDir === project.gitCommonDir) || inside(p.path, project.path));
    const targets = this.config.previewTargets.filter(t => checkouts.some(p => p.path === t.checkoutPath));
    const services: ProjectDetails['services'] = checkouts.flatMap(p => p.runtime.ports.map(port => {
      const target = targets.find(t => t.checkoutPath === p.path && t.port === port);
      const service = this.config.profiles.find(e => e.projectPath === p.path)?.services.find(s => s.port === port);
      return { checkoutId: p.id, serviceId: target?.serviceId ?? service?.id ?? null, name: target?.serviceName ?? service?.id ?? `Port ${port}`, port, source: target || service ? 'owner reviewed' as const : 'listener observation' as const, readiness: 'unverified' as const };
    }));
    const previews = (this.store?.previews() ?? []).filter(row => !row.removed).flatMap(row => { const target = JSON.parse(row.target) as import('../config.js').PreviewTarget; const checkout = checkouts.find(p => p.path === target.checkoutPath); return checkout ? [{ previewId: row.id, checkoutId: checkout.id, serviceId: target.serviceId }] : []; });
    const logServices = checkouts.flatMap(p => p.environmentIds.flatMap(environmentId => (this.store?.resources(environmentId, true) ?? []).filter(r => r.kind === 'unit').map(r => ({ environmentId, serviceId: (JSON.parse(r.data) as import('../host/types.js').Unit).serviceId }))));
    return { project, checkoutIds: checkouts.map(p => p.id), services, approvedTargetIds: targets.map(t => t.id), previews, logServices: [...new Map(logServices.map(s => [s.environmentId + '/' + s.serviceId, s])).values()] };
  }
  private async discover() {
    const warnings: string[] = []; const deadline = Date.now() + 5000; const paths = new Set<string>();
    const safe = async (path: string) => { const resolved = await realpath(path); return this.config.observationRoots.some(r => inside(resolved, r)) ? resolved : null; };
    for (const root of this.config.projectRoots) {
      try {
        const directory = await opendir(root); let count = 0;
        for await (const entry of directory) {
          if (++count > 1000 || paths.size >= 1000) { warnings.push(`${root}: directory limit reached`); break; }
          if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
          try { const path = await safe(join(root, entry.name)); if (path) paths.add(path); } catch { warnings.push(`${entry.name}: directory unavailable`); }
        }
      } catch { warnings.push(`${root}: discovery unavailable`); }
    }
    // Only reviewed profile paths are additional seeds; do not recursively traverse repositories.
    for (const profile of this.config.profiles) { try { const path = await safe(profile.projectPath); if (path) paths.add(path); } catch { warnings.push(`${profile.id}: project directory unavailable`); } }
    for (const target of this.config.previewTargets) for (const candidate of [target.projectPath, target.checkoutPath]) { try { const path = await safe(candidate); if (path) paths.add(path); } catch { warnings.push(`${target.id}: approved preview directory unavailable`); } }
    for (const row of this.store?.previews() ?? []) {
      if (row.removed) continue;
      const target = JSON.parse(row.target) as import('../config.js').PreviewTarget;
      for (const candidate of [target.projectPath, target.checkoutPath]) { try { const path = await safe(candidate); if (path) paths.add(path); } catch { warnings.push(`Recorded preview ${row.id} directory unavailable; unpublish remains available by ID`); } }
    }
    const recorded = (this.store?.environments() ?? []).map(e => ({ id: e.id, path: (JSON.parse(e.observation) as Observation).projectPath }));
    for (const entry of recorded) { try { const path = await safe(entry.path); if (path) paths.add(path); } catch { warnings.push(`Recorded environment ${entry.id} project is unavailable; stop remains available by ID`); } }
    for (const path of [...paths]) {
      if (Date.now() > deadline) { warnings.push('Git discovery time limit reached'); break; }
      try {
        await lstat(join(path, '.git'));
        const listing = await command('git', ['-C', path, 'worktree', 'list', '--porcelain', '-z'], { timeout: 1000 });
        for (const field of listing.split('\0')) if (field.startsWith('worktree ')) {
          const candidate = await safe(field.slice(9));
          if (candidate && paths.size < 1000) paths.add(candidate); else warnings.push('A worktree was outside observation roots or exceeded the catalog limit');
        }
      } catch { /* Non-Git and inaccessible worktrees remain valid catalog entries. */ }
    }
    let listeners: Listener[] = []; let observed = false;
    try { listeners = await this.host.listeners(); observed = true; } catch { warnings.push('Listener observation unavailable; runtime associations are unknown'); }
    let routes: unknown = null;
    try { routes = await this.host.routes(); } catch { warnings.push('Tailscale routes could not be observed'); }
    let agents: AgentObservation[] = [];
    try { const result = await this.host.agents(); agents = result.agents; warnings.push(...result.warnings); }
    catch { warnings.push('Agent detection unavailable'); }
    const projects: Project[] = [];
    for (const path of [...paths].sort()) {
      const metadataAllowed = Date.now() <= deadline;
      let gitCommonDir: string | null = null; let branch: string | null = null; let detached = false; let detachedSha: string | undefined;
      try {
        if (!metadataAllowed) throw new Error('Git metadata budget exhausted');
        await lstat(join(path, '.git'));
        const common = (await command('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 1000 })).trim();
        gitCommonDir = await safe(common);
        const head = (await command('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 1000 })).trim();
        detached = head === 'HEAD'; branch = detached ? null : head;
        if (detached) detachedSha = (await command('git', ['-C', path, 'rev-parse', '--short', 'HEAD'], { timeout: 1000 })).trim();
      } catch { /* Absence of Git metadata is not an application error. */ }
      const found: string[] = [];
      for (const manifest of manifests) try { const target = await safe(join(path, manifest)); if (target && inside(target, path)) { await access(target); found.push(manifest); } } catch { /* Known manifest is optional. */ }
      const settings = this.config.projects.find(p => p.path === path);
      const ownListeners = listeners.filter(l => l.cwd && inside(l.cwd, path) && ![...paths].some(other => other !== path && inside(other, path) && inside(l.cwd!, other)));
      const links = [...(settings?.links ?? [])]; const observedPreviews: Project['links'] = [];
      const tcp = (routes as { TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean }> } | null)?.TCP ?? {};
      const web = (routes as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> } | null)?.Web ?? {};
      for (const [origin, config] of Object.entries(web)) {
        if (!origin.startsWith(`${this.config.tailnetHostname}:`)) continue;
        const transport = tcp[origin.split(':').at(-1)!];
        if (!transport?.HTTPS && !transport?.HTTP) continue;
        const proxy = config.Handlers?.['/']?.Proxy;
        if (ownListeners.some(l => ['127.0.0.1', '0.0.0.0', '*', '::'].includes(l.address) && proxy === `http://127.0.0.1:${l.port}`)) {
          const preview = { label: 'Observed preview', url: `${transport.HTTPS ? 'https' : 'http'}://${origin}/` }; links.push(preview); observedPreviews.push(preview);
        }
      }
      projects.push({ id: createHash('sha256').update(path).digest('hex').slice(0, 24), name: basename(path), path, gitCommonDir, branch, detached, ...(detachedSha ? { detachedSha } : {}), manifests: found, observedPreviews, previewIds: (this.store?.previews() ?? []).filter(r => !r.removed && (JSON.parse(r.target) as import('../config.js').PreviewTarget).checkoutPath === path).map(r => r.id), links: links.slice(0, 20), agents: (settings?.agents ?? []).map(a => ({ name: a.name, source: 'owner registration' as const })), environmentIds: [...new Set([...recorded.filter(e => e.path === path).map(e => e.id), ...this.config.profiles.filter(p => p.projectPath === path && !recorded.some(e => e.id === p.id)).map(p => p.id)])], logServices: recorded.filter(e => e.path === path).flatMap(e => (this.store?.resources(e.id, true) ?? []).filter(r => r.kind === 'unit').map(r => ({ environmentId: e.id, serviceId: (JSON.parse(r.data) as import('../host/types.js').Unit).serviceId }))), runtime: { services: [...new Map([...this.config.profiles.filter(p => p.projectPath === path).flatMap(p => p.services.map(s => ({ id: s.id, name: s.id, port: s.port }))), ...this.config.previewTargets.filter(t => t.checkoutPath === path).map(t => ({ id: t.serviceId, name: t.serviceName, port: t.port }))].map(s => [s.port, s])).values()], status: ownListeners.length ? 'listeners observed' : observed ? 'no associated listener' : 'unknown', ports: [...new Set(ownListeners.map(l => l.port))].slice(0, 32), listeners: ownListeners.map(l => ({ port: l.port, worktreePath: path })), ownership: 'observe-only' } });
    }
    let unassigned = 0;
    const closestFirst = [...projects].sort((a, b) => b.path.length - a.path.length);
    for (const agent of agents) {
      let cwd: string | null = null;
      try { cwd = await safe(agent.cwd); } catch { /* Exited processes and unmounted paths have unknown associations. */ }
      const project = cwd ? closestFirst.find(p => inside(cwd!, p.path)) : undefined;
      if (project) project.agents.push({ id: agent.id, name: agent.name, source: 'detected process', cwd: cwd!, worktreePath: project.path, ...(agent.pid ? { pid: agent.pid } : {}) });
      else unassigned++;
    }
    for (const project of projects) project.worktrees = projects.filter(p => p.path === project.path || (project.gitCommonDir !== null && p.gitCommonDir === project.gitCommonDir)).map(p => ({ name: p.name, path: p.path, branch: p.branch, ...(p.detachedSha ? { detachedSha: p.detachedSha } : {}), ports: p.runtime.ports }));
    if (unassigned) warnings.push(`${unassigned} detected agent process${unassigned === 1 ? '' : 'es'} unassigned to a known project`);
    if (Date.now() > deadline) warnings.push('Git metadata budget exhausted; some associations may be unknown');
    return { projects, warnings: warnings.slice(0, 50), observedAt: new Date().toISOString(), expires: Date.now() + 5000 };
  }
}
