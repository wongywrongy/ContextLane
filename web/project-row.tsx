import React, { useEffect, useRef, useState } from 'react';
import type { Environment, PreviewStatus } from '../src/shared/contracts';
import { agentKey, agentLabel, branchLabel, elapsed, groupAgents, groupLinks, groupServices, shortPath, type ProjectGroup } from './projects';
import { Mark } from './project-card';
import { Icon } from './icons';

export function ProjectRow({ group, environments, previews, stale, now, onDetails, onLogs }: {
  group: ProjectGroup; environments: Record<string, Environment>; previews: Record<string, PreviewStatus>;
  stale: boolean; now: number; onDetails: (section?: 'Agents' | 'Services' | 'Links') => void;
  onLogs: (environmentId: string, serviceId: string) => void;
}) {
  const project = group.primary;
  const agents = groupAgents(group), services = groupServices(group, environments), links = groupLinks(group, environments, previews, null);
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
  return <div className="project-row" role="row" id={`project-${project.id}`} aria-label={`${project.name} project`}>
    <div className="project-cell" role="cell"><strong>{project.name}</strong><span className="mono muted" title={project.path}>{shortPath(project.path)}</span>{group.checkouts.some(p => p.runtime.status === 'unknown') && <small className="row-warning">Observation unavailable</small>}{group.checkouts.some(p => p.recipe?.errors.length) && <small className="row-warning">Recipe needs attention</small>}</div>
    <div className="branch-cell mono muted" role="cell" title={branchLabel(project)}><Icon name="branch"/><span>{project.detached ? branchLabel(project) : project.branch ?? (project.gitCommonDir ? 'Unavailable' : 'Non-Git')}</span></div>
    <div className="agents-cell" role="cell" aria-label="Agents">{!agents.length ? <span className="muted">—</span> : agents.map(agent => {
      const duration = agent.source === 'detected process' ? elapsed(agent.startedAt, now) : null;
      const identity = `${agent.name} · ${agentLabel(agent)}${agent.source === 'detected process' ? `${agent.pid ? ` · PID ${agent.pid}` : ''} · ${agent.worktreePath ?? agent.cwd ?? project.path}${duration ? ` · Process uptime ${duration}` : ''}` : ''}`;
      return <span className="agent-item" key={agentKey(agent)} title={identity} role="img" aria-label={identity}><Mark name={agent.name}/>{duration && <span className="agent-duration mono">{duration}</span>}</span>;
    })}</div>
    <div className="services-cell" role="cell" aria-label="Services">{!services.length ? <span className="muted" title={project.runtime.status === 'unknown' ? 'Observation unavailable' : undefined}>—</span> : services.slice(0,3).map(service => {
      const state = stale || service.checkout.runtime.status === 'unknown' ? 'Unknown' : service.state;
      return <div className="service-line" key={service.key} title={`${service.name} :${service.port} · ${state} · ${service.checkout.path}`}><span className={`status-dot ${state === 'Ready' || state === 'Listening' ? 'green' : state === 'Attention' ? 'warning' : ''}`} role="img" aria-label={state}/><span className="service-name">{service.name}</span><span className="mono muted">:{service.port}</span></div>;
    })}{services.length > 3 && <button className="more-link" onClick={() => onDetails('Services')}>+{services.length-3} services</button>}</div>
    <div className="links-cell" role="cell" aria-label="Links">{!links.length ? <span className="muted">—</span> : links.slice(0,3).map(link => {
      const state = stale ? 'Unknown' : link.state;
      const displayLabel = link.source === 'Environment' && group.environmentIds.length > 1 ? link.label.slice(0, -(3 + branchLabel(link.checkout).length)) : link.label;
      return <a className="compact-link" key={link.key} href={link.url} target="_blank" rel="noreferrer" title={`${link.url} · ${state}`} aria-label={`${link.label} · ${state} · ${link.url}`}><span className={`status-dot ${state === 'Available' ? 'green' : state === 'Attention' ? 'warning' : ''}`} aria-hidden="true"/><span>{displayLabel}</span><Icon name="external"/></a>;
    })}{links.length > 3 && <button className="more-link" onClick={() => onDetails('Links')}>+{links.length-3} links</button>}</div>
    <div className="menu-cell project-actions" role="cell">
      <button ref={button} className="icon-btn" aria-label={`${project.name} actions`} aria-haspopup="menu" aria-expanded={open} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); menu.current?.showPopover(); } }} popoverTarget={`menu-${project.id}`}><Icon name="more"/></button>
      <div ref={menu} id={`menu-${project.id}`} popover="auto" role="menu" aria-label={`${project.name} actions`} className="project-popover" onToggle={event => {
        const opening = event.newState === 'open'; setOpen(opening);
        if (opening) { position(); menu.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
        else if (document.activeElement === document.body || menu.current?.contains(document.activeElement)) button.current?.focus();
      }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); menu.current?.hidePopover(); button.current?.focus(); return; }
        if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
        event.preventDefault(); const items = [...menu.current!.querySelectorAll<HTMLButtonElement>('button')];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length-1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }}>
        <button role="menuitem" onClick={() => dismiss(() => onDetails())}>Details</button>
        {logs && <button role="menuitem" onClick={() => dismiss(() => onLogs(logs.environmentId, logs.serviceId))}>Logs</button>}
        <button role="menuitem" onClick={() => dismiss(() => { void navigator.clipboard.writeText(project.path).then(() => setNotice('Path copied')).catch(() => setNotice('Copy unavailable. Open Details to select the full path.')); })}>Copy path</button>
      </div>
      {notice && <span className={notice === 'Path copied' ? 'sr-only' : 'copy-error'} role="status">{notice}</span>}
    </div>
  </div>;
}
