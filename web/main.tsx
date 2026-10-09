import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { z } from 'zod';
import { catalogOutput, environmentOutput, logsOutput, type Environment, type Project } from '../src/shared/contracts';
import './style.css';
type Catalog = z.infer<typeof catalogOutput>;
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
        const [data, status] = await Promise.all([json('/api/tools/list_projects', { cursor, limit: 25 }, csrf!), json('/api/status')]);
        const parsed = catalogOutput.parse(data);
        const ids = parsed.projects.flatMap(p => p.environmentIds);
        const values = await Promise.all(ids.map(id => json('/api/tools/get_environment', { environmentId: id }, csrf!).then(v => environmentOutput.parse(v))));
        if (!stopped) { setCatalog(parsed); setEnvironments(Object.fromEntries(values.map(v => [v.id, v]))); setConnection('Connected'); setTailscale(status.tailscale.status === 'connected' ? 'Connected' : 'Unavailable'); }
      } catch (e) { if (!stopped) { setConnection('Disconnected'); setError(String(e)); if (String(e).includes('Unlock required')) setCsrf(null); } }
      finally { polling = false; }
    }
    void poll(); const timer = window.setInterval(() => { void poll(); }, 5000);
    const visible = () => { if (!document.hidden) void poll(); }; document.addEventListener('visibilitychange', visible);
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [csrf, cursor, refresh]);
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
  const groups = new Map<string, Project[]>();
  for (const project of catalog?.projects ?? []) { const key = project.gitCommonDir ?? project.path; groups.set(key, [...(groups.get(key) ?? []), project]); }
  return <main>
    <header><h1>Rootlane</h1><div className="connection" aria-live="polite"><span>{csrf ? connection : 'Locked'}</span><span>Tailscale: {tailscale}</span></div></header>
    {error && <p role="alert" className="error">{error} <button onClick={() => { setError(''); setRefresh(n => n + 1); }}>Refresh</button></p>}
    {!csrf ? <section aria-labelledby="unlock"><h2 id="unlock">Unlock Rootlane</h2>{checking ? <p>Checking connection…</p> : <form onSubmit={login}><label htmlFor="credential">Installation owner credential</label><input id="credential" type="password" autoComplete="current-password" value={credential} onChange={e => setCredential(e.target.value)} required/><button disabled={working === 'login'}>{working === 'login' ? 'Unlocking…' : 'Unlock'}</button></form>}</section> : <>
      <div className="toolbar"><h2>Projects</h2><button onClick={() => setRefresh(n => n + 1)}>Refresh</button></div>
      {!catalog && <p>Reading project directories…</p>}
      {[...new Set(catalog?.warnings ?? [])].map((warning, i) => <p className="notice" key={i}>{warning}</p>)}
      {catalog?.projects.length === 0 && <p>No projects found in the configured roots.</p>}
      {[...groups.entries()].map(([key, projects]) => <article className="project" key={key}>
        <h3>{projects[0].name}{projects.length > 1 ? ` · ${projects.length} worktrees` : ''}</h3>
        {projects.map(project => <section className="worktree" key={project.id} aria-label={project.name}>
          <p className="path">{project.path}</p>
          <p>{project.detached ? 'Detached worktree' : project.branch ?? 'Project folder'} · {project.runtime.status}{project.runtime.ports.length ? ` · ports ${project.runtime.ports.join(', ')}` : ''} · Observe-only</p>
          {project.agents.length ? <p>Agents: {project.agents.map(a => `${a.name} (${a.source})`).join(', ')}</p> : <p className="muted">No registered agent sessions</p>}
          {project.links.length > 0 && <nav aria-label={`${project.name} links`}>{project.links.map((link, i) => <a key={i} href={link.url} target="_blank" rel="noreferrer">{link.label}</a>)}</nav>}
          {project.environmentIds.map(id => { const env = environments[id]; const active = env?.latestOperation && ['accepted', 'running'].includes(env.latestOperation.status); return <div className="environment" key={id}>
            <h4>{id}</h4><p>{env ? `Application: ${env.application} · Preview: ${env.preview}` : 'Observing…'}</p>
            {env && <p className="muted">{env.effects} Data: {env.dataRequirements}</p>}
            <div className="actions"><button disabled={!!working || !!active || !env?.startAllowed || connection !== 'Connected'} onClick={() => void action(id, 'start')}>Start</button><button disabled={!!working || !!active || connection !== 'Connected'} onClick={() => void action(id, 'stop')}>Stop</button>{env?.services.map(s => <button key={s.id} onClick={() => void showLogs(id, s.id)}>{s.id} logs</button>)}</div>
            {env?.links.map(link => <a key={link.url} href={link.url} target="_blank" rel="noreferrer">{link.label}</a>)}
            {env?.latestOperation && <p aria-live="polite">{env.latestOperation.action}: {env.latestOperation.status}{env.latestOperation.error ? ` — ${env.latestOperation.error.code}: ${env.latestOperation.error.message}` : ''}</p>}
            {env?.observationError && <p className="error">{env.observationError.code}: {env.observationError.message}</p>}
          </div>; })}
        </section>)}
      </article>)}
      {catalog && <footer><span>Observed {new Date(catalog.observedAt).toLocaleTimeString()}</span><button disabled={!cursor} onClick={() => setCursor(Math.max(0, cursor - 25))}>Previous</button><button disabled={catalog.nextCursor === null} onClick={() => setCursor(catalog.nextCursor!)}>Next</button></footer>}
      {logs && <section aria-label="Journal logs"><div className="toolbar"><h2>{logs.title}</h2><button onClick={() => setLogs(null)}>Close logs</button></div>{logs.truncated && <p>Output limited to the latest 50 entries, up to 2 KiB each.</p>}<pre>{logs.lines.join('\n') || 'No recorded output available.'}</pre></section>}
    </>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
