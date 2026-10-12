import React, { useEffect, useRef, useState } from 'react';
import type { Environment, PreviewStatus } from '../src/shared/contracts';
import { agentKey, agentLabel, isBeyondLoopback, branchLabel, editorHref, projectStatus, recipePresentation, pillState, elapsed, groupAgents, groupLinks, groupServices, shortPath, type ProjectGroup } from './projects';
import { AgentAvatar } from './agent-avatar';
import { Icon } from './icons';

export function ProjectRow({ group, environments, previews, stale, now, onDetails, onLogs, expanded, density, editorTemplate, editorHost, lifecycleAvailable, working, onAction, onRequest }: {
  group: ProjectGroup; environments: Record<string, Environment>; previews: Record<string, PreviewStatus>;
  stale: boolean; now: number; onDetails: (section?: 'Overview' | 'Agents' | 'Services' | 'Links') => void;
  expanded: boolean; density: 'Compact' | 'Expanded'; editorTemplate: string | null; editorHost: string | null;
  lifecycleAvailable: boolean; working: boolean; onAction: (id: string, action: 'start' | 'stop') => void; onRequest: (path: string) => void;
  onLogs: (environmentId: string, serviceId: string) => void;
}) {
  const project = group.primary;
  const agents = groupAgents(group), services = groupServices(group, environments, stale), links = groupLinks(group, environments, previews, null);
  const limit = density === 'Compact' ? 1 : 3;
  const editor = editorHref(project.path, editorTemplate, editorHost);
  const control = group.checkouts.flatMap(p => p.controls ?? [])[0];
  const stopping = control?.desiredState === 'running' || control?.hasResources;
  const recipeProject = group.checkouts.find(p => p.recipe?.found);
  const logs = group.checkouts.flatMap(p => p.logServices)[0];
  const button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [notice, setNotice] = useState('');
  const position = () => {
    const target = button.current!, popup = menu.current!;
    const r = target.getBoundingClientRect();
    popup.style.top = `${Math.max(8, Math.min(r.bottom + 6, innerHeight - popup.offsetHeight - 8))}px`;
    popup.style.left = `${Math.max(8, Math.min(r.right - popup.offsetWidth, innerWidth - popup.offsetWidth - 8))}px`;
  };
  useEffect(() => {
    if (!open) return;
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open]);
  const dismiss = (work: () => void) => { menu.current?.hidePopover(); button.current?.focus(); work(); };
  return <div className={`project-row prow ${expanded ? 'sel' : ''}`}  role="row" id={`project-${project.id}`} aria-label={`${project.name} project`} aria-expanded={expanded} onClick={() => onDetails()}>
    <div className="project-cell pcell" role="cell"><span className="openhint mobile-only" aria-hidden="true"><Icon name="disclosure"/></span><div className="pidentity"><div className="ptext"><button className="project-open" aria-label={`Open ${project.name} details`} aria-controls="project-detail" aria-expanded={expanded} onClick={event => { event.stopPropagation(); onDetails(); }}>{project.name}</button><span className="mono muted ppath" title={project.path}>{shortPath(project.path)}</span></div><span className="mobile-branch mono muted">{project.detached ? branchLabel(project) : project.branch ?? (project.gitCommonDir ? '—' : 'Non-Git')}</span>{group.environmentIds.length ? <small className="row-status">Managed · {stale ? '—' : projectStatus(group, environments).replace('Unknown', '—')}</small> : recipeProject?.recipe && <small className="row-status">Recipe · {recipePresentation(recipeProject.recipe).text.replace('Pending approval', 'Pending').replace('Needs approval', 'Pending')}</small>}{group.checkouts.some(p => p.runtime.status === 'unknown') && <small className="row-warning">Observation unavailable</small>}</div></div>
    <div className="mobile-summary mobile-only" role="cell">{stale ? '—' : services.some(s => ['Ready','Listening'].includes(s.state)) ? <>{services.filter(s => s.state === 'Ready').length > 0 && <span className="chip ok">{services.filter(s => s.state === 'Ready').length} working</span>}{services.filter(s => s.state === 'Listening').length > 0 && <span className="chip info">{services.filter(s => s.state === 'Listening').length} unverified</span>}{services.filter(s => s.checkout.runtime.listeners?.some(l => l.port === s.port && isBeyondLoopback(l.bind))).length > 0 && <span className="chip warn">{services.filter(s => s.checkout.runtime.listeners?.some(l => l.port === s.port && isBeyondLoopback(l.bind))).length} on network</span>}</> : group.checkouts.some(p => p.runtime.status === 'unknown') || services.some(s => s.state === 'Unknown') ? '—' : 'Nothing running'}</div>
    <div className="branch-cell mono muted" role="cell" title={branchLabel(project)}><Icon name="branch"/><span>{project.detached ? branchLabel(project) : project.branch ?? (project.gitCommonDir ? '—' : 'Non-Git')}</span></div>
    <div className="agents-cell" role="cell" aria-label="Agents">{!agents.length ? <span className="muted">—</span> : agents.slice(0, density === 'Compact' ? 4 : agents.length).map(agent => {
      const duration = agent.source === 'detected process' ? elapsed(agent.startedAt, now) : null;
      const identity = `${agent.name} · ${agentLabel(agent)}${agent.source === 'detected process' ? `${agent.pid ? ` · PID ${agent.pid}` : ''} · ${agent.worktreePath ?? agent.cwd ?? project.path}${duration ? ` · Process uptime ${duration}` : ''}` : ''}`;
      return <span className="agent-item" key={agentKey(agent)} title={identity} role="img" aria-label={identity}><AgentAvatar name={agent.name} context={agent.source === 'detected process' ? agent.contextUsedPct : null}/>{duration && <span className="agent-duration mono">{duration}</span>}</span>;
    })}{density === 'Compact' && agents.length > 4 && <span className="av-more">+{agents.length - 4}</span>}</div>
    <div className="services-cell" data-label="Services" role="cell" aria-label="Services">{!services.length ? <span className="muted" title={project.runtime.status === 'unknown' ? 'Observation unavailable' : undefined}>—</span> : services.slice(0,limit).map(service => {
      const state = stale || service.checkout.runtime.status === 'unknown' ? 'Unknown' : service.state;
      return <div className={`service-line lp ${pillState(state)}`} role="img" aria-label={`${service.name} · ${state}`} key={service.key} title={`${service.name} :${service.port} · ${state} · ${service.checkout.path}`}><span className="d" aria-hidden="true"/><span className="service-name">{service.name}</span><span className="mono lp-port">:{service.port}</span></div>;
    })}{services.length > limit && <button className="more-link" onClick={event => { event.stopPropagation(); onDetails('Services'); }}>+{services.length-limit} services</button>}</div>
    <div className="links-cell" data-label="Links" role="cell" aria-label="Links">{!links.length ? <span className="muted">—</span> : links.slice(0,limit).map(link => {
      const state = stale ? 'Unknown' : link.state;
      const displayLabel = link.source === 'Environment' && group.environmentIds.length > 1 ? link.label.slice(0, -(3 + branchLabel(link.checkout).length)) : link.label;
      return <a className={`compact-link lp ${pillState(state)}`} onClick={event => event.stopPropagation()} key={link.key} href={link.url} target="_blank" rel="noreferrer" title={`${link.url} · ${state}`} aria-label={`${link.label} · ${state} · ${link.url}`}><span className="d" aria-hidden="true"/><span>{displayLabel}</span><Icon name="external"/></a>;
    })}{links.length > limit && <button className="more-link" onClick={event => { event.stopPropagation(); onDetails('Links'); }}>+{links.length-limit} links</button>}</div>
    <div className="menu-cell project-actions" role="cell" onClick={event => event.stopPropagation()}>
      {control && (stopping || control.startAllowed) && <button className="icon-btn lifecycle-button" title={stopping ? 'Stop environment' : 'Start environment'} aria-label={`${stopping ? 'Stop' : 'Start'} ${project.name}`} disabled={working || stale || !lifecycleAvailable || group.checkouts.some(p => p.controls?.some(c => ['accepted', 'running'].includes(c.latestOperation?.status ?? '')))} onClick={() => onAction(control.id, stopping ? 'stop' : 'start')}><Icon name={stopping ? 'stop' : 'play'}/></button>}
      <button ref={button} className="icon-btn" aria-label={`${project.name} actions`} aria-haspopup="menu" aria-expanded={open} onClick={() => onDetails()} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); menu.current?.showPopover(); } }} popoverTarget={`menu-${project.id}`}><Icon name="more"/></button>
      <div ref={menu} id={`menu-${project.id}`} popover="auto" role="menu" aria-label={`${project.name} actions`} className="project-popover" onToggle={event => {
        const opening = event.newState === 'open'; setOpen(opening);
        if (opening) { position(); menu.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
        else if (document.activeElement === document.body || menu.current?.contains(document.activeElement)) button.current?.focus();
      }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); menu.current?.hidePopover(); button.current?.focus(); return; }
        if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
        event.preventDefault(); const items = [...menu.current!.querySelectorAll<HTMLElement>('[role=menuitem]')];
        const index = items.indexOf(document.activeElement as HTMLElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length-1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }}>
        <button role="menuitem" onClick={() => dismiss(() => onDetails())}>Details</button>
        {logs && <button role="menuitem" onClick={() => dismiss(() => onLogs(logs.environmentId, logs.serviceId))}>Logs</button>}
        {editor && <a role="menuitem" href={editor} onClick={() => menu.current?.hidePopover()}>Open in editor</a>}
        {recipeProject?.recipe?.valid && recipeProject.recipe.approval !== 'approved' && <button role="menuitem" disabled={working || stale || !lifecycleAvailable} onClick={() => dismiss(() => onRequest(recipeProject.path))}>Request environment…</button>}
        <button role="menuitem" onClick={() => dismiss(() => { void navigator.clipboard.writeText(project.path).then(() => setNotice('Path copied')).catch(() => setNotice('Copy unavailable. Open Details to select the full path.')); })}>Copy path</button>
      </div>
      {notice && <span className={notice === 'Path copied' ? 'sr-only' : 'copy-error'} role="status">{notice}</span>}
    </div>
  </div>;
}
