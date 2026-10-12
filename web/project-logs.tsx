import React, { useEffect, useRef, useState } from 'react';
import { PanelSection } from './panel-section';
import type { ProjectDetails } from '../src/shared/contracts';
type Page = { lines: string[]; nextCursor: string | null; truncated: boolean };
export const logLevel = (line: string) => /\b(error|fatal|exception|traceback|panic)\b/i.test(line) ? 'err' : /\b(warn(?:ing)?)\b/i.test(line) ? 'warn' : '';
export function LogsTab({ services, load }: { services: ProjectDetails['logServices']; load: (environmentId: string, serviceId: string, cursor: string | undefined, signal: AbortSignal) => Promise<Page> }) {
  const [service, setService] = useState(''), [lines, setLines] = useState<string[]>([]), [error,setError] = useState('');
  const [search,setSearch] = useState(''), [errorsOnly,setErrorsOnly] = useState(false), [timestamps,setTimestamps] = useState(true), [follow,setFollow] = useState(false), [notice,setNotice] = useState('');
  const cursor = useRef<string | null>(null), [more,setMore] = useState(false), refresh = useRef<() => void>(() => {}), log = useRef<HTMLDivElement>(null);
  const key = service || (services[0] ? `${services[0].environmentId}/${services[0].serviceId}` : '');
  useEffect(() => {
    setLines([]); cursor.current = null; setMore(false); setError('');
    const selected = services.find(s => `${s.environmentId}/${s.serviceId}` === key);
    if (!selected) return;
    const abort = new AbortController(); let busy = false;
    const read = async () => {
      if (busy || document.hidden || abort.signal.aborted) return;
      busy = true;
      try {
        const page = await load(selected.environmentId,selected.serviceId,cursor.current ?? undefined,abort.signal);
        if (abort.signal.aborted) return;
        if (page.nextCursor) cursor.current = page.nextCursor;
        setLines(previous => [...previous,...page.lines].slice(-2000)); setMore(page.truncated); setError('');
      } catch (e) { if (!abort.signal.aborted) setError(String(e)); }
      finally { busy = false; }
    };
    refresh.current = () => { void read(); }; void read();
    return () => abort.abort();
  }, [key]);
  useEffect(() => { if (!follow) return; const timer = setInterval(() => refresh.current(),1000); return () => clearInterval(timer); }, [follow]);
  useEffect(() => { if (follow) log.current?.scrollTo({top: log.current.scrollHeight}); }, [lines,follow]);
  const visible = lines.filter(line => (!errorsOnly || !!logLevel(line)) && line.toLowerCase().includes(search.toLowerCase()));
  const text = visible.join('\n');
  return <PanelSection title="Logs" className="log-card"><div className="logbar"><label className="select">Service <select aria-label="Log service" value={key} onChange={e => setService(e.target.value)}>{services.map(s => <option key={`${s.environmentId}/${s.serviceId}`} value={`${s.environmentId}/${s.serviceId}`}>{s.environmentId} / {s.serviceId}</option>)}</select></label><label className="logsearch"><input aria-label="Search logs" placeholder="Search logs…" value={search} onChange={e => setSearch(e.target.value)}/></label><button className={`toggle ${errorsOnly ? 'on' : ''}`} aria-pressed={errorsOnly} onClick={() => setErrorsOnly(!errorsOnly)}>Errors only</button><button className={`toggle ${timestamps ? 'on' : ''}`} aria-pressed={timestamps} onClick={() => setTimestamps(!timestamps)}>Timestamps</button><button className={`toggle ${follow ? 'on' : ''}`} aria-pressed={follow} onClick={() => setFollow(!follow)}>Follow</button><button className="btn" onClick={() => void navigator.clipboard.writeText(text).then(() => setNotice('Copied')).catch(() => setNotice('Copy unavailable. Select the log text.'))}>Copy</button><button className="btn" onClick={() => { const url = URL.createObjectURL(new Blob([text],{type:'text/plain'})); const a = document.createElement('a'); a.href=url; a.download='rootlane-journal.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url),0); }}>Download</button></div>
    {error && <p className="notice bad" role="alert">{error} · retained output</p>}<span role="status">{notice}</span><div className="logs" ref={log}>{visible.map((line,i) => { const match = line.match(/^(\d{4}-\d\d-\d\dT\S+)\s+(.*)$/); return <div className={`ll ${logLevel(line)} ${timestamps ? '' : 'hide-ts'}`} key={i}><span className="t">{match?.[1] ?? ''}</span><span className="m">{match?.[2] ?? line}</span></div>; })}{!visible.length && <p className="okline">{services.length ? 'No matching recorded output.' : 'No recorded managed services.'}</p>}</div><footer className="logbar"><span className="muted">journal since last start · latest 2,000 loaded lines</span><button className="btn" onClick={() => refresh.current()}>{more ? 'Load more' : 'Refresh logs'}</button></footer>
  </PanelSection>;
}
