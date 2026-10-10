import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { environmentOutput, logsOutput, projectOutput, previewOutput, type Environment, type ProjectDetails, type PreviewStatus } from '../src/shared/contracts';
import './style.css';
import { groupProjects, loadCatalog, projectStatus, label, agentKey } from './projects';
import { Icon, Logo } from './icons';
import { polling } from './polling';
import { McpSetup } from './mcp-setup';
type Catalog = Awaited<ReturnType<typeof loadCatalog>>;
async function json(path: string, body?: unknown, csrf?: string, signal?: AbortSignal) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-rootlane-csrf': csrf ?? '' }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status === 401 ? 'Unlock required. ' : ''}${value.message ?? 'Request failed'}`);
  return value;
}
function ProjectActions({ projectId, name, open, detailsId, hasLogs, onDetails, onLogs, onPaths, onCopy }: { projectId: string; name: string; open: boolean; detailsId: string; hasLogs: boolean; onDetails: () => void; onLogs: () => void; onPaths: () => void; onCopy: () => Promise<void> }) {
  const button = useRef<HTMLButtonElement>(null); const popover = useRef<HTMLDivElement>(null); const [menuOpen, setMenuOpen] = useState(false);
  const dismiss = (work: () => void) => { popover.current?.hidePopover(); work(); button.current?.focus(); };
  return <div className="project-actions"><button ref={button} onClick={e => e.currentTarget.focus()} id={`actions-${projectId}`} className="icon-button" aria-label={`${name} actions`} aria-expanded={menuOpen} popoverTarget={`menu-${projectId}`}><Icon name="more"/></button><div ref={popover} id={`menu-${projectId}`} popover="auto" className="project-popover" onToggle={e => { const showing = e.newState === 'open'; setMenuOpen(showing); if (!showing && (document.activeElement === document.body || popover.current?.contains(document.activeElement))) button.current?.focus(); }}><button onClick={() => dismiss(onDetails)} aria-expanded={open} aria-controls={detailsId}>{open ? 'Hide details' : 'Details'}</button>{hasLogs && <button onClick={() => dismiss(onLogs)}>Logs</button>}<button onClick={() => dismiss(onPaths)}>View paths</button><button onClick={() => dismiss(() => { void onCopy(); })}>Copy paths</button></div></div>;
}
function App() {
  const [csrf, setCsrf] = useState<string | null>(null); const [checking, setChecking] = useState(true);
  const [credential, setCredential] = useState(''); const [error, setError] = useState('');
  const [catalog, setCatalog] = useState<Catalog | null>(null); const [cursor, setCursor] = useState(0);
  const [view, setView] = useState<'projects' | 'settings'>('projects');
  const [settingsPage, setSettingsPage] = useState<'connection' | 'mcp'>('connection');
  const [query, setQuery] = useState(''); const [sort, setSort] = useState('name');
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const detailAbort = useRef(new AbortController());
  const logAbort = useRef(new AbortController());
  const [details, setDetails] = useState<ProjectDetails | null>(null);
  const [projectError, setProjectError] = useState(''); const [catalogError, setCatalogError] = useState('');
  const [environmentErrors, setEnvironmentErrors] = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, PreviewStatus>>({}); const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  const [logsError, setLogsError] = useState('');
  const refreshController = useRef<ReturnType<typeof polling> | null>(null);
  const selectProject = (id: string | null) => {
    detailAbort.current.abort(); detailAbort.current = new AbortController();
    logAbort.current.abort(); logAbort.current = new AbortController();
    selectedRef.current = id; setSelected(id); setDetails(null); setProjectError(''); setLogs(null); setLogsError('');
    void refreshController.current?.refresh();
  };
  const [tailnetHostname, setTailnetHostname] = useState<string | null>(null);
  const [lifecycleAvailable, setLifecycleAvailable] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => { const focusSearch = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setView('projects'); searchInput.current?.focus(); } }; window.addEventListener('keydown', focusSearch); return () => window.removeEventListener('keydown', focusSearch); }, []);
  const catalogRef = useRef(catalog); catalogRef.current = catalog;
  const [environments, setEnvironments] = useState<Record<string, Environment>>({});
  const [connection, setConnection] = useState('Connecting'); const [tailscale, setTailscale] = useState('Unknown');
  const [working, setWorking] = useState<string | null>(null); const [logs, setLogs] = useState<{ title: string; lines: string[]; truncated: boolean } | null>(null);
  useEffect(() => { const abort = new AbortController(); json('/api/session', undefined, undefined, abort.signal).then(s => { if (!abort.signal.aborted) setCsrf(s.csrf); }).catch(() => {}).finally(() => { if (!abort.signal.aborted) setChecking(false); }); return () => abort.abort(); }, []);
  useEffect(() => {
    if (!csrf) return;
    detailAbort.current = new AbortController(); logAbort.current = new AbortController();
    const controller = polling(async signal => {
      const failed = (e: unknown) => { if (String(e).includes('Unlock required')) setCsrf(null); return String(e); };
      await Promise.allSettled([
        json('/api/status', undefined, undefined, signal).then(status => {
          if (signal.aborted) return;
          setConnection('Connected'); setTailscale(status.tailscale.status === 'connected' ? 'Connected' : 'Unavailable'); setTailnetHostname(status.tailscale.hostname); setLifecycleAvailable(status.lifecycleAvailable);
        }).catch(e => { if (!signal.aborted) { failed(e); setConnection('Disconnected'); setTailscale('Unknown'); setLifecycleAvailable(false); } }),
        loadCatalog(cursor => json('/api/tools/list_projects', { cursor, limit: 50 }, csrf, signal)).then(data => {
          if (signal.aborted) return;
          setCatalog(data); setCatalogError('');
          if (selectedRef.current && !data.projects.some(p => p.id === selectedRef.current)) selectProject(null);
        }).catch(e => { if (!signal.aborted) setCatalogError(failed(e)); })
      ]);
      const id = selectedRef.current; if (!id || signal.aborted) return;
      const selectionSignal = AbortSignal.any([signal, detailAbort.current.signal]);
      const current = () => !selectionSignal.aborted && selectedRef.current === id;
      try {
        const data = projectOutput.parse(await json('/api/tools/get_project', { projectId: id }, csrf, selectionSignal));
        if (!current()) return;
        setDetails(data); setProjectError('');
        await Promise.allSettled([
          ...data.checkoutIds.flatMap(checkout => (catalogRef.current?.projects.find(p => p.id === checkout)?.environmentIds ?? []).map(async environmentId => {
            try { const env = environmentOutput.parse(await json('/api/tools/get_environment', { environmentId }, csrf, selectionSignal)); if (current()) { setEnvironments(prev => ({ ...prev, [environmentId]: env })); setEnvironmentErrors(prev => ({ ...prev, [environmentId]: '' })); } }
            catch (e) { if (current()) setEnvironmentErrors(prev => ({ ...prev, [environmentId]: failed(e) })); }
          })),
          ...data.previews.map(async ({ previewId }) => {
            try { const preview = previewOutput.parse(await json('/api/tools/get_preview', { previewId }, csrf, selectionSignal)); if (current()) { setPreviews(prev => ({ ...prev, [previewId]: preview })); setPreviewErrors(prev => ({ ...prev, [previewId]: '' })); } }
            catch (e) { if (current()) setPreviewErrors(prev => ({ ...prev, [previewId]: failed(e) })); }
          })
        ]);
      } catch (e) { if (current()) setProjectError(failed(e)); }
    });
    refreshController.current = controller;
    void controller.refresh();
    const timer = window.setInterval(() => { void controller.refresh(); }, 5000);
    const visible = () => { if (!document.hidden) void controller.refresh(); }; document.addEventListener('visibilitychange', visible);
    return () => { controller.stop(); detailAbort.current.abort(); logAbort.current.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [csrf]);
  async function login(event: React.FormEvent) {
    event.preventDefault(); setWorking('login'); setError('');
    try { const response = await json('/api/login', { credential }); setCredential(''); setCsrf(response.csrf); }
    catch (e) { setError(String(e)); } finally { setWorking(null); }
  }
  async function showLogs(id: string, serviceId: string) {
    logAbort.current.abort(); logAbort.current = new AbortController();
    const signal = logAbort.current.signal; const projectId = selectedRef.current;
    setLogsError(''); setLogs(previous => previous?.title === `${id} / ${serviceId}` ? previous : { title: `${id} / ${serviceId}`, lines: [], truncated: false });
    try { const data = logsOutput.parse(await json('/api/tools/get_logs', { environmentId: id, serviceId, limit: 50 }, csrf!, signal)); if (!signal.aborted && selectedRef.current === projectId) setLogs({ title: `${id} / ${serviceId}`, lines: data.lines, truncated: data.truncated }); }
    catch (e) { if (!signal.aborted && selectedRef.current === projectId) setLogsError(String(e)); }
  }
  const allGroups = groupProjects(catalog?.projects ?? []);
  const filtered = allGroups.filter(group => [group.primary.name, ...group.checkouts.map(p => p.name), ...group.environmentIds.map(label)].some(name => name.toLowerCase().includes(query.toLowerCase())));
  if (sort === 'status') filtered.sort((a,b) => projectStatus(a, environments).localeCompare(projectStatus(b, environments)) || a.primary.name.localeCompare(b.primary.name));
  const pageStart = Math.min(cursor, Math.max(0, Math.floor((filtered.length-1)/25)*25));
  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><Logo/><div><strong>Rootlane</strong><span>Local project control.</span></div></div>
      <div className="search"><Icon name="search"/><input ref={searchInput} aria-label="Search projects" placeholder="Search projects…" value={query} disabled={!csrf} onChange={e => { setQuery(e.target.value); setCursor(0); setView('projects'); }}/><kbd>⌘ K</kbd></div>
      <div className="connection" aria-live="polite"><span aria-label={`Tailscale: ${tailscale}`} title={`Tailscale: ${tailscale}`}><Icon name="link"/>Tailscale{tailscale !== 'Connected' && <small className="muted">{tailscale}</small>}</span><span className={connection === 'Connected' && csrf ? 'success' : 'muted'}><i className={`dot ${connection === 'Connected' && csrf ? 'good' : 'quiet'}`}/>{csrf ? connection : 'Locked'}</span></div>
    </header>
    <aside className="sidebar"><nav aria-label="Main navigation"><button className={view === 'projects' ? 'selected' : ''} onClick={() => setView('projects')} aria-current={view === 'projects' ? 'page' : undefined}><Icon name="folder"/>Projects</button><button className={view === 'settings' ? 'selected' : ''} onClick={() => setView('settings')} aria-current={view === 'settings' ? 'page' : undefined}><Icon name="settings"/>Settings</button></nav><div className="sidebar-foot"><Icon name="moon"/><p>Private workspace<span>Local project control.</span></p></div></aside>
    <main>
      {error && <div role="alert" className="error-banner"><span>{error}</span><button onClick={() => { setError(''); void refreshController.current?.refresh(); }}>Retry</button></div>}
      {!csrf ? <section className="unlock" aria-labelledby="unlock"><h1 id="unlock">Unlock Rootlane</h1><p className="muted">Your private project workspace.</p>{checking ? <p>Checking connection…</p> : <form onSubmit={login}><label htmlFor="credential">Installation owner credential</label><input id="credential" type="password" autoComplete="current-password" value={credential} onChange={e => setCredential(e.target.value)} required/><button className="primary" disabled={working === 'login'}>{working === 'login' ? 'Unlocking…' : 'Unlock'}</button></form>}</section>
      : view === 'settings' ? <section className="settings-page"><h1>Settings</h1><nav className="settings-nav" aria-label="Settings pages"><button aria-current={settingsPage === 'connection' ? 'page' : undefined} onClick={() => setSettingsPage('connection')}>Connection and access</button><button aria-current={settingsPage === 'mcp' ? 'page' : undefined} onClick={() => setSettingsPage('mcp')}>MCP setup</button></nav>{settingsPage === 'mcp' ? <McpSetup/> : <><p className="muted">Connection and access</p><dl><dt>Rootlane</dt><dd>{connection}</dd><dt>Operator address</dt><dd>{location.origin}</dd><dt>Tailscale</dt><dd>{tailscale}</dd><dt>Tailnet hostname</dt><dd>{tailnetHostname ?? 'Unavailable'}</dd><dt>Last observation</dt><dd>{catalog ? new Date(catalog.observedAt).toLocaleString() : 'Unavailable'}</dd><dt>Lifecycle</dt><dd>{connection === 'Connected' ? lifecycleAvailable ? 'Available' : 'Unavailable' : 'Unknown'}</dd><dt>Ownership</dt><dd>Existing projects are observe-only. Only reviewed environments have lifecycle controls.</dd></dl><p className="muted">Configuration is owner-controlled on the host. This view is read-only.</p></>}</section>
      : <>
        <div className="page-heading"><div><h1>Projects</h1><p>{allGroups.length} {allGroups.length === 1 ? 'project' : 'projects'}{query ? ` · ${filtered.length} matching` : ''}</p></div><div className="page-controls"><button className="icon-button" aria-label="Refresh projects" onClick={() => void refreshController.current?.refresh()}><Icon name="refresh"/></button><label className="sort">Sort by<select aria-label="Sort projects" value={sort} onChange={e => { setSort(e.target.value); setCursor(0); }}><option value="name">Name</option><option value="status">Status</option></select></label></div></div>
        {catalogError && <div role="alert" className="error-banner">Catalog: {catalogError}{catalog && ' · Showing the last successful observation.'}</div>}
        {!!catalog?.warnings.length && <details className="catalog-notice"><summary>Discovery notices ({catalog.warnings.length})</summary>{catalog.warnings.map(w => <p key={w}>{w}</p>)}</details>}
        {!catalog && <p className="empty-state">Reading project directories…</p>}
        {catalog && !filtered.length && <p className="empty-state">{query ? 'No projects match your search.' : 'No projects found in the configured roots.'}</p>}
        <div className="project-list">{filtered.slice(pageStart, pageStart+25).map(group => {
          const project = group.primary; const open = selected === project.id; const status = projectStatus(group, environments);
          const services = group.checkouts.flatMap(p => p.runtime.ports.map(port => ({ name: p.runtime.services.find(s => s.port === port)?.name ?? `Port ${port}`, key: `${p.id}:${port}` })));
          const logServices = group.checkouts.flatMap(p => p.logServices);
          const activeDetails = open && details?.project.id === project.id ? details : null;
          const detailsId = `details-${project.id}`;
          return <article className="project" key={group.id} id={`project-${project.id}`} tabIndex={-1} aria-label={`${project.name} project`}>
            <div className="project-row"><div className="project-symbol"><Icon name="folder"/></div><div className="project-title"><h2>{project.name}</h2><p className="muted">{project.detached ? 'Detached' : project.branch ?? 'Folder'}{group.worktreeCount ? ` · ${group.worktreeCount} worktrees` : ''}{group.checkouts.length > 1 ? ` · ${group.checkouts.length} checkouts` : ''}</p></div><p className="row-services muted">{catalogError || connection !== 'Connected' ? 'Observation stale' : services.length ? `${services.slice(0,2).map(s => s.name).join(', ')}${services.length > 2 ? ` +${services.length-2}` : ''} · Listening` : status === 'Unknown' ? 'Observation unknown' : 'No listener observed'}</p><ProjectActions projectId={project.id} name={project.name} open={open} detailsId={detailsId} hasLogs={logServices.length > 0} onDetails={() => selectProject(open ? null : project.id)} onLogs={() => { if (!open) selectProject(project.id); requestAnimationFrame(() => document.getElementById(detailsId)?.scrollIntoView({block:'nearest'})); }} onPaths={() => { if (!open) selectProject(project.id); requestAnimationFrame(() => document.getElementById(detailsId)?.scrollIntoView({block:'nearest'})); }} onCopy={async () => { try { await navigator.clipboard.writeText(group.checkouts.map(p => p.path).join('\n')); } catch { selectProject(project.id); setProjectError('Copy unavailable. Select a path in details.'); } }}/></div>
            {open && <div className="project-details" id={detailsId}><div className="details-header"><h3>Project details</h3><button className="text-button" onClick={() => { selectProject(null); requestAnimationFrame(() => document.getElementById(`actions-${project.id}`)?.focus()); }} aria-label={`Collapse ${project.name}`}>Collapse<Icon name="chevron" style={{transform:'rotate(180deg)'}}/></button></div>{projectError && <p role="alert" className="warning">{projectError}</p>}{!activeDetails && !projectError && <p className="muted">Loading project details…</p>}{group.checkouts.map(checkout => <section className="worktree" key={checkout.id}><h4>{checkout === project ? project.name : checkout.name}<span className="muted">{checkout.detached ? 'Detached' : checkout.branch ?? 'Folder'}</span></h4><p className="path">{checkout.path}</p><p className="muted">{catalogError || connection !== 'Connected' ? 'Observation stale' : checkout.runtime.ports.length ? `Listening on ${checkout.runtime.ports.map(p => ':'+p).join(', ')}` : checkout.runtime.status === 'unknown' ? 'Runtime unknown' : 'No runtime observed'}</p>{activeDetails?.services.filter(s => s.checkoutId === checkout.id).map(s => <p key={s.port}>{s.name} · Port {s.port}<span className="muted"> · Listener observed; readiness unverified</span></p>)}{activeDetails?.previews.filter(p => p.checkoutId === checkout.id).map(({previewId,serviceId}) => { const preview=previews[previewId]; return <section className="environment" key={previewId}><h4>{preview?.serviceName ?? label(serviceId)}</h4>{previewErrors[previewId] && <p role="alert" className="warning">{previewErrors[previewId]} · Observation stale</p>}{preview && <><p>{previewErrors[previewId] || projectError || connection !== 'Connected' ? 'Last observation (stale)' : 'Current observation'}: Route {preview.route} · Upstream {preview.upstream} · HTTPS {preview.https}</p><a href={preview.url} target="_blank" rel="noreferrer">{preview.url}</a><pre>{JSON.stringify(preview.actualConfiguration,null,2)}</pre>{preview.errors.map((e,i) => <p className="warning" key={i}>{e.message}</p>)}</>}</section>; })}{checkout.logServices.map(s => <button key={s.environmentId+'/'+s.serviceId} onClick={() => void showLogs(s.environmentId,s.serviceId)}>{label(s.serviceId)} logs</button>)}{checkout.agents.map(a => <p key={agentKey(a)}>{a.name}<span className="muted"> · {a.source}</span></p>)}{checkout.links.length > 0 && <nav aria-label={`${checkout.name} links`}>{checkout.links.map(l => <a key={l.url} href={l.url} target="_blank" rel="noreferrer">{l.label}<Icon name="external"/></a>)}</nav>}{checkout.environmentIds.map(id => {
              const env = environments[id];
              return <section className="environment" key={id}><h4>{label(id)}<span className="muted">{environmentErrors[id] || projectError || connection !== 'Connected' ? 'Observation stale' : env ? label(env.application) : 'Loading…'}</span></h4>{environmentErrors[id] && <p role="alert" className="warning">{environmentErrors[id]}</p>}<p className="muted">Preview: {environmentErrors[id] || projectError || connection !== 'Connected' ? 'Unknown' : env ? label(env.preview) : 'Unknown'}</p>{env?.links.map(l => <a key={l.url} href={l.url} target="_blank" rel="noreferrer">{l.label}</a>)}{env?.observationError && <p className="warning">{env.observationError.message}</p>}</section>;
            })}</section>)}</div>}
          </article>;
        })}</div>
        {catalog && <footer><span>Observed {new Date(catalog.observedAt).toLocaleTimeString()}</span>{filtered.length > 25 && <><button disabled={!pageStart} onClick={() => setCursor(Math.max(0,pageStart-25))}>Previous</button><button disabled={pageStart+25 >= filtered.length} onClick={() => setCursor(pageStart+25)}>Next</button></>}</footer>}
        {logs && <section className="log-panel" aria-label="Journal logs"><div className="toolbar"><h2>{logs.title}</h2><button onClick={() => { logAbort.current.abort(); setLogs(null); setLogsError(''); document.getElementById(`actions-${selected}`)?.focus(); }}>Close logs</button></div>{logsError && <p role="alert" className="warning">{logsError}</p>}{logs.truncated && <p className="muted">Latest 50 entries, up to 2 KiB each.</p>}<pre>{logs.lines.join('\n') || 'No recorded output available.'}</pre></section>}
      </>}
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
