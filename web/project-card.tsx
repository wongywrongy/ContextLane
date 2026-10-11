import React, { useEffect, useRef, useState } from 'react';
import type { Environment, PreviewStatus, Project, ProjectDetails, Operation, PreviewOperation, CheckHistory, ObservedEvent } from '../src/shared/contracts';
import {
  detailTabs, shortPath, elapsed, projectStatus,
  agentKey,
  branchLabel,
  chipTone,
  pillState,
  editorHref,
  groupAgents,
  groupServices,
  isBeyondLoopback,
  groupLinks,
  type GroupLink,
  label,
  recipePresentation,
  type ProjectGroup,
} from './projects';
import { Icon } from './icons';
import { ClaudeMark } from './marks/claude';
import { CodexMark } from './marks/codex';
export type DetailTab = 'Overview' | 'Logs' | 'Worktrees' | 'Agents' | 'Services' | 'Links' | 'Activity';
import { LogsTab } from './project-logs';
export const time = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString('en-GB', { hour12: false }) : '—';
const date = (value?: string | null) => (value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '—');
export function Chip({ state, children }: { state: string; children?: React.ReactNode }) {
  const tone = chipTone(state);
  return <span className={`chip lp sm ${['Ready', 'Available', 'Listening', 'Published', 'Stopped', 'Down', 'Unknown', 'Link'].includes(state) ? pillState(state) : tone}`} title={state} aria-label={state}><span className="d" aria-hidden="true"/>{children ?? (state === 'Unknown' ? '—' : state)}</span>;
}
export function Mark({ name }: { name: string }) {
  const vendor = name === 'Codex' ? 'codex' : name === 'Claude Code' ? 'claude' : 'other';
  return (
    <span className={`mark ${vendor}`} aria-hidden="true">
      {vendor === 'claude' ? <ClaudeMark /> : vendor === 'codex' ? <CodexMark /> : name.slice(0, 2).toUpperCase()}
    </span>
  );
}
export function PathLink({ path, template, host }: { path: string; template?: string | null; host?: string | null }) {
  const href = editorHref(path, template, host);
  const [notice, setNotice] = useState('');
  return href ? (
    <a className="path" href={href} title="Open folder in editor">
      <span className="path-value">{path}</span>
      <Icon name="external" />
    </a>
  ) : (
    <span className="path">
      <span className="path-value">{path}</span>
      <button
        className="copy-path"
        aria-label={`Copy ${path}`}
        onClick={() => {
          void navigator.clipboard
            .writeText(path)
            .then(() => setNotice('Copied'))
            .catch(() => setNotice('Copy unavailable. Select the path.'));
        }}
      >
        {notice === 'Copied' ? 'Copied' : 'Copy'}
      </button>
      {notice && (
        <span className={`copy-notice${notice === 'Copied' ? ' sr-only' : ''}`} role="status">
          {notice}
        </span>
      )}
    </span>
  );
}
function Table({ headings, children }: { headings: string[]; children: React.ReactNode }) {
  const rows = React.Children.map(children, (row) => {
    if (!React.isValidElement<{ children: React.ReactNode; role?: string }>(row)) return row;
    return React.cloneElement(row, {
      role: 'row',
      children: React.Children.map(row.props.children, (cell, index) =>
        React.isValidElement<{ children?: React.ReactNode; role?: string; 'data-label'?: string }>(cell)
          ? React.cloneElement(cell, {
              'data-label': headings[index],
              role: 'cell',
              children: <span className="cell-value">{cell.props.children}</span>,
            })
          : cell,
      ),
    });
  });
  return (
    <div className="tbl-wrap" tabIndex={0} aria-label={`${headings.join(', ')} table`}>
      <table className="tbl" role="table">
        <thead>
          <tr role="row">
            {headings.map((h) => (
              <th scope="col" key={h}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}
export function ProjectDetailsPanel({ group, tab, onOpen, onClose, onMove, hasPrevious, hasNext, environments, environmentErrors, previews, previewErrors, details, projectError, stale, lifecycleAvailable, working, editorTemplate, editorHost, activity, activityError, checks, events, onRequest, onAction, loadLogs }: {
  group: ProjectGroup; tab: DetailTab; onOpen: (tab: DetailTab) => void; onClose: () => void;
  onMove: (direction: number) => void; hasPrevious: boolean; hasNext: boolean;
  environments: Record<string, Environment>; environmentErrors: Record<string,string>;
  previews: Record<string,PreviewStatus>; previewErrors: Record<string,string>;
  details: ProjectDetails | null; projectError: string; stale: boolean; lifecycleAvailable: boolean; working: string | null;
  editorTemplate: string | null; editorHost: string | null; activity: (Operation | PreviewOperation)[]; activityError: string;
  checks?: CheckHistory[]; events?: ObservedEvent[]; onRequest: (path: string) => void;
  onAction: (id: string, action: 'start' | 'stop' | 'publish' | 'unpublish') => void;
  loadLogs: (environmentId: string, serviceId: string, cursor: string | undefined, signal: AbortSignal) => Promise<{ lines: string[]; nextCursor: string | null; truncated: boolean }>;
}) {
  const project = group.primary, managed = group.environmentIds.length > 0;
  const [mobile, setMobile] = useState(() => matchMedia('(max-width:1099px)').matches);
  const [wide, setWide] = useState(() => { try { return localStorage.getItem('rootlane.panelWide') === 'true'; } catch { return false; } });
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { const media = matchMedia('(max-width:1099px)'); const change = () => setMobile(media.matches); media.addEventListener('change',change); return () => media.removeEventListener('change',change); }, []);
  useEffect(() => { panel.current?.focus(); }, []);
  useEffect(() => {
    if (!mobile) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [mobile]);
  const tabs = detailTabs(managed,mobile) as readonly DetailTab[];
  const activeTab = tabs.includes(tab) || (mobile && tab === 'Activity') ? tab : 'Overview';
  const selectedTab = mobile && activeTab === 'Activity' ? 'Overview' : activeTab;
  const evidenceStale = stale || !!projectError;
  const services = groupServices(group,environments,evidenceStale);
  for (const service of services) if (service.checkout.environmentIds.some(id => environmentErrors[id])) service.state = 'Unknown';
  const agents = groupAgents(group), links = groupLinks(group,environments,previews,details);
  for (const link of links) if (evidenceStale || link.checkout.environmentIds.some(id => environmentErrors[id]) || previewErrors[link.key]) link.state = 'Unknown';
  const publications = Object.values(previews).filter(p => group.checkouts.some(c => c.path === p.checkoutPath));
  const conflict = group.checkouts.flatMap(p => p.controls ?? []).some(c => ['accepted','running'].includes(c.latestOperation?.status ?? '')) || group.environmentIds.some(id => ['accepted','running'].includes(environments[id]?.latestOperation?.status ?? '')) || publications.some(p => ['accepted','running'].includes(p.latestOperation?.status ?? ''));
  const controls = group.checkouts.flatMap(p => p.controls ?? []);
  const feed = [...(events ?? []).map((e,i) => ({ key: `event-${e.at}-${i}`, at: e.at, text: e.text })), ...activity.map(op => ({ key: op.id, at: op.createdAt, text: `${label(op.action)} · ${'environmentId' in op ? op.environmentId : op.previewId} · ${op.status}${op.error ? ` · ${op.error.code}: ${op.error.message}` : ''}` }))].sort((a,b) => b.at.localeCompare(a.at)).slice(0,50);
  const count = (t: DetailTab) => !details ? null : t === 'Agents' ? agents.length : t === 'Worktrees' ? group.checkouts.length : t === 'Services' ? services.length : t === 'Links' ? links.length : t === 'Logs' ? details.logServices.length : t === 'Activity' && events ? feed.length : null;
  const beyondLoopback = group.checkouts.flatMap(checkout => (checkout.runtime.listeners ?? []).filter(l => isBeyondLoopback(l.bind)).map(l => ({...l,checkout})));
  const funnels = [...new Set(group.checkouts.flatMap(c => c.funnel ?? []))];
  const exposureKnown = !evidenceStale && group.checkouts.every(c => c.runtime.status !== 'unknown' && c.funnel !== null && c.funnel !== undefined);
  const exposure = <section className="card"><h3 className="card-h">Exposure</h3>{evidenceStale ? <p className="okline">—</p> : <>{beyondLoopback.map(l => <div className="warnline" key={`${l.checkout.id}:${l.bind}:${l.port}`}><div><strong>{l.process?.name ?? l.checkout.name} {l.bind}:{l.port}</strong><div className="mono muted">{shortPath(l.checkout.path)}</div><p>bind to 127.0.0.1 and share through a preview link</p></div></div>)}{funnels.map(origin => <p className="warnline" key={origin}>Public (Funnel) route: {origin}</p>)}<p className="okline">{!exposureKnown ? 'Serve or listener observation unavailable · —' : !funnels.length ? 'no public (Funnel) routes' : `${funnels.length} public (Funnel) routes observed`}</p>{exposureKnown && !beyondLoopback.length && !funnels.length && <p className="okline">Loopback only</p>}</>}</section>;
  const changes = <section className="card"><h3 className="card-h">Recent changes<button className="btn ghost" onClick={() => onOpen('Activity')}>All activity</button></h3>{activityError && <p role="alert">{activityError}</p>}{feed.slice(0,3).map(e => <div className="ev" key={e.key}><time title={date(e.at)}>{time(e.at)}</time><span>{e.text}</span></div>)}{!feed.length && <p className="okline">{events ? 'No recorded changes.' : 'Reading changes…'}</p>}</section>;
  return <aside ref={panel} id="project-detail" className={mobile ? 'mdetail' : `drawer ${wide ? 'wide' : ''}`} tabIndex={-1} role={mobile ? 'dialog' : undefined} aria-modal={mobile ? true : undefined} aria-labelledby="detail-title" onKeyDown={event => {
    const input = (event.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]');
    if (event.key === 'Escape' && !document.querySelector('[popover]:popover-open')) { event.preventDefault(); onClose(); }
    if (!input && ['ArrowUp','ArrowDown','j','k'].includes(event.key)) { event.preventDefault(); onMove(event.key === 'ArrowUp' || event.key === 'k' ? -1 : 1); }
    if (mobile && event.key === 'Tab') {
      const items = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select,[tabindex="0"]')].filter(e => e.getClientRects().length);
      if (event.shiftKey && (document.activeElement === items[0] || document.activeElement === panel.current)) { event.preventDefault(); items.at(-1)?.focus(); }
      if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    }
  }}>
    <header className="dr-head">
      {mobile && <button className="mback" onClick={onClose}>‹ Projects</button>}
      <div className="dr-top"><div className="dr-title"><h2 id="detail-title">{project.name}</h2><div className="dr-sub">{shortPath(project.path)} · {branchLabel(project)}</div>{managed && <small>Managed · {evidenceStale ? '—' : projectStatus(group,environments,environmentErrors).replace('Unknown','—')}</small>}</div>
      <div className="dr-actions">{controls.map(c => { const env = environments[c.id]; const canStop = c.desiredState === 'running' || c.hasResources || (env && env.application !== 'stopped'); return canStop && <button className="btn" key={c.id} disabled={evidenceStale || !!environmentErrors[c.id] || !lifecycleAvailable || !!working || conflict || !!env?.observationError} onClick={() => onAction(c.id,'stop')}>Stop{controls.length > 1 ? ` ${label(c.id)}` : ''}</button>; })}<button className="icon-btn" aria-label="Previous project" disabled={!hasPrevious} onClick={() => onMove(-1)}>↑</button><button className="icon-btn" aria-label="Next project" disabled={!hasNext} onClick={() => onMove(1)}>↓</button>{!mobile && <><button className="btn" aria-pressed={wide} onClick={() => { setWide(!wide); try { localStorage.setItem('rootlane.panelWide',String(!wide)); } catch {} }}>Widen</button><button className="icon-btn" aria-label="Close details" onClick={onClose}><Icon name="disclosure"/></button></>}</div></div>
      {!mobile && <p className="kbdhint">↑ ↓ / j k to move · Esc to close</p>}
      <div className={mobile ? 'mtabs' : 'dr-tabs dtabs seg'} role="tablist" aria-label={`${project.name} details`} onKeyDown={event => { if (!['ArrowRight','ArrowLeft','Home','End'].includes(event.key)) return; event.preventDefault(); const i = tabs.indexOf(selectedTab); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; onOpen(tabs[next]); document.getElementById(`tab-${tabs[next]}`)?.focus(); }}>
        {tabs.map(t => <button key={t} id={`tab-${t}`} role="tab" aria-selected={t === selectedTab} aria-controls="detail-body" tabIndex={t === selectedTab ? 0 : -1} className={selectedTab === t ? 'on' : ''} onClick={() => onOpen(t)}>{t}{count(t) !== null && <b>{count(t)}</b>}</button>)}
      </div>
    </header>
    <div id="detail-body" role={mobile && activeTab === 'Activity' ? 'region' : 'tabpanel'} aria-labelledby={mobile && activeTab === 'Activity' ? 'activity-title' : `tab-${activeTab}`} tabIndex={0} className={mobile ? 'mbody' : 'dr-body'}>
      {projectError && <p className="notice bad" role="alert">{projectError} · Details observation stale</p>}
      {stale && <p className="notice">Showing retained observations · current state —</p>}
      {activeTab === 'Overview' && <>
        <section className="card"><h3 className="card-h">Runtime map</h3><div className="rmap h"><span>Process</span><span>Listening on</span><span/><span>Reached at</span><span>State</span></div>
          {services.map(s => { const destinations = evidenceStale ? [] : links.filter(l => l.checkout.id === s.checkout.id && l.target && Number(new URL(l.target).port) === s.port); return <div className="rmap" key={s.key}><div><strong>{s.name}</strong><small className="mono muted runtime-meta">{shortPath(s.checkout.path)} · pid {evidenceStale ? '—' : s.process?.pid ?? '—'}</small></div><div>{s.binds.length ? s.binds.map(l => <span key={l.bind} className={`bind ${l.wildcard ? 'wide' : ''}`}>{evidenceStale ? '—' : `${l.bind.includes(':') ? `[${l.bind}]` : l.bind}:${s.port}`}</span>) : <span className="none">—</span>}</div><span className="arrow">→</span><div>{destinations.length ? destinations.map(l => <a className="runtime-url mono" key={l.key} href={l.url} target="_blank" rel="noreferrer">{l.label} {l.url}</a>) : <span className="none">{evidenceStale || s.checkout.funnel == null ? '—' : s.managed ? 'internal' : 'no route'}</span>}</div><Chip state={s.state}>{s.state === 'Ready' ? 'Working' : s.state === 'Unknown' ? '—' : s.state}</Chip></div>; })}{!services.length && <p className="okline">{details ? 'No services observed.' : 'Reading services…'}</p>}
        </section>
        {!mobile && <section className="card"><h3 className="card-h">Checks</h3><p className="check-note">{managed ? 'Reviewed readiness checks · preview HTTPS verification' : 'every 30s while this panel is open · not readiness'}</p>{checks?.filter(c => managed ? ['readiness','preview-https'].includes(c.kind) : ['route','http-probe'].includes(c.kind)).map(c => { const last = c.results.at(-1);
          const checkout = group.checkouts.find(p => p.id === c.checkoutId);
          const environmentId = c.subject.split('/')[0];
          const sourceFailed = c.kind === 'readiness'
            ? !environments[environmentId] || !!environmentErrors[environmentId] || !!environments[environmentId].observationError
            : c.kind === 'preview-https' && (!!previewErrors[c.subject] || !!previews[c.subject]?.errors.length || (!previews[c.subject] && !!checkout?.environmentIds.some(id => environmentErrors[id] || environments[id]?.observationError)));
          const expired = evidenceStale || !!activityError || sourceFailed || !last || Date.now() - Date.parse(last.at) > (c.kind === 'http-probe' ? 45000 : 15000); return <div className="chk" key={`${c.subject}:${c.kind}`}><div><strong>{c.kind === 'readiness' ? 'Reviewed readiness' : c.kind === 'preview-https' ? 'Preview HTTPS verification' : c.kind === 'route' ? 'Route presence' : 'HTTP probe'}</strong><small className="mono muted runtime-meta">{c.subject}</small></div><div className="strip" role="img" aria-label={`Last ${c.results.length} results: ${c.results.map(r => r.ok === null ? 'not run' : r.ok ? 'pass' : 'fail').join(', ')}`}>{Array.from({length:30},(_,i) => c.results[i - (30 - c.results.length)]).map((r,i) => <i key={i} className={!r || r.ok === null ? 'n' : r.ok ? '' : 'f'} title={r ? `${r.at}: ${r.status ?? 'not run'}` : 'not run'}/>)}</div><Chip state={expired || last?.ok === null ? 'Unknown' : last?.ok ? 'Ready' : 'Failed'}>{expired || last?.ok === null ? '—' : last?.ok ? 'Pass' : 'Fail'}</Chip></div>; })}{checks && !checks.length && <p className="okline">No checks recorded yet.</p>}{!checks && <p className="okline">Reading check history…</p>}</section>}
        {exposure}{changes}
        {group.checkouts.some(c => c.recipe?.found && c.recipe.valid && c.recipe.approval !== 'approved') && <button className="btn" disabled={stale || !!working} onClick={() => onRequest(group.checkouts.find(c => c.recipe?.found)!.path)}>Request environment…</button>}
        <LinksTab links={links} publications={publications} details={details} enabled={!evidenceStale && lifecycleAvailable && !conflict && !working} onAction={onAction} previewErrors={previewErrors}/>
      </>}
      {activeTab === 'Logs' && managed && <LogsTab services={details?.logServices ?? []} load={loadLogs}/>}
      {activeTab === 'Services' && <ServicesTab services={services} stale={evidenceStale} environmentErrors={environmentErrors}/>}
      {activeTab === 'Agents' && <AgentsTab agents={agents} services={services} stale={evidenceStale} now={Date.now()}/>}
      {activeTab === 'Worktrees' && <WorktreesTab group={group} editorTemplate={editorTemplate} editorHost={editorHost}/>}
      {activeTab === 'Links' && <LinksTab links={links} publications={publications} details={details} enabled={!evidenceStale && lifecycleAvailable && !conflict && !working} onAction={onAction} previewErrors={previewErrors}/>}
      {(activeTab === 'Activity' || (mobile && tab === 'Activity')) && <>{mobile && <div className="card-h"><h3 id="activity-title">Activity</h3><button className="btn" onClick={() => onOpen('Overview')}>Back to Overview</button></div>}<p className="pv-note">Recorded listener, route, agent and check-change observations, plus Rootlane operations. No transcripts or inferred activity.</p>{activityError && <p role="alert">{activityError}</p>}{feed.map(e => <div className="ev" key={e.key}><time title={date(e.at)}>{time(e.at)}</time><span>{e.text}</span></div>)}{!feed.length && <p>No recorded events.</p>}</>}
    </div>
  </aside>;
}

function LinksTab({
  links,
  publications,
  details,
  enabled,
  onAction,
  previewErrors,
}: {
  links: GroupLink[];
  publications: PreviewStatus[];
  details: ProjectDetails | null;
  enabled: boolean;
  onAction: (id: string, action: 'publish' | 'unpublish') => void;
  previewErrors: Record<string, string>;
}) {
  return (
    <>
      <div className="environment-actions">
        {enabled &&
          details?.approvedTargetIds
            .filter((id) => !publications.some((p) => p.targetId === id && !p.removed))
            .map((id) => (
              <button className="btn primary" key={id} onClick={() => onAction(id, 'publish')}>
                Publish {label(id)}
              </button>
            ))}
        {enabled &&
          publications
            .filter((p) => !p.removed)
            .map((p) => (
              <button className="btn" key={p.id} onClick={() => onAction(p.id, 'unpublish')}>
                Unpublish {p.serviceName}
              </button>
            ))}
      </div>
      <Table headings={['Label', 'URL', 'Source', 'Target', 'HTTPS', 'Verified', 'State']}>
        {links.map((link) => (
          <tr key={link.key}>
            <td>{link.label}</td>
            <td>
              <a className="pv-url mono" href={link.url} target="_blank" rel="noreferrer" aria-label={`${link.label}, ${link.url}`}>
                <span>{link.url}</span>
                <Icon name="external" />
              </a>
            </td>
            <td>{link.source}</td>
            <td className="mono">{link.target ?? '—'}</td>
            <td>{link.https ?? '—'}</td>
            <td>{date(link.verifiedAt)}</td>
            <td>
              <Chip state={link.state} />
              {link.operation && (
                <span className="operation-status" role="status">
                  {link.operation.action} · {label(link.operation.status)}
                  {link.operation.error && ` · ${link.operation.error.code}: ${link.operation.error.message}`}
                </span>
              )}
              {previewErrors[link.key] && <span role="alert">{previewErrors[link.key]} · Observation stale</span>}
            </td>
          </tr>
        ))}
      </Table>
      {!links.length && <p className="empty">No links</p>}
    </>
  );
}

type CardProps = Parameters<typeof ProjectDetailsPanel>[0];

function WorktreesTab({
  group,
  editorTemplate,
  editorHost,
}: {
  group: CardProps['group'];
  editorTemplate: CardProps['editorTemplate'];
  editorHost: CardProps['editorHost'];
}) {
  return (
    <Table headings={['Name', 'Branch', 'Changes', 'Ahead / behind', 'Last commit', 'Path', 'Listening ports', 'Agents']}>
      {group.checkouts.map((p) => (
        <tr key={p.id}>
          <td className="strong">{p.name}</td>
          <td className="mono">{branchLabel(p)}</td>
          <td className="mono">{p.git?.dirty ?? '—'}</td>
          <td className="mono">
            {p.git?.ahead ?? '—'} / {p.git?.behind ?? '—'}
          </td>
          <td>
            <span className="mono">{p.git?.lastCommit?.sha7 ?? '—'}</span> {p.git?.lastCommit?.subject}
            <span className="muted"> {p.git?.lastCommit ? date(p.git.lastCommit.committedAt) : ''}</span>
          </td>
          <td>
            <PathLink path={p.path} template={editorTemplate} host={editorHost} />
          </td>
          <td className="mono">{p.runtime.ports.map((port) => ':' + port).join(', ') || '—'}</td>
          <td>{p.agents.length || '—'}</td>
        </tr>
      ))}
    </Table>
  );
}

function AgentsTab({ agents, services, stale, now }: { agents: ReturnType<typeof groupAgents>; services: ReturnType<typeof groupServices>; stale: boolean; now: number }) {
  return <><Table headings={['Agent','Working in','Running for','PID','Own ports','Started']}>
    {agents.map(a => <tr key={agentKey(a)}><td><span className="agent-name"><Mark name={a.name}/>{a.name}</span><small>{a.source === 'detected process' ? 'Detected' : 'Registered'}</small></td><td className="mono">{a.source === 'detected process' ? a.worktreePath ?? a.cwd ?? '—' : '—'}</td><td className="mono">{!stale && a.source === 'detected process' ? elapsed(a.startedAt,now) ?? '—' : '—'}</td><td>{a.source === 'detected process' ? a.pid ?? '—' : '—'}</td><td>{!stale && a.source === 'detected process' ? a.ports?.map(p => ':'+p).join(', ') || '—' : '—'}</td><td>{!stale && a.source === 'detected process' ? services.filter(s => s.startedBy?.pid === a.pid).map(s => `${s.name} :${s.port}`).join(', ') || '—' : '—'}</td></tr>)}
  </Table>{!agents.length && <p>No agents observed.</p>}<p className="pv-note">Detected processes do not establish activity. Rootlane does not read transcripts.</p></>;
}
function ServicesTab({ services, stale, environmentErrors }: { services: ReturnType<typeof groupServices>; stale: boolean; environmentErrors: Record<string,string> }) {
  return <><Table headings={['Process','Port','Bound to','PID','Started','Owner','State']}>
    {services.map(s => <tr key={s.key}><td>{s.name}<small className="mono runtime-meta">{shortPath(s.checkout.path)}</small></td><td className="mono">:{s.port}</td><td className="mono">{stale ? '—' : s.binds.map(l => l.bind).join(', ') || '—'}</td><td>{s.process?.pid ?? '—'}</td><td>{stale ? '—' : date(s.process?.startedAt)}</td><td>{s.managed ? `Rootlane · ${s.serviceId}` : s.startedBy ? `Started by ${s.startedBy.name}` : 'Observed'}</td><td><Chip state={stale || s.checkout.environmentIds.some(id => environmentErrors[id]) ? 'Unknown' : s.state}/></td></tr>)}
  </Table>{!services.length && <p>No services observed.</p>}</>;
}
