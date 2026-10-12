import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { SessionAggregate, RootlaneToolCall } from './types.js';

const db = new Database(workerData.path);
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 3000');
const session = db.prepare(`INSERT INTO agent_sessions VALUES (@id,@agent,@sessionKey,@pid,@cwd,@projectId,@match,@model,@effort,@mode,@startedAt,@lastSeenAt,@endedAt)
 ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,cwd=excluded.cwd,project_id=excluded.project_id,match=excluded.match,model=excluded.model,effort=excluded.effort,mode=excluded.mode,started_at=excluded.started_at,last_seen_at=excluded.last_seen_at,ended_at=excluded.ended_at`);
const counter = db.prepare('INSERT INTO agent_session_counters VALUES (?,?,?) ON CONFLICT(session,key) DO UPDATE SET value=excluded.value');
const tool = db.prepare('INSERT INTO agent_session_tools VALUES (?,?,?,?,?,?,?) ON CONFLICT(session,tool) DO UPDATE SET calls=excluded.calls,failures=excluded.failures,rejects=excluded.rejects,total_ms=excluded.total_ms,p95_ms=excluded.p95_ms');
const toolkit = db.prepare('INSERT INTO agent_session_toolkit VALUES (?,?,?,?,?,?) ON CONFLICT(session,kind,name) DO UPDATE SET version=excluded.version,status=excluded.status,last_seen_at=excluded.last_seen_at');
const context = db.prepare(`INSERT INTO agent_session_context VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session) DO UPDATE SET used_pct=excluded.used_pct,window=excluded.window,input=excluded.input,cacheRead=excluded.cacheRead,cacheCreation=excluded.cacheCreation,rate_5h_pct=excluded.rate_5h_pct,rate_5h_resets_at=excluded.rate_5h_resets_at,rate_7d_pct=excluded.rate_7d_pct,rate_7d_resets_at=excluded.rate_7d_resets_at,observed_at=excluded.observed_at`);
const rootlane = db.prepare('INSERT INTO rootlane_tool_calls VALUES (?,?,?,?,?,?) ON CONFLICT(pid,tool) DO UPDATE SET session=excluded.session,calls=excluded.calls,errors=excluded.errors,last_at=excluded.last_at');
parentPort!.on('message', (message: { id: number; sessions: SessionAggregate[]; tools: RootlaneToolCall[]; removed: string[]; pruneBefore?: string; purge?: boolean }) => {
  try {
    db.transaction(() => {
      if (message.purge) {
        db.exec('DELETE FROM agent_sessions; DELETE FROM rootlane_tool_calls;');
      }
      for (const id of message.removed) db.prepare('DELETE FROM agent_sessions WHERE id=?').run(id);
      for (const s of message.sessions) {
        session.run(s);
        for (const [key, value] of Object.entries(s.counters)) counter.run(s.id, key, value);
        if (s.requestLatency.p50Ms !== null) counter.run(s.id, 'latency.p50Ms', s.requestLatency.p50Ms);
        if (s.requestLatency.p95Ms !== null) counter.run(s.id, 'latency.p95Ms', s.requestLatency.p95Ms);
        for (const t of s.tools) tool.run(s.id, t.tool, t.calls, t.failures, t.rejects, t.totalMs, t.p95Ms);
        for (const t of s.toolkit) toolkit.run(s.id, t.kind, t.name, t.version, t.status, t.lastSeenAt);
        if (s.context) { const c = s.context; context.run(s.id, c.usedPct, c.window, c.input, c.cacheRead, c.cacheCreation, c.rate5hPct, c.rate5hResetsAt, c.rate7dPct, c.rate7dResetsAt, c.observedAt); }
      }
      for (const t of message.tools) rootlane.run(t.pid, t.session, t.tool, t.calls, t.errors, t.lastAt);
      if (message.pruneBefore) {
        db.prepare('DELETE FROM agent_sessions WHERE last_seen_at < ?').run(message.pruneBefore);
        db.prepare('DELETE FROM rootlane_tool_calls WHERE last_at < ?').run(message.pruneBefore);
      }
    })();
    parentPort!.postMessage({ id: message.id, ok: true });
  } catch {
    parentPort!.postMessage({ id: message.id, ok: false });
  }
});
