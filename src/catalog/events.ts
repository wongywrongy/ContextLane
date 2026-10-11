import type { Project, ObservedEvent } from '../shared/contracts.js';
import type { ServeConfig } from '../host/routes.js';

export const wildcardBind = (bind: string) => ['0.0.0.0', '::', '*'].includes(bind);
export function publicFunnelRoutes(config: ServeConfig): string[] {
  return [...new Set([
    ...Object.entries(config.AllowFunnel ?? {}).filter(([, allowed]) => allowed).map(([origin]) => origin),
    ...Object.values(config.Foreground ?? {}).flatMap(publicFunnelRoutes),
  ])].slice(0,100);
}
export function catalogEvents(previous: Project[], current: Project[], evidence: { listeners: boolean; routes: boolean; agents: boolean }, at: string): ObservedEvent[] {
  const events: ObservedEvent[] = [];
  for (const project of current) {
    const before = previous.find(p => p.id === project.id);
    const emit = (kind: ObservedEvent['kind'], text: string, ref: string) => events.push({ at, projectId: project.id, checkoutId: project.id, kind, text, ref });
    if (evidence.listeners && project.runtime.status !== 'unknown') {
      const key = (l: NonNullable<Project['runtime']['listeners']>[number]) => `${l.bind}:${l.port}:${l.process?.pid ?? 'unknown'}`;
      const old = new Map((before?.runtime.listeners ?? []).map(l => [key(l), l]));
      const next = new Map((project.runtime.listeners ?? []).map(l => [key(l), l]));
      const name = (l: NonNullable<Project['runtime']['listeners']>[number]) => `${l.process?.name ?? 'Process'} ${l.bind}:${l.port}${l.startedBy ? ` · started by ${l.startedBy.name}` : ''}`;
      for (const [id,l] of next) if (!old.has(id)) emit('listener-opened', `${name(l)} began listening`, id);
      if (before?.runtime.status !== 'unknown') for (const [id,l] of old) if (!next.has(id)) emit('listener-closed', `${name(l)} is no longer observed listening`, id);
    }
    if (evidence.routes) {
      const old = new Map((before?.routeSummaries ?? []).filter(r => r.route !== 'unknown' && r.route !== 'absent').map(r => [r.url,r]));
      const next = new Map((project.routeSummaries ?? []).filter(r => r.route !== 'unknown' && r.route !== 'absent').map(r => [r.url,r]));
      for (const [id,r] of next) {
        if (!old.has(id)) emit('route-added', `Route appeared: ${id} → ${r.target}`, id);
        else if (old.get(id)!.target !== r.target || old.get(id)!.route !== r.route) emit('route-changed', `Route changed: ${id} → ${r.target} · ${r.route}`, id);
      }
      for (const [id] of old) if (!next.has(id)) emit('route-removed', `Route is no longer observed: ${id}`, id);
    }
    if (evidence.agents) {
      const old = new Map((before?.agents ?? []).filter(a => a.source === 'detected process').map(a => [a.id,a]));
      const next = new Map(project.agents.filter(a => a.source === 'detected process').map(a => [a.id,a]));
      for (const [id,a] of next) if (!old.has(id)) emit('agent-appeared', `${a.name} appeared · PID ${a.pid ?? '—'}`, id);
      for (const [id,a] of old) if (!next.has(id)) emit('agent-left', `${a.name} is no longer observed · PID ${a.pid ?? '—'}`, id);
    }
  }
  return events;
}
