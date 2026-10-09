import { catalogOutput, type Project, type Environment } from '../src/shared/contracts.js';
export type ProjectGroup = { id: string; primary: Project; checkouts: Project[]; environmentIds: string[]; worktreeCount: number };
export async function loadCatalog(fetchPage: (cursor: number) => Promise<unknown>) {
  let cursor = 0; const projects: Project[] = []; const warnings = new Set<string>(); let observedAt = '';
  while (projects.length < 1000) {
    const page = catalogOutput.parse(await fetchPage(cursor));
    if (observedAt && page.observedAt !== observedAt) throw new Error('Catalog changed during refresh. Retry refresh.');
    observedAt = page.observedAt; page.warnings.forEach(w => warnings.add(w)); projects.push(...page.projects);
    if (page.nextCursor === null) return { projects, warnings: [...warnings], observedAt };
    if (page.nextCursor <= cursor) throw new Error('Catalog pagination did not advance.');
    cursor = page.nextCursor;
  }
  warnings.add('Catalog limited to 1,000 entries.');
  return { projects: projects.slice(0, 1000), warnings: [...warnings], observedAt };
}
export function groupProjects(projects: Project[]): ProjectGroup[] {
  const independent = (p: Project) => p.gitCommonDir || p.manifests.length || p.agents.length || p.links.length || p.environmentIds.length || p.runtime.ports.length;
  const candidates = projects.filter(p => independent(p) || !projects.some(child => child.gitCommonDir && child.path.startsWith(p.path + '/')));
  const groups = new Map<string, Project[]>();
  for (const p of candidates) {
    const parent = !p.gitCommonDir ? candidates.filter(other => other.path !== p.path && p.path.startsWith(other.path + '/')).sort((a,b) => a.path.length-b.path.length)[0] : undefined;
    const key = p.gitCommonDir ?? parent?.gitCommonDir ?? parent?.path ?? p.path;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups].map(([id, checkouts]) => {
    checkouts.sort((a,b) => a.path.localeCompare(b.path));
    const primary = checkouts.find(p => p.gitCommonDir === p.path + '/.git') ?? checkouts.find(p => !checkouts.some(other => other !== p && p.path.startsWith(other.path + '/'))) ?? checkouts[0];
    return { id, primary, checkouts, environmentIds: [...new Set(checkouts.flatMap(p => p.environmentIds))], worktreeCount: checkouts.filter(p => p !== primary && p.gitCommonDir === primary.gitCommonDir && p.gitCommonDir !== null).length };
  }).sort((a,b) => a.primary.name.localeCompare(b.primary.name));
}
export function projectStatus(group: ProjectGroup, environments: Record<string, Environment>) {
  const values = group.environmentIds.map(id => environments[id]);
  if (values.some(e => e && (e.application === 'unhealthy' || e.observationError || e.latestOperation?.status === 'failed'))) return 'Attention';
  if (values.some(e => e?.latestOperation && ['accepted','running'].includes(e.latestOperation.status))) return 'Working';
  if (values.length && values.every(e => e?.application === 'ready')) return 'Ready';
  if (group.checkouts.some(p => p.runtime.ports.length)) return 'Listening';
  if (values.some(e => !e || e.application === 'unknown') || group.checkouts.some(p => p.runtime.status === 'unknown')) return 'Unknown';
  if (values.length && values.every(e => e?.application === 'stopped')) return 'Stopped';
  return 'Not observed';
}
export const label = (id: string) => id.replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase());
