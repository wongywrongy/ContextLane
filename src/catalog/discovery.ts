import { opendir, realpath, lstat, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { command } from '../host/command.js';
import { inside, type Config } from '../config.js';
import { page, type Project } from '../shared/contracts.js';
import type { Store, Observation } from '../state/store.js';
import type { Host, Listener } from '../host/types.js';
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
    const projects: Project[] = [];
    for (const path of [...paths].sort()) {
      const metadataAllowed = Date.now() <= deadline;
      let gitCommonDir: string | null = null; let branch: string | null = null; let detached = false;
      try {
        if (!metadataAllowed) throw new Error('Git metadata budget exhausted');
        await lstat(join(path, '.git'));
        const common = (await command('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 1000 })).trim();
        gitCommonDir = await safe(common);
        const head = (await command('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 1000 })).trim();
        detached = head === 'HEAD'; branch = detached ? null : head;
      } catch { /* Absence of Git metadata is not an application error. */ }
      const found: string[] = [];
      for (const manifest of manifests) try { const target = await safe(join(path, manifest)); if (target && inside(target, path)) { await access(target); found.push(manifest); } } catch { /* Known manifest is optional. */ }
      const settings = this.config.projects.find(p => p.path === path);
      const ownListeners = listeners.filter(l => l.cwd && inside(l.cwd, path) && ![...paths].some(other => other !== path && inside(other, path) && inside(l.cwd!, other)));
      const links = [...(settings?.links ?? [])];
      const tcp = (routes as { TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean }> } | null)?.TCP ?? {};
      const web = (routes as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> } | null)?.Web ?? {};
      for (const [origin, config] of Object.entries(web)) {
        if (!origin.startsWith(`${this.config.tailnetHostname}:`)) continue;
        const transport = tcp[origin.split(':').at(-1)!];
        if (!transport?.HTTPS && !transport?.HTTP) continue;
        const proxy = config.Handlers?.['/']?.Proxy;
        if (ownListeners.some(l => ['127.0.0.1', '0.0.0.0', '*', '::'].includes(l.address) && proxy === `http://127.0.0.1:${l.port}`)) links.push({ label: 'Observed preview', url: `${transport.HTTPS ? 'https' : 'http'}://${origin}/` });
      }
      projects.push({ id: createHash('sha256').update(path).digest('hex').slice(0, 24), name: basename(path), path, gitCommonDir, branch, detached, manifests: found, links: links.slice(0, 20), agents: (settings?.agents ?? []).map(a => ({ name: a.name, source: 'owner registration' as const })), environmentIds: [...new Set([...recorded.filter(e => e.path === path).map(e => e.id), ...this.config.profiles.filter(p => p.projectPath === path && !recorded.some(e => e.id === p.id)).map(p => p.id)])], runtime: { status: ownListeners.length ? 'listeners observed' : observed ? 'no associated listener' : 'unknown', ports: [...new Set(ownListeners.map(l => l.port))].slice(0, 32), ownership: 'observe-only' } });
    }
    if (Date.now() > deadline) warnings.push('Git metadata budget exhausted; some associations may be unknown');
    return { projects, warnings: warnings.slice(0, 50), observedAt: new Date().toISOString(), expires: Date.now() + 5000 };
  }
}
