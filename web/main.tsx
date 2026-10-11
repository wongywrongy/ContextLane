import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  approvalsOutput,
  requestEnvironmentOutput,
  type ApprovalReview,
  operationsOutput,
  environmentOutput,
  logsOutput,
  projectOutput,
  previewOutput,
  type Environment,
  type ProjectDetails,
  type PreviewStatus,
  type Operation,
  type PreviewOperation,
} from '../src/shared/contracts';
import './style.css';
import { groupProjects, loadCatalog, projectStatus, matchesProject, matchesFilter, elapsed, readDensity, saveDensity, expandAll, type Density, type ProjectFilter } from './projects';
import { Icon, Logo } from './icons';
import { polling } from './polling';
import { McpSetup } from './mcp-setup';
import { ProjectRow } from './project-row';
import { ApprovalPanel } from './approval-panel';
import { ProjectDetailsPanel, Chip, time, type DetailTab } from './project-card';
type Catalog = Awaited<ReturnType<typeof loadCatalog>>;
async function json(path: string, body?: unknown, csrf?: string, signal?: AbortSignal) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-rootlane-csrf': csrf ?? '' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      `${response.status === 401 ? 'Unlock required. ' : ''}${value.code ? value.code + ' · ' : ''}${value.message ?? 'Request failed'}`,
    );
  return value;
}
function App() {
  const [csrf, setCsrf] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [credential, setCredential] = useState('');
  const [error, setError] = useState('');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const [cursor, setCursor] = useState(0);
  const [view, setView] = useState<'projects' | 'settings'>('projects');
  const [settingsPage, setSettingsPage] = useState<'connection' | 'mcp'>('connection');
  const [filter, setFilter] = useState<ProjectFilter>('All');
  const [tabs, setTabs] = useState<Record<string, DetailTab>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const expandedRef = useRef(expanded); expandedRef.current = expanded;
  const [noticesOpen, setNoticesOpen] = useState(false);
  const [density, setDensity] = useState<Density>(() => { try { return readDensity(localStorage); } catch { return 'Expanded'; } });
  const [projectObservations, setProjectObservations] = useState<Record<string, { details: ProjectDetails | null; error: string; activity: (Operation | PreviewOperation)[]; activityError: string }>>({});
  const [roots, setRoots] = useState<string[]>([]);
  const [observationRoots, setObservationRoots] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('name');
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const detailAbort = useRef(new AbortController());
  const logAbort = useRef(new AbortController());
  const [catalogError, setCatalogError] = useState('');
  const [environmentErrors, setEnvironmentErrors] = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, PreviewStatus>>({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  const [logsError, setLogsError] = useState('');
  const refreshController = useRef<ReturnType<typeof polling> | null>(null);
  const selectProject = (id: string | null) => {
    detailAbort.current.abort();
    detailAbort.current = new AbortController();
    logAbort.current.abort();
    logAbort.current = new AbortController();
    selectedRef.current = id;
    setSelected(id);
    setLogs(null);
    setLogsError('');
    void refreshController.current?.refresh();
  };
  const [tailnetHostname, setTailnetHostname] = useState<string | null>(null);
  const [editorTemplate, setEditorTemplate] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<ApprovalReview[]>([]);
  const [approvalsError, setApprovalsError] = useState('');
  const [reviewId, setReviewId] = useState<string | null>(() => new URLSearchParams(location.search).get('approval'));
  const [requestRetry, setRequestRetry] = useState<{ path: string; requestId: string } | null>(null);
  const [unavailableReason, setUnavailableReason] = useState('');
  const [configError, setConfigError] = useState('');
  const [lastAction, setLastAction] = useState<Operation | PreviewOperation | null>(null);
  const actionRef = useRef(lastAction);
  actionRef.current = lastAction;
  const activeRef = useRef(false);
  const lastPoll = useRef(0);
  const [pendingAction, setPendingAction] = useState<{ tool: string; body: Record<string, string> } | null>(null);
  const [lifecycleAvailable, setLifecycleAvailable] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setView('projects');
        searchInput.current?.focus();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const [environments, setEnvironments] = useState<Record<string, Environment>>({});
  const [connection, setConnection] = useState('Connecting');
  const [tailscale, setTailscale] = useState('Unknown');
  const [working, setWorking] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ title: string; lines: string[]; truncated: boolean } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    json('/api/session', undefined, undefined, abort.signal)
      .then((s) => {
        if (!abort.signal.aborted) setCsrf(s.csrf);
      })
      .catch(() => {})
      .finally(() => {
        if (!abort.signal.aborted) setChecking(false);
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (!csrf) return;
    detailAbort.current = new AbortController();
    logAbort.current = new AbortController();
    const controller = polling(async (signal) => {
      const failed = (e: unknown) => {
        if (String(e).includes('Unlock required')) setCsrf(null);
        return String(e);
      };
      await Promise.allSettled([
        json('/api/approvals', undefined, undefined, signal)
          .then((value) => {
            if (!signal.aborted) {
              setApprovals(approvalsOutput.parse(value).approvals);
              setApprovalsError('');
            }
          })
          .catch((e) => {
            if (!signal.aborted) setApprovalsError(failed(e));
          }),
        json('/api/status', undefined, undefined, signal)
          .then((status) => {
            if (signal.aborted) return;
            setEditorTemplate(status.editorUrlTemplate);
            setConnection('Connected');
            setTailscale(status.tailscale.status === 'connected' ? 'Connected' : 'Unavailable');
            setTailnetHostname(status.tailscale.hostname);
            setLifecycleAvailable(status.lifecycleAvailable);
            setUnavailableReason(status.reconciling ? (status.lastError?.message ?? 'reconciling ownership') : '');
            setConfigError(status.configError ? status.configError.code + ' · ' + status.configError.message : '');
            setRoots(status.projectRoots ?? []);
            setObservationRoots(status.observationRoots ?? []);
          })
          .catch((e) => {
            if (!signal.aborted) {
              failed(e);
              setConnection('Disconnected');
              setTailscale('Unknown');
              setLifecycleAvailable(false);
            }
          }),
        loadCatalog((cursor, snapshot) => json('/api/tools/list_projects', { cursor, limit: 50, ...(snapshot ? { snapshot } : {}) }, csrf, signal))
          .then((data) => {
            if (signal.aborted) return;
            catalogRef.current = data;
            setCatalog(data);
            setCatalogError('');
            if (selectedRef.current && !data.projects.some((p) => p.id === selectedRef.current)) selectProject(null);
          })
          .catch((e) => {
            if (!signal.aborted) setCatalogError(failed(e));
          }),
      ]);
      if (signal.aborted) return;
      const operation = actionRef.current;
      if (operation && ['accepted', 'running'].includes(operation.status)) {
        try {
          const history = operationsOutput.parse(
            await json(
              '/api/tools/list_operations',
              { ...('environmentId' in operation ? { environmentId: operation.environmentId } : { previewId: operation.previewId }), limit: 20 },
              csrf,
              signal,
            ),
          );
          const observed = history.operations.find((op) => op.id === operation.id);
          if (observed && !signal.aborted) {
            setLastAction(observed);
            if (observed.error) setError(observed.error.code + ' · ' + observed.error.message);
          }
        } catch (e) {
          if (!signal.aborted) failed(e);
        }
      }
      const snapshot = catalogRef.current;
      const checkouts = snapshot?.projects ?? [];
      const environmentIds = [...new Set(checkouts.flatMap((p) => p.environmentIds))];
      const previewIds = [...new Set(checkouts.flatMap((p) => p.previewIds ?? []))];
      const observations = [
        ...environmentIds.map((environmentId) => async () => {
          try {
            const env = environmentOutput.parse(await json('/api/tools/get_environment', { environmentId }, csrf, signal));
            if (!signal.aborted) {
              setEnvironments((prev) => ({ ...prev, [environmentId]: env }));
              setEnvironmentErrors((prev) => ({ ...prev, [environmentId]: '' }));
            }
          } catch (e) {
            if (!signal.aborted) setEnvironmentErrors((prev) => ({ ...prev, [environmentId]: failed(e) }));
          }
        }),
        ...previewIds.map((previewId) => async () => {
          try {
            const preview = previewOutput.parse(await json('/api/tools/get_preview', { previewId }, csrf, signal));
            if (!signal.aborted) {
              setPreviews((prev) => ({ ...prev, [previewId]: preview }));
              setPreviewErrors((prev) => ({ ...prev, [previewId]: '' }));
            }
          } catch (e) {
            if (!signal.aborted) setPreviewErrors((prev) => ({ ...prev, [previewId]: failed(e) }));
          }
        }),
      ];
      for (let i = 0; i < observations.length && !signal.aborted; i += 4)
        await Promise.allSettled(observations.slice(i, i + 4).map((observe) => observe()));
      for (const projectId of expandedRef.current) {
        if (signal.aborted) return;
        const current = () => !signal.aborted && expandedRef.current.includes(projectId);
        try {
          const data = projectOutput.parse(await json('/api/tools/get_project', { projectId }, csrf, signal));
          if (!current()) continue;
          setProjectObservations(prev => ({ ...prev, [projectId]: { details: data, error: '', activity: prev[projectId]?.activity ?? [], activityError: '' } }));
          try {
            const groupEnvironmentIds = groupProjects(snapshot?.projects ?? []).find(group => group.primary.id === projectId)?.environmentIds ?? [];
            const scopes = [...groupEnvironmentIds.map(environmentId => ({ environmentId })), ...data.previews.map(p => ({ previewId: p.previewId }))];
            const operations = await Promise.all(scopes.map(scope => json('/api/tools/list_operations', { ...scope, limit: 20 }, csrf, signal).then(value => operationsOutput.parse(value).operations)));
            if (current()) setProjectObservations(prev => ({ ...prev, [projectId]: { ...prev[projectId], activity: [...new Map(operations.flat().map(op => [op.id, op])).values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,20), activityError: '' } }));
          } catch (e) {
            if (current()) setProjectObservations(prev => ({ ...prev, [projectId]: { ...prev[projectId], activityError: failed(e) } }));
          }
        } catch (e) {
          if (current()) setProjectObservations(prev => ({ ...prev, [projectId]: { details: prev[projectId]?.details ?? null, activity: prev[projectId]?.activity ?? [], activityError: prev[projectId]?.activityError ?? '', error: failed(e) } }));
        }
      }
    });
    refreshController.current = controller;
    void controller.refresh();
    const timer = window.setInterval(() => {
      if (Date.now() - lastPoll.current >= (activeRef.current ? 1000 : 5000)) {
        lastPoll.current = Date.now();
        void controller.refresh();
      }
    }, 1000);
    const visible = () => {
      if (!document.hidden) void controller.refresh();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller.stop();
      detailAbort.current.abort();
      logAbort.current.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [csrf]);
  async function login(event: React.FormEvent) {
    event.preventDefault();
    setWorking('login');
    setError('');
    try {
      const response = await json('/api/login', { credential });
      setCredential('');
      setCsrf(response.csrf);
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(null);
    }
  }
  async function showLogs(id: string, serviceId: string) {
    logAbort.current.abort();
    logAbort.current = new AbortController();
    const signal = logAbort.current.signal;
    const projectId = selectedRef.current;
    setLogsError('');
    setLogs((previous) => (previous?.title === `${id} / ${serviceId}` ? previous : { title: `${id} / ${serviceId}`, lines: [], truncated: false }));
    try {
      const data = logsOutput.parse(await json('/api/tools/get_logs', { environmentId: id, serviceId, limit: 50 }, csrf!, signal));
      if (!signal.aborted && selectedRef.current === projectId)
        setLogs({ title: `${id} / ${serviceId}`, lines: data.lines, truncated: data.truncated });
    } catch (e) {
      if (!signal.aborted && selectedRef.current === projectId) setLogsError(String(e));
    }
  }
  async function perform(tool: string, body: Record<string, string>) {
    const identity = body.environmentId ?? body.targetId ?? body.previewId;
    setWorking(identity);
    activeRef.current = true;
    setError('');
    setPendingAction({ tool, body });
    try {
      const result = await json('/api/tools/' + tool, body, csrf!);
      setLastAction(result.operation);
      if (result.operation.environmentId)
        setEnvironments((prev) =>
          prev[result.operation.environmentId]
            ? { ...prev, [result.operation.environmentId]: { ...prev[result.operation.environmentId], latestOperation: result.operation } }
            : prev,
        );
      setPendingAction(null);
    } catch (e) {
      setError(String(e));
    } finally {
      await refreshController.current?.refresh();
      setWorking(null);
    }
  }
  function action(identity: string, action: 'start' | 'stop' | 'publish' | 'unpublish') {
    if (
      (action === 'stop' || action === 'unpublish') &&
      !window.confirm(
        action === 'stop'
          ? 'Stop this Rootlane environment? Running work will terminate.'
          : 'Unpublish this preview? Its application will keep running.',
      )
    )
      return;
    void perform(action + (action === 'start' || action === 'stop' ? '_environment' : '_preview'), {
      [action === 'publish' ? 'targetId' : action === 'unpublish' ? 'previewId' : 'environmentId']: identity,
      requestId: crypto.randomUUID(),
    });
  }
  activeRef.current =
    !!working ||
    (!!lastAction && ['accepted', 'running'].includes(lastAction.status)) ||
    !!catalog?.projects.some((p) => p.controls?.some((e) => ['accepted', 'running'].includes(e.latestOperation?.status ?? ''))) ||
    [...Object.values(environments), ...Object.values(previews)].some((e) => ['accepted', 'running'].includes(e.latestOperation?.status ?? ''));
  async function requestEnvironment(input: { path: string; requestId: string }) {
    setWorking('recipe-request');
    setError('');
    setRequestRetry(input);
    try {
      const value = requestEnvironmentOutput.parse(await json('/api/tools/request_environment', input, csrf!));
      setReviewId(value.status === 'pending' ? new URL(value.approvalUrl).searchParams.get('approval') : null);
      setRequestRetry(null);
    } catch (e) {
      setError(String(e));
    } finally {
      await refreshController.current?.refresh();
      setWorking(null);
    }
  }
  async function decide(id: string, approve: boolean) {
    if (
      approve &&
      !window.confirm('Approve this recipe for its project and worktrees? Rootlane may run the reviewed commands and publish these private previews.')
    )
      return;
    setWorking('approval');
    setError('');
    try {
      await json(`/api/approvals/${id}/${approve ? 'approve' : 'reject'}`, {}, csrf!);
      setReviewId(null);
      document.getElementById('projects-title')?.focus();
      history.replaceState(null, '', location.pathname);
    } catch (e) {
      setError(String(e));
    } finally {
      await refreshController.current?.refresh();
      setWorking(null);
    }
  }
  const allGroups = groupProjects(catalog?.projects ?? []);
  const filtered = allGroups.filter((group) => matchesProject(group, query) && matchesFilter(group, filter, environments));
  if (sort === 'status')
    filtered.sort(
      (a, b) => projectStatus(a, environments).localeCompare(projectStatus(b, environments)) || a.primary.name.localeCompare(b.primary.name),
    );
  if (sort === 'worktrees') filtered.sort((a, b) => b.worktreeCount - a.worktreeCount || a.primary.name.localeCompare(b.primary.name));
  const pageStart = Math.min(cursor, Math.max(0, Math.floor((filtered.length - 1) / 25) * 25));
  const stale = !!catalogError || connection !== 'Connected';
  if (!csrf)
    return (
      <div className="rl unlock-page">
        <section className="unlock glass" aria-labelledby="unlock">
          <h1 id="unlock">Unlock Rootlane</h1>
          {error && (
            <p className="notice bad" role="alert">
              {error}
            </p>
          )}
          {checking ? (
            <p className="muted" role="status">
              Checking connection…
            </p>
          ) : (
            <form onSubmit={login}>
              <label htmlFor="credential">Password</label>
              <input
                id="credential"
                type="password"
                autoComplete="current-password"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                required
                autoFocus
              />
              <button className="btn primary" disabled={working === 'login'}>
                {working === 'login' ? 'Unlocking…' : 'Unlock'}
              </button>
            </form>
          )}
        </section>
      </div>
    );
  return (
    <div className="rl app-shell">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <strong>Rootlane</strong>
        </div>
        <nav className="seg main-nav" aria-label="Main navigation">
          <button
            className={view === 'projects' ? 'on' : ''}
            onClick={() => setView('projects')}
            aria-current={view === 'projects' ? 'page' : undefined}
          >
            <Icon name="folder" />
            Projects
          </button>
          <button
            className={view === 'settings' ? 'on' : ''}
            onClick={() => setView('settings')}
            aria-current={view === 'settings' ? 'page' : undefined}
          >
            <Icon name="settings" />
            Settings
          </button>
        </nav>
        <div className="cmd">
          <Icon name="search" />
          <input
            ref={searchInput}
            aria-label="Search projects"
            placeholder="Search projects, branches, ports..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
              setView('projects');
            }}
          />
          <kbd className="kbd">
            <span>⌘</span>
            <span>K</span>
          </kbd>
        </div>
        <div className={`conn ${connection !== 'Connected' || tailscale !== 'Connected' ? 'unavailable' : ''}`} aria-live="polite">
          <Icon name="link" />
          <span>
            {connection === 'Connected' && tailscale === 'Connected' ? 'Connected' : connection === 'Connected' ? 'Tailnet unavailable' : connection}
          </span>
          {tailnetHostname && (
            <>
              <span className="sep" />
              <span className="tn">{tailnetHostname.split('.')[0]}</span>
            </>
          )}
        </div>
      </header>
      <main className="wrap">
        {lastAction && lastAction.status !== 'succeeded' && (
          <p className="notice" role="status">
            {lastAction.action} · {'environmentId' in lastAction ? lastAction.environmentId : lastAction.previewId.slice(0, 8)} ·{' '}
            <Chip state={lastAction.status[0].toUpperCase() + lastAction.status.slice(1)} />
          </p>
        )}
        {unavailableReason && (
          <p className="notice" role="status">
            Lifecycle unavailable — {unavailableReason}; retrying
          </p>
        )}
        {configError && (
          <p className="notice bad" role="alert">
            {configError}
          </p>
        )}
        {error && (
          <div role="alert" className="notice bad">
            <span>{error}</span>
            {requestRetry && (
              <button className="btn" onClick={() => void requestEnvironment(requestRetry)}>
                Retry request
              </button>
            )}
            {pendingAction && (
              <button className="btn" onClick={() => void perform(pendingAction.tool, pendingAction.body)}>
                Retry action
              </button>
            )}
            <button
              className="btn"
              onClick={() => {
                setError('');
                void refreshController.current?.refresh();
              }}
            >
              Refresh
            </button>
          </div>
        )}
        {view === 'settings' ? (
          <section className="settings-page">
            <h1 className="h1">Settings</h1>
            <p className="sub">read-only · change on the host</p>
            <nav className="seg settings-nav" aria-label="Settings pages">
              <button
                className={settingsPage === 'connection' ? 'on' : ''}
                aria-current={settingsPage === 'connection' ? 'page' : undefined}
                onClick={() => setSettingsPage('connection')}
              >
                Connection &amp; access
              </button>
              <button
                className={settingsPage === 'mcp' ? 'on' : ''}
                aria-current={settingsPage === 'mcp' ? 'page' : undefined}
                onClick={() => setSettingsPage('mcp')}
              >
                MCP setup
              </button>
            </nav>
            {settingsPage === 'mcp' ? (
              <McpSetup />
            ) : (
              <>
                <div className="grid-2 settings-boxes">
                  <section className="box glass">
                    <h4>
                      <Icon name="link" />
                      Tailscale <Chip state={tailscale} />
                    </h4>
                    <dl className="kv">
                      <dt>Host</dt>
                      <dd className="mono">{tailnetHostname ?? '—'}</dd>
                      <dt>Rootlane</dt>
                      <dd>{connection}</dd>
                      <dt>Operator address</dt>
                      <dd className="mono">{location.origin}</dd>
                      <dt>Observed</dt>
                      <dd className="mono">{time(catalog?.observedAt)}</dd>
                    </dl>
                  </section>
                  <section className="box glass">
                    <h4>
                      <Icon name="folder" />
                      Workspace
                    </h4>
                    <dl className="kv">
                      <dt>Project roots</dt>
                      <dd className="mono">{roots.join(', ') || '—'}</dd>
                      <dt>Observation roots</dt>
                      <dd className="mono">{observationRoots.join(', ') || '—'}</dd>
                      <dt>Projects</dt>
                      <dd>{catalog ? allGroups.length : '—'}</dd>
                    </dl>
                  </section>
                  <section className="box glass">
                    <h4>Ownership</h4>
                    <dl className="kv">
                      <dt>Discovery</dt>
                      <dd>Observe-only</dd>
                      <dt>Managed</dt>
                      <dd>Owner-reviewed environments only</dd>
                      <dt>Lifecycle</dt>
                      <dd>{connection === 'Connected' ? (lifecycleAvailable ? 'Available' : 'Unavailable') : 'Unknown'}</dd>
                    </dl>
                  </section>
                  <section className="box glass">
                    <h4>Credentials</h4>
                    <dl className="kv">
                      <dt>Browser</dt>
                      <dd>Installation owner session</dd>
                      <dt>Agents</dt>
                      <dd>Separate private agent credential</dd>
                      <dt>Values</dt>
                      <dd>Never displayed</dd>
                    </dl>
                  </section>
                </div>
                <p className="pv-note">Configuration is owner-controlled on the host. Settings is read-only.</p>
              </>
            )}
          </section>
        ) : (
          <>
            <div className="page-heading">
              <div className="page-title"><h1 id="projects-title" tabIndex={-1} className="h1">Projects</h1><span className="mono muted">{allGroups.length} projects · {roots.join(', ') || '—'}</span></div>
              <div className="toolbar-actions">
                <button className={`npill ${noticesOpen ? 'on' : ''}`} aria-expanded={noticesOpen} aria-controls="discovery-notices" onClick={() => setNoticesOpen(!noticesOpen)}>{catalog?.warnings.length ?? 0} notices</button>
                <span className="observed mono muted">{catalog ? `updated ${elapsed(catalog.observedAt, now) ?? '—'} ago` : 'Updating…'}</span>
                <button className="icon-btn" aria-label="Refresh projects" onClick={() => void refreshController.current?.refresh()}><Icon name="refresh"/></button>
                <label className="select">Sort <select aria-label="Sort projects" value={sort} onChange={e => { setSort(e.target.value); setCursor(0); }}><option value="name">Name</option><option value="status">Status</option><option value="worktrees">Worktrees</option></select></label>
                <div className="seg density" aria-label="Row density">{(['Compact', 'Expanded'] as const).map(value => <button key={value} className={density === value ? 'on' : ''} aria-pressed={density === value} onClick={() => { setDensity(value); try { saveDensity(localStorage, value); } catch {} }}>{value}</button>)}</div>
                <button className="xall" onClick={() => { const ids = filtered.slice(pageStart, pageStart + 25).map(g => g.primary.id); const next = expandAll(ids, expanded); expandedRef.current = next; setExpanded(next); void refreshController.current?.refresh(); }}>{filtered.slice(pageStart, pageStart + 25).every(g => expanded.includes(g.primary.id)) && filtered.length ? 'Collapse all' : 'Expand all'}</button>
              </div>
            </div>
            <div className="toolbar">
              <div className="filters">{(['All', 'Running', 'With agents', ...(allGroups.some(g => g.environmentIds.length) ? ['Managed'] : [])] as ProjectFilter[]).map(value => <button key={value} className={`fchip ${filter === value ? 'on' : ''}`} aria-pressed={filter === value} onClick={() => { setFilter(value); setCursor(0); }}>{value}<b>{allGroups.filter(g => matchesFilter(g, value, environments)).length}</b></button>)}</div>
              <div className="legend">{[['ok','working'], ['info','unverified'], ['bad','down'], ['idle','link']].map(([tone,text]) => <span key={tone}><i className={`ldot ${tone}`} aria-hidden="true"/>{text}</span>)}</div>
            </div>
            {noticesOpen && <div id="discovery-notices" className="notice catalog-notice"><div>{catalog?.warnings.length ? catalog.warnings.map(w => <p key={w}>{w}</p>) : <p>No discovery notices.</p>}</div></div>}
            {approvalsError && (
              <p className="notice bad" role="alert">
                Approvals: {approvalsError}
              </p>
            )}
            {!!approvals.length && (
              <div className="notice approval-notice">
                <span>
                  {approvals.length} {approvals.length === 1 ? 'environment' : 'environments'} awaiting approval
                </span>
                <button className="btn" onClick={() => setReviewId(approvals[0].id)}>
                  Review
                </button>
              </div>
            )}
            {reviewId && (
              <ApprovalPanel
                reviews={approvals}
                selected={reviewId}
                onSelect={setReviewId}
                onDecide={decide}
                working={!!working}
                onClose={() => {
                  setReviewId(null);
                  document.getElementById('projects-title')?.focus();
                  history.replaceState(null, '', location.pathname);
                }}
              />
            )}
            {catalogError && (
              <div role="alert" className="notice bad">
                Catalog: {catalogError}
                {catalog && ' · Showing the last successful observation.'}
              </div>
            )}
            {!catalog && <p className="empty-state">Reading project directories…</p>}
            {catalog && !filtered.length && (
              <p className="empty-state">
                {query || filter !== 'All' ? 'No projects match your filters.' : 'No projects found in the configured roots.'}
              </p>
            )}
            <div className={`project-table ptbl ${density === 'Compact' ? 'dense' : ''}`} role="table" aria-label="Projects">
              <div className="project-table-head prow head" role="row">{['Project','Branch','Agents','Services','Links','⋯'].map(name => <span role="columnheader" key={name}>{name}</span>)}</div>
              <div role="rowgroup">{filtered.slice(pageStart, pageStart + 25).map(group => {
                const id = group.primary.id, open = expanded.includes(id), observation = projectObservations[id];
                const toggle = (section?: DetailTab) => {
                  if (section || !expandedRef.current.includes(id)) setTabs(prev => ({ ...prev, [id]: section ?? 'Worktrees' }));
                  const next = section ? [...new Set([...expandedRef.current, id])] : expandedRef.current.includes(id) ? expandedRef.current.filter(value => value !== id) : [...expandedRef.current, id];
                  expandedRef.current = next; setExpanded(next); selectProject(next.includes(id) ? id : null);
                };
                const rowStale = stale || !!observation?.error || group.environmentIds.some(value => !!environmentErrors[value]) || group.checkouts.some(p => p.previewIds?.some(value => !!previewErrors[value]));
                return <React.Fragment key={group.id}><ProjectRow group={group} environments={environments} previews={previews} stale={rowStale} now={now} expanded={open} density={density} editorTemplate={editorTemplate} editorHost={tailnetHostname} lifecycleAvailable={lifecycleAvailable} working={!!working || activeRef.current} onAction={action} onRequest={path => void requestEnvironment({path,requestId:crypto.randomUUID()})}
                  onDetails={toggle} onLogs={(environmentId, service) => { toggle('Environment'); void showLogs(environmentId, service); }}/>
                  {open && <div className="detail-row" role="row"><div role="cell" aria-colspan={6}><ProjectDetailsPanel group={group} tab={tabs[id] ?? 'Worktrees'} onOpen={next => { if (next) setTabs(prev => ({...prev,[id]:next})); }} onClose={() => toggle()}
                    environments={environments} environmentErrors={environmentErrors} previews={previews} previewErrors={previewErrors} details={observation?.details ?? null} projectError={observation?.error ?? ''} stale={stale} lifecycleAvailable={lifecycleAvailable} observedAt={catalog?.observedAt} working={working ?? (activeRef.current ? 'operation' : null)} editorTemplate={editorTemplate} editorHost={tailnetHostname} activity={observation?.activity ?? []} activityError={observation?.activityError ?? ''} onRequest={path => void requestEnvironment({path,requestId:crypto.randomUUID()})} onAction={action} onLogs={(environmentId, service) => { selectProject(id); void showLogs(environmentId,service); }} logs={selected === id ? logs : null} logsError={selected === id ? logsError : ''}/></div></div>}
                </React.Fragment>;
              })}</div>
            </div>
            {filtered.length > 25 && (
              <nav className="pagination" aria-label="Project pages">
                {pageStart > 0 && (
                  <button className="btn" onClick={() => setCursor(Math.max(0, pageStart - 25))}>
                    Previous
                  </button>
                )}
                <span className="mono muted">
                  {pageStart + 1}–{Math.min(pageStart + 25, filtered.length)} of {filtered.length}
                </span>
                {pageStart + 25 < filtered.length && (
                  <button className="btn" onClick={() => setCursor(pageStart + 25)}>
                    Next
                  </button>
                )}
              </nav>
            )}
          </>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
