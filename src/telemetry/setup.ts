import type { Config } from '../config.js';

export type TelemetryCopyKind = 'credential' | 'claude-env' | 'hooks' | 'statusline' | 'codex';

export function telemetrySetup(kind: TelemetryCopyKind, config: Config, token: string): string {
  const endpoint = `http://127.0.0.1:${config.telemetry.port}`;
  if (kind === 'credential') return token;
  if (kind === 'claude-env') return JSON.stringify({ env: {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp', OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `${endpoint}/otlp`,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}`,
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
    ROOTLANE_TELEMETRY_URL: endpoint, ROOTLANE_INGEST_TOKEN: token,
  } }, null, 2);
  if (kind === 'hooks') return JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: '~/.local/bin/rootlane-session-hook' }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: '~/.local/bin/rootlane-session-hook' }] }],
  } }, null, 2);
  if (kind === 'statusline') return JSON.stringify({ statusLine: {
    type: 'command', command: '~/.local/bin/rootlane-statusline -- <original statusline command…>',
  } }, null, 2);
  return `[otel]\nlog_user_prompt = false\nexporter = { otlp-http = { endpoint = "${endpoint}/otlp/v1/logs", protocol = "json", headers = { "Authorization" = "Bearer ${token}" } } }\n`;
}
