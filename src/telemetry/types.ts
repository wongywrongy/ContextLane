export interface TelemetryConfig { enabled: boolean; port: number; retentionDays: number }
export type AgentKind = 'claude' | 'codex';
export type SessionMatch = 'Matched' | 'Probable' | 'Process only';
export interface ToolAggregate { tool: string; calls: number; failures: number; rejects: number; totalMs: number; p95Ms: number | null }
export interface ToolkitEntry { kind: 'mcp' | 'skill' | 'plugin'; name: string; version: string | null; status: 'connected' | 'failed' | 'active'; lastSeenAt: string }
export interface ContextSnapshot {
  usedPct: number | null; window: number | null; input: number | null; cacheRead: number | null; cacheCreation: number | null;
  rate5hPct: number | null; rate5hResetsAt: string | null; rate7dPct: number | null; rate7dResetsAt: string | null; observedAt: string;
}
export interface RootlaneToolCall { pid: number; session: string | null; tool: string; calls: number; errors: number; lastAt: string }
export interface SessionAggregate {
  id: string; agent: AgentKind; sessionKey: string; pid: number | null; cwd: string | null; projectId: string | null; match: SessionMatch;
  model: string | null; effort: string | null; mode: string | null; startedAt: string; lastSeenAt: string; endedAt: string | null;
  counters: Record<string, number>; tools: ToolAggregate[]; toolkit: ToolkitEntry[]; context: ContextSnapshot | null;
  requestLatency: { p50Ms: number | null; p95Ms: number | null }; rootlaneTools: RootlaneToolCall[];
}
export type SafeEvent = {
  agent: AgentKind; sessionKey: string; at: string; kind: 'metric' | 'event' | 'session' | 'context'; name: string;
  model?: string; effort?: string; mode?: string; tool?: string; success?: boolean; decision?: string; duration?: number; status?: number;
  tokens?: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheCreation', number>>; key?: string; value?: number;
  cumulative?: boolean; startTime?: string; toolkit?: Omit<ToolkitEntry, 'lastSeenAt'>; pid?: number | null; cwd?: string; context?: ContextSnapshot; exceeds200k?: boolean;
};
