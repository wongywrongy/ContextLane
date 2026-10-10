import { opendir, realpath, lstat, access, stat } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { procText } from '../host/process.js';
import { command } from '../host/command.js';
import { inside, type Config } from '../config.js';
import { page, Problem, type Project, type ProjectDetails } from '../shared/contracts.js';
import type { Store, Observation } from '../state/store.js';
import type { Host, Listener, AgentObservation } from '../host/types.js';
export function loopbackPort(proxy?: string) { try { const url = new URL(proxy ?? ''); return url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname) && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password ? Number(url.port || 80) : null; } catch { return null; } }
const manifests = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'web/package.json', 'frontend/package.json', 'apps/api/pyproject.toml'];
export class Catalog {
  private cached: { expires: number; projects: Project[]; warnings: string[]; observedAt: string } | null = null;
  private snapshots = new Map<string, NonNullable<Catalog['cached']>>();
  private slowPaths: {expires:number; paths:string[]; warnings:string[]} | null = null;
  private metadata = new Map<string, {expires:number; stamp:string; value: Pick<Project,'gitCommonDir'|'branch'|'detached'|'detachedSha'|'manifests'>}>();
  private scan: Promise<NonNullable<Catalog['cached']>> | null = null;
  constructor(readonly config: Config, readonly host: Host, readonly store?: Store) {}
  invalidate() { this.cached = null; this.slowPaths = null; this.metadata.clear(); }
  async list(input: unknown) {
    const { cursor, limit, snapshot } = page.parse(input);
    for (const [key, value] of this.snapshots) if (Date.now() > Date.parse(key) + 30000) this.snapshots.delete(key);
    if (snapshot) {
      const value = this.snapshots.get(snapshot);
      if (!value) throw new Problem('SNAPSHOT_EXPIRED','Catalog snapshot expired; restart pagination');
      return {projects:value.projects.slice(cursor,cursor+limit), nextCursor:cursor+limit < value.projects.length ? cursor+limit : null, warnings:value.warnings, observedAt:value.observedAt};
    }
    if (!this.cached || this.cached.expires < Date.now()) {
      this.scan ??= this.discover().finally(() => { this.scan = null; }); this.cached = await this.scan; this.snapshots.set(this.cached.observedAt, this.cached);
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
  private async gitStamp(path: string, common: string | null) {
    let git = join(path,'.git');
    try { const info = await lstat(git); if (!info.isDirectory()) { const text = await procText(git,4096); if (!text.startsWith('gitdir: ')) return ''; git = resolve(path,text.slice(8).trim()); if (!this.config.observationRoots.some(root => inside(git,root))) return ''; } } catch { return ''; }
    return (await Promise.all([join(git,'HEAD'),join(git,'index'), ...(common ? [join(common,'HEAD')] : [])].map(p => stat(p).then(s => String(s.mtimeMs)).catch(() => '-')))).join(':');
  }
  private async discover() {
    const warnings: string[] = []; const deadline = Date.now() + 5000; const paths = new Set<string>();
    const safe = async (path: string) => { const resolved = await realpath(path); return this.config.observationRoots.some(r => inside(resolved, r)) ? resolved : null; };
    const skipped = new Set(['node_modules','.venv','venv','dist','build','.next','target','vendor']);
    let entries = 0;
    const walk = async (directoryPath: string, depth: number): Promise<void> => {
      if (Date.now() > deadline || entries >= 1000 || paths.size >= 1000) { warnings.push('Directory discovery budget exhausted'); return; }
      try {
        const isProject = await lstat(join(directoryPath,'.git')).then(() => true).catch(() => false) || (await Promise.all(manifests.map(m => access(join(directoryPath,m)).then(() => true).catch(() => false)))).some(Boolean);
        if (isProject) { paths.add(directoryPath); return; }
        if (depth >= 3) { if (depth) paths.add(directoryPath); return; }
        let children = 0;
        const directory = await opendir(directoryPath);
        for await (const entry of directory) {
          if (++entries > 1000 || Date.now() > deadline) { warnings.push('Directory discovery budget exhausted'); break; }
          if (entry.name.startsWith('.') || skipped.has(entry.name) || !entry.isDirectory() && !entry.isSymbolicLink()) continue;
          try { const candidate = await safe(join(directoryPath, entry.name)); if (candidate && !paths.has(candidate)) { children++; await walk(candidate,depth+1); } }
          catch { warnings.push(`${entry.name}: directory unavailable`); }
        }
        if (!children && depth) paths.add(directoryPath);
      } catch { warnings.push(`${directoryPath}: discovery unavailable`); }
    };
    let refreshSlow = !this.slowPaths || this.slowPaths.expires < Date.now();
    if (!refreshSlow) for (const path of this.slowPaths!.paths) {
      const cached = this.metadata.get(path);
      if (cached && cached.stamp !== await this.gitStamp(path, cached.value.gitCommonDir)) { refreshSlow = true; break; }
    }
    if (refreshSlow) for (const root of this.config.projectRoots) await walk(root, 0);
    else { this.slowPaths!.paths.forEach(p => paths.add(p)); warnings.push(...this.slowPaths!.warnings); }
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
    if (refreshSlow) for (const path of [...paths]) {
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
    if (refreshSlow) this.slowPaths = {expires:Date.now()+60000,paths:[...paths],warnings:[...warnings]};
    let listeners: Listener[] = []; let observed = false;
    try { listeners = await this.host.listeners(); observed = true; } catch { warnings.push('Listener observation unavailable; runtime associations are unknown'); }
    for (const listener of listeners) if (listener.cwd) { try { listener.cwd = await realpath(listener.cwd); } catch { warnings.push(`${listener.cwd} not visible to Rootlane`); listener.cwd = null; } }
    let routes: unknown = null;
    try { routes = await this.host.routes(); } catch { warnings.push('Tailscale routes could not be observed'); }
    let agents: AgentObservation[] = [];
    try { const result = await this.host.agents(); agents = result.agents; warnings.push(...result.warnings); }
    catch { warnings.push('Agent detection unavailable'); }
    const projects: Project[] = [];
    for (const path of [...paths].sort()) {
      const metadataAllowed = Date.now() <= deadline;
      const old = this.metadata.get(path); const stamp = await this.gitStamp(path, old?.value.gitCommonDir ?? null);
      let meta = old?.value;
      if (!old || old.expires < Date.now() || old.stamp !== stamp) {
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
        meta = {gitCommonDir,branch,detached, ...(detachedSha ? {detachedSha} : {}),manifests:found};
        this.metadata.set(path,{value:meta,expires:Date.now()+60000,stamp:await this.gitStamp(path,gitCommonDir)});
      }
      const {gitCommonDir,branch,detached,detachedSha,manifests:found} = meta!;
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
        if (ownListeners.some(l => ['127.0.0.1', '::1'].includes(l.address) && loopbackPort(proxy) === l.port)) {
          const preview = { label: 'Observed preview', url: `${transport.HTTPS ? 'https' : 'http'}://${origin}/` }; links.push(preview); observedPreviews.push(preview);
        }
      }
      projects.push({ id: createHash('sha256').update(path).digest('hex').slice(0, 24), name: basename(path), path, gitCommonDir, branch, detached, ...(detachedSha ? { detachedSha } : {}), manifests: found, observedPreviews, previewIds: (this.store?.previews() ?? []).filter(r => !r.removed && (JSON.parse(r.target) as import('../config.js').PreviewTarget).checkoutPath === path).map(r => r.id), links: links.slice(0, 20), agents: (settings?.agents ?? []).map(a => ({ name: a.name, source: 'owner registration' as const })), environmentIds: [...new Set([...recorded.filter(e => e.path === path).map(e => e.id), ...this.config.profiles.filter(p => p.projectPath === path && !recorded.some(e => e.id === p.id)).map(p => p.id)])], logServices: recorded.filter(e => e.path === path).flatMap(e => (this.store?.resources(e.id, true) ?? []).filter(r => r.kind === 'unit').map(r => ({ environmentId: e.id, serviceId: (JSON.parse(r.data) as import('../host/types.js').Unit).serviceId }))), runtime: { services: [...new Map([...this.config.profiles.filter(p => p.projectPath === path).flatMap(p => p.services.map(s => ({ id: s.id, name: s.id, port: s.port }))), ...this.config.previewTargets.filter(t => t.checkoutPath === path).map(t => ({ id: t.serviceId, name: t.serviceName, port: t.port }))].map(s => [s.port, s])).values()], status: ownListeners.length ? 'listeners observed' : observed ? 'no associated listener' : 'unknown', ports: [...new Set(ownListeners.map(l => l.port))].slice(0, 32), listeners: ownListeners.map(l => ({ port: l.port, worktreePath: path })), ownership: 'observe-only' } });
    }
    let unassigned = 0;
    const closestFirst = [...projects].sort((a, b) => b.path.length - a.path.length);
    for (const agent of agents) {
      let cwd: string | null = null;
      try { cwd = await safe(agent.cwd); } catch { warnings.push(`${agent.cwd} not visible to Rootlane`); }
      const project = cwd ? closestFirst.find(p => inside(cwd!, p.path)) : undefined;
      if (project) project.agents.push({ id: agent.id, name: agent.name, source: 'detected process', cwd: cwd!, worktreePath: project.path, checkoutId: project.id, ...(agent.startedAt ? {startedAt:agent.startedAt} : {}), ...(agent.pid ? { pid: agent.pid } : {}) });
      else unassigned++;
    }
    for (const project of projects) project.worktrees = projects.filter(p => p.path === project.path || (project.gitCommonDir !== null && p.gitCommonDir === project.gitCommonDir)).map(p => ({ name: p.name, path: p.path, branch: p.branch, ...(p.detachedSha ? { detachedSha: p.detachedSha } : {}), ports: p.runtime.ports }));
    if (unassigned) warnings.push(`${unassigned} detected agent process${unassigned === 1 ? '' : 'es'} unassigned to a known project`);
    if (Date.now() > deadline) warnings.push('Git metadata budget exhausted; some associations may be unknown');
    return { projects, warnings: warnings.slice(0, 50), observedAt: new Date(Math.max(Date.now(), this.cached ? Date.parse(this.cached.observedAt)+1 : 0)).toISOString(), expires: Date.now() + 5000 };
  }
}
