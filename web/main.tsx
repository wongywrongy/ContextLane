import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { operationsOutput, environmentOutput, logsOutput, projectOutput, previewOutput, type Environment, type ProjectDetails, type PreviewStatus } from '../src/shared/contracts';
import './style.css';
import { groupProjects, loadCatalog, projectStatus, matchesProject, matchesFilter, type ProjectFilter } from './projects';
import { Icon, Logo } from './icons';
import { polling } from './polling';
import { McpSetup } from './mcp-setup';
import { ProjectCard, Chip, time, type DetailTab } from './project-card';
type Catalog = Awaited<ReturnType<typeof loadCatalog>>;
async function json(path: string, body?: unknown, csrf?: string, signal?: AbortSignal) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-rootlane-csrf': csrf ?? '' }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status === 401 ? 'Unlock required. ' : ''}${value.code ? value.code + ' · ' : ''}${value.message ?? 'Request failed'}`);
  return value;
}
function App() {
  const [csrf, setCsrf] = useState<string | null>(null); const [checking, setChecking] = useState(true);
  const [credential, setCredential] = useState(''); const [error, setError] = useState('');
  const [catalog, setCatalog] = useState<Catalog | null>(null); const [cursor, setCursor] = useState(0);
  const [view, setView] = useState<'projects' | 'settings'>('projects');
  const [settingsPage, setSettingsPage] = useState<'connection' | 'mcp'>('connection');
  const [filter, setFilter] = useState<ProjectFilter>('All');
  const [tab, setTab] = useState<DetailTab>('Worktrees');
  const [roots, setRoots] = useState<string[]>([]);
  const [observationRoots, setObservationRoots] = useState<string[]>([]);
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
    selectedRef.current = id; setSelected(id); setDetails(null); setProjectError(''); setLogs(null); setLogsError(''); setActivity([]); setActivityError(''); setProposal(null);
    void refreshController.current?.refresh();
  };
  const [tailnetHostname, setTailnetHostname] = useState<string | null>(null);
  const [editorTemplate, setEditorTemplate] = useState<string | null>(null);
  const [activity, setActivity] = useState<ReturnType<typeof operationsOutput.parse>['operations']>([]); const [activityError,setActivityError] = useState('');
  const [proposal,setProposal] = useState<{projectId:string;draft:unknown;steps:string[]} | null>(null);
  const [unavailableReason, setUnavailableReason] = useState(''); const [configError, setConfigError] = useState('');
  const activeRef = useRef(false); const lastPoll = useRef(0);
  const [pendingAction, setPendingAction] = useState<{ tool: string; body: Record<string,string> } | null>(null);
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
          setEditorTemplate(status.editorUrlTemplate); setConnection('Connected'); setTailscale(status.tailscale.status === 'connected' ? 'Connected' : 'Unavailable'); setTailnetHostname(status.tailscale.hostname); setLifecycleAvailable(status.lifecycleAvailable); setUnavailableReason(status.reconciling ? status.lastError?.message ?? 'reconciling ownership' : ''); setConfigError(status.configError ? status.configError.code + ' · ' + status.configError.message : ''); setRoots(status.projectRoots ?? []); setObservationRoots(status.observationRoots ?? []);
        }).catch(e => { if (!signal.aborted) { failed(e); setConnection('Disconnected'); setTailscale('Unknown'); setLifecycleAvailable(false); } }),
        loadCatalog((cursor, snapshot) => json('/api/tools/list_projects', { cursor, limit: 50, ...(snapshot ? {snapshot} : {}) }, csrf, signal)).then(data => {
          if (signal.aborted) return;
          catalogRef.current = data; setCatalog(data); setCatalogError('');
          if (selectedRef.current && !data.projects.some(p => p.id === selectedRef.current)) selectProject(null);
        }).catch(e => { if (!signal.aborted) setCatalogError(failed(e)); })
      ]);
      if (signal.aborted) return;
      const snapshot = catalogRef.current;
      const id = selectedRef.current; const selectionSignal = AbortSignal.any([signal,detailAbort.current.signal]);
      const expanded = snapshot?.projects.find(p => p.id === id);
      const checkouts = expanded ? snapshot?.projects.filter(p => p.id === expanded.id || expanded.gitCommonDir && p.gitCommonDir === expanded.gitCommonDir) ?? [] : [];
      const environmentIds = [...new Set(checkouts.flatMap(p => p.environmentIds))];
      const previewIds = [...new Set(checkouts.flatMap(p => p.previewIds ?? []))];
      const observations = [
        ...environmentIds.map(environmentId => async () => {
          try { const env = environmentOutput.parse(await json('/api/tools/get_environment', { environmentId }, csrf, selectionSignal)); if (!selectionSignal.aborted) { setEnvironments(prev => ({ ...prev, [environmentId]: env })); setEnvironmentErrors(prev => ({ ...prev, [environmentId]: '' })); } }
          catch (e) { if (!selectionSignal.aborted) setEnvironmentErrors(prev => ({ ...prev, [environmentId]: failed(e) })); }
        }),
        ...previewIds.map(previewId => async () => {
          try { const preview = previewOutput.parse(await json('/api/tools/get_preview', { previewId }, csrf, selectionSignal)); if (!selectionSignal.aborted) { setPreviews(prev => ({ ...prev, [previewId]: preview })); setPreviewErrors(prev => ({ ...prev, [previewId]: '' })); } }
          catch (e) { if (!selectionSignal.aborted) setPreviewErrors(prev => ({ ...prev, [previewId]: failed(e) })); }
        })
      ];
      for (let i = 0; i < observations.length && !selectionSignal.aborted; i += 4) await Promise.allSettled(observations.slice(i, i+4).map(observe => observe()));
      if (!id || selectionSignal.aborted || selectedRef.current !== id) return;
      const current = () => !selectionSignal.aborted && selectedRef.current === id;
      try {
        const data = projectOutput.parse(await json('/api/tools/get_project', { projectId: id }, csrf, selectionSignal));
        if (!current()) return;
        setDetails(data); setProjectError('');
        try { const operations = await Promise.all([...environmentIds.map(environmentId=>({environmentId})),...previewIds.map(previewId=>({previewId}))].map(scope=>json('/api/tools/list_operations',{...scope,limit:20},csrf,selectionSignal).then(value=>operationsOutput.parse(value).operations))); if (current()) {setActivity([...new Map(operations.flat().map(op=>[op.id,op])).values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,20));setActivityError('');} } catch(e){if(current())setActivityError(failed(e));}

      } catch (e) { if (current()) setProjectError(failed(e)); }
    });
    refreshController.current = controller;
    void controller.refresh();
    const timer = window.setInterval(() => { if (Date.now()-lastPoll.current >= (activeRef.current ? 1000 : 5000)) { lastPoll.current = Date.now(); void controller.refresh(); } }, 1000);
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
  async function perform(tool: string, body: Record<string,string>) {
    const identity = body.environmentId ?? body.targetId ?? body.previewId;
    setWorking(identity); activeRef.current = true; setError(''); setPendingAction({tool, body});
    try { const result = await json('/api/tools/' + tool, body, csrf!);
      if (result.operation.environmentId) setEnvironments(prev => prev[result.operation.environmentId] ? ({...prev, [result.operation.environmentId]: {...prev[result.operation.environmentId], latestOperation: result.operation}}) : prev);
      setPendingAction(null);
    } catch (e) { setError(String(e)); } finally { await refreshController.current?.refresh(); setWorking(null); }
  }
  function action(identity: string, action: 'start' | 'stop' | 'publish' | 'unpublish') {
    if ((action === 'stop' || action === 'unpublish') && !window.confirm(action === 'stop' ? 'Stop this Rootlane environment? Running work will terminate.' : 'Unpublish this preview? Its application will keep running.')) return;
    void perform(action + (action === 'start' || action === 'stop' ? '_environment' : '_preview'), { [action === 'publish' ? 'targetId' : action === 'unpublish' ? 'previewId' : 'environmentId']: identity, requestId: crypto.randomUUID() });
  }
  activeRef.current = !!working || !!catalog?.projects.some(p=>p.controls?.some(e=>['accepted','running'].includes(e.latestOperation?.status??''))) || [...Object.values(environments), ...Object.values(previews)].some(e => ['accepted','running'].includes(e.latestOperation?.status ?? ''));
  async function propose(projectId:string, checkoutId:string, kind:'target'|'profile', port?:number) { const signal=detailAbort.current.signal; setError(''); try {const value=await json('/api/tools/propose_'+(kind==='target'?'preview_target':'profile'),{checkoutId,...(port?{port}:{})},csrf!,signal); if(!signal.aborted && selectedRef.current===projectId)setProposal({projectId,...value});}catch(e){if(!signal.aborted)setError(String(e));} }
  const allGroups = groupProjects(catalog?.projects ?? []);
  const filtered = allGroups.filter(group => matchesProject(group, query) && matchesFilter(group, filter, environments));
  if (sort === 'status') filtered.sort((a,b) => projectStatus(a, environments).localeCompare(projectStatus(b, environments)) || a.primary.name.localeCompare(b.primary.name));
  if (sort === 'worktrees') filtered.sort((a,b) => b.worktreeCount-a.worktreeCount || a.primary.name.localeCompare(b.primary.name));
  const pageStart = Math.min(cursor, Math.max(0, Math.floor((filtered.length-1)/25)*25));
  const stale = !!catalogError || connection !== 'Connected';
  if (!csrf) return <div className="rl unlock-page"><section className="unlock glass" aria-labelledby="unlock"><h1 id="unlock">Unlock Rootlane</h1>{error && <p className="notice bad" role="alert">{error}</p>}{checking ? <p className="muted" role="status">Checking connection…</p> : <form onSubmit={login}><label htmlFor="credential">Password</label><input id="credential" type="password" autoComplete="current-password" value={credential} onChange={e => setCredential(e.target.value)} required autoFocus/><button className="btn primary" disabled={working === 'login'}>{working === 'login' ? 'Unlocking…' : 'Unlock'}</button></form>}</section></div>;
  return <div className="rl app-shell">
    <header className="topbar"><div className="brand"><Logo/><strong>Rootlane</strong></div><nav className="seg main-nav" aria-label="Main navigation"><button className={view === 'projects' ? 'on' : ''} onClick={() => setView('projects')} aria-current={view === 'projects' ? 'page' : undefined}><Icon name="folder"/>Projects</button><button className={view === 'settings' ? 'on' : ''} onClick={() => setView('settings')} aria-current={view === 'settings' ? 'page' : undefined}><Icon name="settings"/>Settings</button></nav><div className="cmd"><Icon name="search"/><input ref={searchInput} aria-label="Search projects" placeholder="Search name, branch, port…" value={query} onChange={e => { setQuery(e.target.value); setCursor(0); setView('projects'); }}/><kbd className="kbd"><span>⌘</span><span>K</span></kbd></div><div className={`conn ${connection !== 'Connected' || tailscale !== 'Connected' ? 'unavailable' : ''}`} aria-live="polite"><Icon name="link"/><span>{connection === 'Connected' && tailscale === 'Connected' ? 'Connected' : connection === 'Connected' ? 'Tailnet unavailable' : connection}</span>{tailnetHostname && <><span className="sep"/><span className="tn">{tailnetHostname.split('.')[0]}</span></>}</div></header>
    <main className="wrap">
      {unavailableReason && <p className="notice" role="status">Lifecycle unavailable — {unavailableReason}; retrying</p>}{configError && <p className="notice bad" role="alert">{configError}</p>}
      {error && <div role="alert" className="notice bad"><span>{error}</span>{pendingAction && <button className="btn" onClick={() => void perform(pendingAction.tool, pendingAction.body)}>Retry action</button>}<button className="btn" onClick={() => { setError(''); void refreshController.current?.refresh(); }}>Refresh</button></div>}
      {view === 'settings' ? <section className="settings-page"><h1 className="h1">Settings</h1><p className="sub">Connection, access and coding tools.</p><nav className="seg settings-nav" aria-label="Settings pages"><button className={settingsPage === 'connection' ? 'on' : ''} aria-current={settingsPage === 'connection' ? 'page' : undefined} onClick={() => setSettingsPage('connection')}>Connection &amp; access</button><button className={settingsPage === 'mcp' ? 'on' : ''} aria-current={settingsPage === 'mcp' ? 'page' : undefined} onClick={() => setSettingsPage('mcp')}>MCP setup</button></nav>{settingsPage === 'mcp' ? <McpSetup/> : <><div className="grid-2 settings-boxes"><section className="box glass"><h4><Icon name="link"/>Tailscale <Chip state={tailscale}/></h4><dl className="kv"><dt>Host</dt><dd className="mono">{tailnetHostname ?? '—'}</dd><dt>Rootlane</dt><dd>{connection}</dd><dt>Operator address</dt><dd className="mono">{location.origin}</dd><dt>Observed</dt><dd className="mono">{time(catalog?.observedAt)}</dd></dl></section><section className="box glass"><h4><Icon name="folder"/>Workspace</h4><dl className="kv"><dt>Project roots</dt><dd className="mono">{roots.join(', ') || '—'}</dd><dt>Observation roots</dt><dd className="mono">{observationRoots.join(', ') || '—'}</dd><dt>Projects</dt><dd>{catalog ? allGroups.length : '—'}</dd></dl></section><section className="box glass"><h4>Ownership</h4><dl className="kv"><dt>Discovery</dt><dd>Observe-only</dd><dt>Managed</dt><dd>Owner-reviewed environments only</dd><dt>Lifecycle</dt><dd>{connection === 'Connected' ? lifecycleAvailable ? 'Available' : 'Unavailable' : 'Unknown'}</dd></dl></section><section className="box glass"><h4>Credentials</h4><dl className="kv"><dt>Browser</dt><dd>Installation owner session</dd><dt>Agents</dt><dd>Separate private agent credential</dd><dt>Values</dt><dd>Never displayed</dd></dl></section></div><p className="pv-note">Configuration is owner-controlled on the host. Settings is read-only.</p></>}</section> : <>
        <h1 className="h1">Projects</h1><p className="sub">{allGroups.length} {allGroups.length === 1 ? 'project' : 'projects'} in <span>{roots.join(', ') || '—'}</span></p>
        <div className="toolbar"><div className="filters">{(['All','Running','With agents','Managed'] as ProjectFilter[]).map(value => <button key={value} className={`fchip ${filter === value ? 'on' : ''}`} aria-pressed={filter === value} onClick={() => { setFilter(value); setCursor(0); }}>{value}<b>{allGroups.filter(g => matchesFilter(g, value, environments)).length}</b></button>)}</div><div className="toolbar-actions"><span className="observed mono muted">observed {time(catalog?.observedAt)}</span><button className="icon-btn" aria-label="Refresh projects" onClick={() => void refreshController.current?.refresh()}><Icon name="refresh"/></button><label className="select">Sort<select aria-label="Sort projects" value={sort} onChange={e => { setSort(e.target.value); setCursor(0); }}><option value="name">Name</option><option value="status">Status</option><option value="worktrees">Worktrees</option></select></label></div></div>
        {catalogError && <div role="alert" className="notice bad">Catalog: {catalogError}{catalog && ' · Showing the last successful observation.'}</div>}
        {!!catalog?.warnings.length && <details className="notice catalog-notice"><summary>Discovery notices ({catalog.warnings.length})</summary>{catalog.warnings.map(w => <p key={w}>{w}</p>)}</details>}
        {!catalog && <p className="empty-state">Reading project directories…</p>}{catalog && !filtered.length && <p className="empty-state">{query || filter !== 'All' ? 'No projects match your filters.' : 'No projects found in the configured roots.'}</p>}
        <div className="project-list">{filtered.slice(pageStart, pageStart+25).map(group => <ProjectCard key={group.id} group={group} open={selected === group.primary.id} tab={tab} onOpen={next => { if (next) { setTab(next); if (selected !== group.primary.id) selectProject(group.primary.id); } else { setTab('Worktrees'); selectProject(selected === group.primary.id ? null : group.primary.id); } }} environments={environments} environmentErrors={environmentErrors} previews={previews} previewErrors={previewErrors} details={selected === group.primary.id ? details : null} projectError={selected === group.primary.id ? projectError : ''} stale={stale} lifecycleAvailable={lifecycleAvailable} observedAt={catalog?.observedAt} working={working} editorTemplate={editorTemplate} editorHost={tailnetHostname} activity={selected === group.primary.id ? activity : []} activityError={selected === group.primary.id ? activityError : ''} proposal={proposal?.projectId === group.primary.id ? proposal : null} onPropose={(checkoutId,kind,port)=>{ if(selected!==group.primary.id) {selectProject(group.primary.id);} setTab('Services'); void propose(group.primary.id,checkoutId,kind,port); }} onAction={action} onLogs={(id,service) => { void showLogs(id,service); }} logs={selected === group.primary.id ? logs : null} logsError={selected === group.primary.id ? logsError : ''}/>)}</div>
        {filtered.length > 25 && <nav className="pagination" aria-label="Project pages">{pageStart > 0 && <button className="btn" onClick={() => setCursor(Math.max(0,pageStart-25))}>Previous</button>}<span className="mono muted">{pageStart+1}–{Math.min(pageStart+25,filtered.length)} of {filtered.length}</span>{pageStart+25 < filtered.length && <button className="btn" onClick={() => setCursor(pageStart+25)}>Next</button>}</nav>}
      </>}
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
