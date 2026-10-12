import React from 'react';
import { ClaudeMark } from './marks/claude';
import { CodexMark } from './marks/codex';
import { meterTone } from './panel-section';

export function Mark({ name }: { name: string }) {
  const vendor = name === 'Codex' ? 'codex' : name === 'Claude Code' ? 'claude' : 'other';
  return <span className={`mark ${vendor}`} aria-hidden="true">{vendor === 'claude' ? <ClaudeMark/> : vendor === 'codex' ? <CodexMark/> : name.slice(0, 2).toUpperCase()}</span>;
}

export function AgentAvatar({ name, context }: { name: string; context?: number | null }) {
  const pct = context == null ? null : Math.min(100, Math.max(0, context));
  return <span className={`agent-avatar${pct == null ? '' : ` has-context ${meterTone(pct)}`}`}><Mark name={name}/>{pct != null && <svg className="context-ring" viewBox="0 0 40 40" aria-hidden="true"><circle className="ring-track" cx="20" cy="20" r="18"/><circle className="ring-value" cx="20" cy="20" r="18" pathLength="100" strokeDasharray={`${pct} 100`} transform="rotate(-90 20 20)"/></svg>}</span>;
}
