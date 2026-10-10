import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { environmentOutput, logsOutput, type Environment } from '../src/shared/contracts';
import './style.css';
import { groupProjects, loadCatalog, projectStatus, label, groupAgents, agentKey, agentLabel } from './projects';
import { Icon, Logo } from './icons';
import { McpSetup } from './mcp-setup';
type Catalog = Awaited<ReturnType<typeof loadCatalog>>;
async function json(path: string, body?: unknown, csrf?: string) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-rootlane-csrf': csrf ?? '' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status === 401 ? 'Unlock required. ' : ''}${value.message ?? 'Request failed'}`);
  return value;
}
function App() {
  const [csrf, setCsrf] = useState<string | null>(null); const [checking, setChecking] = useState(true);
  const [credential, setCredential] = useState(''); const [error, setError] = useState('');
  const [catalog, setCatalog] = useState<Catalog | null>(null); const [cursor, setCursor] = useState(0);
  const [view, setView] = useState<'projects' | 'settings'>('projects');
  const [settingsPage, setSettingsPage] = useState<'connection' | 'mcp'>('connection');
  const [query, setQuery] = useState(''); const [sort, setSort] = useState('name');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tailnetHostname, setTailnetHostname] = useState<string | null>(null);
  const [lifecycleAvailable, setLifecycleAvailable] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const toggle = (id: string) => setExpanded(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; });
  useEffect(() => { const focusSearch = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setView('projects'); searchInput.current?.focus(); } }; window.addEventListener('keydown', focusSearch); return () => window.removeEventListener('keydown', focusSearch); }, []);
  const [environments, setEnvironments] = useState<Record<string, Environment>>({});
  const [connection, setConnection] = useState('Connecting'); const [tailscale, setTailscale] = useState('Unknown');
  const [working, setWorking] = useState<string | null>(null); const [logs, setLogs] = useState<{ title: string; lines: string[]; truncated: boolean } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const retries = useRef(new Map<string, string>());
  useEffect(() => { json('/api/session').then(s => setCsrf(s.csrf)).catch(() => {}).finally(() => setChecking(false)); }, []);
  useEffect(() => {
    if (!csrf) return;
    let stopped = false; let polling = false;
    async function poll() {
      if (document.hidden || polling) return; polling = true;
      try {
        const [data, status] = await Promise.all([loadCatalog(cursor => json('/api/tools/list_projects', { cursor, limit: 50 }, csrf!)), json('/api/status')]);
        const parsed = data;
        const ids = [...new Set(parsed.projects.flatMap(p => p.environmentIds))];
        const values = await Promise.all(ids.map(id => json('/api/tools/get_environment', { environmentId: id }, csrf!).then(v => environmentOutput.parse(v))));
        if (!stopped) { setCatalog(parsed); setEnvironments(Object.fromEntries(values.map(v => [v.id, v]))); setConnection('Connected'); setTailscale(status.tailscale.status === 'connected' ? 'Connected' : 'Unavailable'); setTailnetHostname(status.tailscale.hostname); setLifecycleAvailable(status.lifecycleAvailable); }
      } catch (e) { if (!stopped) { setConnection('Disconnected'); setTailscale('Unknown'); setLifecycleAvailable(false); setError(String(e)); if (String(e).includes('Unlock required')) setCsrf(null); } }
      finally { polling = false; }
    }
    void poll(); const timer = window.setInterval(() => { void poll(); }, 5000);
    const visible = () => { if (!document.hidden) void poll(); }; document.addEventListener('visibilitychange', visible);
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [csrf, refresh]);
  async function login(event: React.FormEvent) {
    event.preventDefault(); setWorking('login'); setError('');
    try { const response = await json('/api/login', { credential }); setCredential(''); setCsrf(response.csrf); }
    catch (e) { setError(String(e)); } finally { setWorking(null); }
  }
  async function action(id: string, action: 'start' | 'stop') {
    const key = `${id}/${action}`; const requestId = retries.current.get(key) ?? crypto.randomUUID(); retries.current.set(key, requestId);
    setWorking(id); setError('');
    try { await json(`/api/tools/${action}_environment`, { environmentId: id, requestId }, csrf!); retries.current.delete(key); }
    catch (e) { setError(`${String(e)}. Retrying this action will reuse its request ID.`); }
    finally { setWorking(null); setRefresh(n => n + 1); }
  }
  async function showLogs(id: string, serviceId: string) {
    setError('');
    try { const data = logsOutput.parse(await json('/api/tools/get_logs', { environmentId: id, serviceId, limit: 50 }, csrf!)); setLogs({ title: `${id} / ${serviceId}`, lines: data.lines, truncated: data.truncated }); }
    catch (e) { setError(String(e)); }
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
      {error && <div role="alert" className="error-banner"><span>{error}</span><button onClick={() => { setError(''); setRefresh(n => n+1); }}>Retry</button></div>}
      {!csrf ? <section className="unlock" aria-labelledby="unlock"><h1 id="unlock">Unlock Rootlane</h1><p className="muted">Your private project workspace.</p>{checking ? <p>Checking connection…</p> : <form onSubmit={login}><label htmlFor="credential">Installation owner credential</label><input id="credential" type="password" autoComplete="current-password" value={credential} onChange={e => setCredential(e.target.value)} required/><button className="primary" disabled={working === 'login'}>{working === 'login' ? 'Unlocking…' : 'Unlock'}</button></form>}</section>
      : view === 'settings' ? <section className="settings-page"><h1>Settings</h1><nav className="settings-nav" aria-label="Settings pages"><button aria-current={settingsPage === 'connection' ? 'page' : undefined} onClick={() => setSettingsPage('connection')}>Connection and access</button><button aria-current={settingsPage === 'mcp' ? 'page' : undefined} onClick={() => setSettingsPage('mcp')}>MCP setup</button></nav>{settingsPage === 'mcp' ? <McpSetup/> : <><p className="muted">Connection and access</p><dl><dt>Rootlane</dt><dd>{connection}</dd><dt>Operator address</dt><dd>{location.origin}</dd><dt>Tailscale</dt><dd>{tailscale}</dd><dt>Tailnet hostname</dt><dd>{tailnetHostname ?? 'Unavailable'}</dd><dt>Last observation</dt><dd>{catalog ? new Date(catalog.observedAt).toLocaleString() : 'Unavailable'}</dd><dt>Lifecycle</dt><dd>{connection === 'Connected' ? lifecycleAvailable ? 'Available' : 'Unavailable' : 'Unknown'}</dd><dt>Ownership</dt><dd>Existing projects are observe-only. Only reviewed environments have lifecycle controls.</dd></dl><p className="muted">Configuration is owner-controlled on the host. This view is read-only.</p></>}</section>
      : <>
        <div className="page-heading"><div><h1>Projects</h1><p>{allGroups.length} {allGroups.length === 1 ? 'project' : 'projects'}{query ? ` · ${filtered.length} matching` : ''}</p></div><div className="page-controls"><button className="icon-button" aria-label="Refresh projects" onClick={() => setRefresh(n => n+1)}><Icon name="refresh"/></button><label className="sort">Sort by<select aria-label="Sort projects" value={sort} onChange={e => { setSort(e.target.value); setCursor(0); }}><option value="name">Name</option><option value="status">Status</option></select></label></div></div>
        {!!catalog?.warnings.length && <details className="catalog-notice"><summary>Discovery notices ({catalog.warnings.length})</summary>{catalog.warnings.map(w => <p key={w}>{w}</p>)}</details>}
        {!catalog && <p className="empty-state">Reading project directories…</p>}
        {catalog && !filtered.length && <p className="empty-state">{query ? 'No projects match your search.' : 'No projects found in the configured roots.'}</p>}
        <div className="project-list">{filtered.slice(pageStart, pageStart+25).map(group => {
          const project = group.primary; const open = expanded.has(group.id); const status = projectStatus(group, environments);
          const agents = groupAgents(group);
          const envs = group.environmentIds.map(id => environments[id]).filter((e): e is Environment => !!e);
          const observedServices = group.checkouts.flatMap(p => p.runtime.ports.map(port => ({ name: 'Listener', detail: `:${port}`, state: 'Listening', key: `${p.id}:${port}` })));
          const managedServices = envs.flatMap(e => e.services.map(s => ({ name: label(s.id), detail: '', state: e.application === 'ready' ? 'Ready' : label(s.state), key: `${e.id}:${s.id}` })));
          const services = [...managedServices, ...observedServices];
          const links = [...new Map(group.checkouts.flatMap(p => p.links).map(l => [l.url, l])).values()];
          const managedLinks = envs.filter(e => e.preview === 'available').flatMap(e => e.links);
          const usefulLinks = links.filter(l => l.label !== 'Observed preview');
          const observedLinks = links.filter(l => l.label === 'Observed preview');
          const previews = managedLinks.length ? managedLinks : observedLinks;
          const previewStatus = managedLinks.length ? 'Available' : observedLinks.length ? 'Published' : envs.some(e => e.preview === 'unknown') ? 'Unknown' : 'Not exposed';
          const badges = [...new Set(group.checkouts.flatMap(p => p.manifests.flatMap(m => m.endsWith('package.json') ? ['Node'] : /pyproject.toml|requirements.txt/.test(m) ? ['Python'] : m === 'Cargo.toml' ? ['Rust'] : m === 'go.mod' ? ['Go'] : [])))];
          const hasLogs = envs.some(e => e.services.length);
          const detailsId = `details-${project.id}`;
          return <article className="project" key={group.id} id={`project-${project.id}`} tabIndex={-1} aria-label={`${project.name} project`}>
            <div className="project-heading"><div className="project-symbol"><Icon name="folder"/></div><div className="project-title"><h2>{project.name}<span className={`project-status ${status === 'Ready' ? 'success' : status === 'Attention' ? 'warning' : 'muted'}`}>{status}</span></h2><div className="badges">{badges.map(b => <span className={`badge ${b === 'Python' ? 'teal' : ''}`} key={b}>{b}</span>)}<span className="ownership">{envs.length ? 'Reviewed environments' : 'Observe-only'}</span></div></div><div className="project-counts">{group.worktreeCount > 0 && <button className="text-button details-toggle" aria-expanded={open} aria-controls={detailsId} onClick={() => toggle(group.id)}><Icon name="branch"/>{group.worktreeCount} worktrees</button>}{group.environmentIds.length > 0 && <button className="text-button details-toggle" aria-expanded={open} aria-controls={detailsId} onClick={() => toggle(group.id)}>{group.environmentIds.length} environments</button>}</div></div>
            <div className="project-summary">
              <section className="summary-section agents-summary"><h3><Icon name="agents"/>Agents</h3>{agents.length ? agents.slice(0,2).map(a => <div className="summary-row" key={agentKey(a)}><i className={a.source === 'detected process' ? 'dot quiet' : 'dot registered'}/><span>{a.name}</span><small title={a.source === 'detected process' ? 'Process observed; task and activity unknown' : a.source}>{agentLabel(a)}</small></div>) : <span className="muted" aria-label="No agents observed or registered">—</span>}{agents.length > 2 && <button className="text-button" onClick={() => setExpanded(prev => new Set([...prev,group.id]))}>+{agents.length-2} {agents.length === 3 ? 'agent' : 'agents'}</button>}</section>
              <section className="summary-section services-summary"><h3><Icon name="services"/>Services</h3>{services.length ? services.slice(0,2).map(s => <div className="summary-row" key={s.key}><i className={`dot ${s.state === 'Ready' ? 'good' : s.state === 'Listening' ? 'registered' : 'quiet'}`}/><span>{s.name}</span><small>{s.detail || s.state}</small></div>) : <span className="muted">{status === 'Unknown' ? 'Unknown' : 'Not observed'}</span>}{services.length > 2 && <button className="text-button" onClick={() => setExpanded(prev => new Set([...prev,group.id]))}>+{services.length-2} services</button>}</section>
              <section className="summary-section preview-summary"><h3><Icon name="globe"/>Preview</h3><div className="summary-row"><i className={`dot ${previewStatus === 'Available' ? 'good' : previewStatus === 'Published' ? 'registered' : 'quiet'}`}/><span className={previewStatus === 'Available' ? 'success' : 'muted'}>{previewStatus}</span></div>{previews[0] && <a className="preview-url" href={previews[0].url} target="_blank" rel="noreferrer" title={previews[0].url}>{new URL(previews[0].url).host}<Icon name="external"/></a>}{usefulLinks.slice(0,1).map(l => <a className="preview-url" key={l.url} href={l.url} target="_blank" rel="noreferrer">{l.label}<Icon name="external"/></a>)}</section>
              <div className="card-actions"><span title="Opening a host folder is unavailable in this browser"><button disabled aria-label="Open folder — unavailable in this browser"><Icon name="folder"/>Open folder</button></span>{previews[0] ? <a className="button primary" href={previews[0].url} target="_blank" rel="noreferrer"><Icon name="external"/>Open preview</a> : <button disabled title="No verified preview route is available"><Icon name="link"/>Open preview</button>}<button disabled={!hasLogs} title={hasLogs ? 'Choose a managed service in project details' : 'No Rootlane-owned service logs'} onClick={() => setExpanded(prev => new Set([...prev,group.id]))}><Icon name="logs"/>View logs</button><details className="more"><summary className="button"><Icon name="more"/>More</summary><div className="more-menu"><button onClick={e => { toggle(group.id); const menu=e.currentTarget.closest('details'); menu?.removeAttribute('open'); menu?.querySelector('summary')?.focus(); }} aria-expanded={open} aria-controls={detailsId}>{open ? 'Hide details' : 'Show details'}</button><button onClick={async e => { const menu=e.currentTarget.closest('details'); menu?.removeAttribute('open'); menu?.querySelector('summary')?.focus(); try { await navigator.clipboard.writeText(project.path); } catch { setError('Path could not be copied. Open details to copy it manually.'); } }}>Copy path</button>{usefulLinks.map(l => <a key={l.url} href={l.url} target="_blank" rel="noreferrer">{l.label}<Icon name="external"/></a>)}</div></details></div>
            </div>
            {open && <div className="project-details" id={detailsId}><div className="details-header"><h3>Project details</h3><button className="text-button" onClick={() => { toggle(group.id); requestAnimationFrame(() => document.getElementById(`project-${project.id}`)?.focus()); }} aria-label={`Collapse ${project.name}`}>Collapse<Icon name="chevron" style={{transform:'rotate(180deg)'}}/></button></div>{group.checkouts.map(checkout => <section className="worktree" key={checkout.id}><h4>{checkout === project ? project.name : checkout.name}<span className="muted">{checkout.detached ? 'Detached' : checkout.branch ?? 'Folder'}</span></h4><p className="path">{checkout.path}</p><p className="muted">{checkout.runtime.ports.length ? `Listening on ${checkout.runtime.ports.map(p => ':'+p).join(', ')}` : checkout.runtime.status === 'unknown' ? 'Runtime unknown' : 'No runtime observed'}</p>{checkout.agents.map(a => <p key={agentKey(a)}>{a.name}<span className="muted"> · {a.source}</span></p>)}{checkout.links.length > 0 && <nav aria-label={`${checkout.name} links`}>{checkout.links.map(l => <a key={l.url} href={l.url} target="_blank" rel="noreferrer">{l.label}<Icon name="external"/></a>)}</nav>}{checkout.environmentIds.map(id => {
              const env = environments[id]; const active = env?.latestOperation && ['accepted','running'].includes(env.latestOperation.status);
              return <section className="environment" key={id}><h4>{label(id)}<span className="muted">{env ? label(env.application) : 'Unknown'}</span></h4><p className="muted">Preview: {env ? label(env.preview) : 'Unknown'}</p>{env && <p className="muted">{env.effects} Data: {env.dataRequirements}</p>}<div className="actions"><button disabled={!!working || !!active || !env?.startAllowed || connection !== 'Connected'} onClick={() => void action(id,'start')}>Start</button><button disabled={!!working || !!active || !env || connection !== 'Connected'} onClick={() => void action(id,'stop')}>Stop</button>{env?.services.map(s => <button key={s.id} disabled={connection !== 'Connected'} onClick={() => void showLogs(id,s.id)}>{label(s.id)} logs</button>)}</div>{env?.links.map(l => <a key={l.url} href={l.url} target="_blank" rel="noreferrer">{l.label}</a>)}{env?.latestOperation && <p aria-live="polite">{label(env.latestOperation.action)}: {label(env.latestOperation.status)}{env.latestOperation.error && ` — ${env.latestOperation.error.message}`}</p>}{env?.observationError && <p className="warning">{env.observationError.message}</p>}</section>;
            })}</section>)}</div>}
          </article>;
        })}</div>
        {catalog && <footer><span>Observed {new Date(catalog.observedAt).toLocaleTimeString()}</span>{filtered.length > 25 && <><button disabled={!pageStart} onClick={() => setCursor(Math.max(0,pageStart-25))}>Previous</button><button disabled={pageStart+25 >= filtered.length} onClick={() => setCursor(pageStart+25)}>Next</button></>}</footer>}
        {logs && <section className="log-panel" aria-label="Journal logs"><div className="toolbar"><h2>{logs.title}</h2><button onClick={() => setLogs(null)}>Close logs</button></div>{logs.truncated && <p className="muted">Latest 50 entries, up to 2 KiB each.</p>}<pre>{logs.lines.join('\n') || 'No recorded output available.'}</pre></section>}
      </>}
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
