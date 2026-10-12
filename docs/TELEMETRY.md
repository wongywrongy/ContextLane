# Agent session telemetry

Rootlane 0.8.0 can receive agent-reported session telemetry for Claude Code and Codex sessions working in its projects. It is off by default. It stores counts and names, never prompts, responses, transcripts or tool inputs. This is session observation, not an agent control surface or a billing dashboard.

## Enable the local receiver

Run `node deploy/setup.mjs "$HOME/code"` as the installation owner, using the same project root as your existing installation. Setup preserves the owner and agent credentials, creates a separate random mode-0600 `~/.config/rootlane/ingest.credential`, and installs `~/.local/bin/rootlane-session-hook` and `~/.local/bin/rootlane-statusline`. It also writes private `~/.config/rootlane/ingest.env` for the hooks, containing the receiver origin and ingest credential. Rerun setup after moving a release or changing its telemetry port. Do not commit these files.

Add telemetry to `~/.config/rootlane/config.json`:

```json
"telemetry": { "enabled": true, "port": 9481, "retentionDays": 7 }
```

Every field is optional: `enabled` defaults to `false`, `port` to `9480`, and `retentionDays` to `7`; retention must be 1–30 days. The example uses `9481` because existing installations may already use `9480` for their main HTTP server. Choose separate main and receiver ports. A conflict leaves the main UI available and reports the receiver bind failure in Settings. If changing the main port, follow the existing administration restart and Serve-route procedure.

Reload with `deploy/rootlane-reload`. Telemetry runs in a separate Fastify listener bound only to `127.0.0.1`. Tailscale Serve continues to proxy only the main server. Never publish or proxy the ingest port. The service/Compose environment sets `ROOTLANE_INGEST_CREDENTIAL_FILE` to the private credential file. It accepts only the ingest Bearer credential; owner and agent credentials cannot ingest, and the ingest credential cannot access Rootlane's UI, API or MCP tools.

Settings → Agent telemetry reports the configured endpoint, bind errors, credential presence, retention, current reporting and dropped counts. Copy buttons use the authenticated owner session. Token values are never rendered into page HTML. Read tools `get_agent_sessions` and `get_telemetry_status` expose the same aggregate counts to the UI and MCP, with no telemetry write tool.

## Claude Code

Use Settings' live copy buttons so snippets use your configured port and private ingest token. Merge the environment block into `~/.claude/settings.json`; preserve your existing environment and hooks. For a receiver on `9481`, the block is:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:9481/otlp",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer <ingest token>",
    "OTEL_METRIC_EXPORT_INTERVAL": "10000"
  },
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "~/.local/bin/rootlane-session-hook" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "~/.local/bin/rootlane-session-hook" }] }]
  }
}
```

The hooks walk up to eight Linux `/proc` parents using Rootlane's existing Claude detector. They send only agent kind, session ID, owning PID when found, cwd, start/end and source. The hook always exits zero and prints nothing; requests time out after 300ms. `ROOTLANE_TELEMETRY_URL` and `ROOTLANE_INGEST_TOKEN` override `ingest.env` without allowing a non-loopback destination.

For context usage and subscription limits, optionally wrap your existing status-line command:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.local/bin/rootlane-statusline -- /absolute/path/to/your-statusline"
  }
}
```

If your original command uses shell syntax, pass it through `-- /bin/sh -c 'your existing command'`. The Bash wrapper streams the original stdin through `tee` to that command and preserves its stdout bytes and exit code, without writing input to disk. With no command after `--`, it prints nothing. A background Node reporter parses only snapshots up to 1 MiB and sends at most one per session every five seconds. Its Node startup and 300ms HTTP timeout run outside the foreground command, so an unavailable receiver does not delay the original status line. Snapshots contain the allowed model, context, current token split, 5-hour/7-day percentages and reset times, 200k threshold flag and estimated session cost. The current token split comes from `context_window.current_usage`; reset times are Unix seconds. Missing fields stay absent. Usage limits are available only for supported subscriptions after an API response. [Claude status-line reference](https://code.claude.com/docs/en/statusline).

Restart or start a new Claude session after changing settings. Toolkit names depend on what the installed Claude version exports. Current events are `mcp_server_connection` (`server_name`, `status`), `skill_activated` (`skill.name`) and `plugin_loaded` (`plugin.name`, `plugin.version`). Some names are absent or redacted by Claude unless tool-detail export is enabled. Rootlane does not enable that flag, because it also exports content; missing inventory stays unknown. [Claude monitoring reference](https://code.claude.com/docs/en/monitoring-usage).

## Codex

Merge this into the user-level `~/.codex/config.toml`, using Settings' Copy action to insert the literal ingest token and configured port:

```toml
[otel]
log_user_prompt = false
exporter = { otlp-http = { endpoint = "http://127.0.0.1:9481/otlp/v1/logs", protocol = "json", headers = { "Authorization" = "Bearer <ingest token>" } } }
```

The installed host version was verified as Codex CLI `0.162.1`. Its OTEL headers are static strings, so `${ROOTLANE_INGEST_TOKEN}` does not interpolate; use the literal ingest-only credential. Keep `config.toml` private. Do not configure traces for Rootlane. [Official config reference](https://developers.openai.com/codex/config-reference/) and [0.162.1 config/provider source](https://github.com/openai/codex/tree/rust-v0.162.1/codex-rs/otel/src).

Verified events are `codex.conversation_starts`, `codex.api_request`, `codex.tool_result` and `codex.tool_decision`, keyed by `conversation.id`. Token counts arrive on `codex.sse_event` with `event.kind=response.completed`; Rootlane reads only its numeric usage fields. Model, reasoning effort, approval/sandbox enums, request durations/statuses and tool count/success/duration/decision are kept. Codex does not report the Claude status-line percentages or subscription limits. [0.162.1 event source](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/otel/src/events/session_telemetry.rs).

## What is retained

| Kept | Dropped on arrival |
| --- | --- |
| Agent/session identity, process association and catalog project/worktree attribution | Every OTLP log body and unknown attribute |
| Model; supported effort and approval/sandbox enum values | Prompt text and prompt length, including every `user_prompt` event |
| Input/output/cache-read/cache-write token sums; request counts, status-code errors and sampled p50/p95 latency | Response text, transcripts and conversation titles |
| Tool names, calls, failures, rejects, total duration and sampled p95 | Tool inputs/parameters, shell commands, file paths and error messages |
| MCP/skill/plugin names, versions and connection/activity status when reported | User email/account UUID, organization ID, terminal type and headers |
| Latest context snapshot and 5-hour/7-day usage/reset times | Unknown services and unsupported events/metrics |
| Lines added/removed, commits, pull requests, compaction/cache counts when reported; estimated cost as a secondary aside | Request timelines, trace data and content logs |

Working-directory metadata from the session hook is resolved against the existing catalog for project attribution. Paths embedded in OTLP attributes, tool arguments or log content never become telemetry records. Missing counters are unknown rather than fabricated. Estimated cost is agent-reported and is not billing evidence. Request/tool percentiles use bounded samples rather than retaining individual requests.

The receiver accepts OTLP/HTTP JSON only at `/otlp/v1/metrics` and `/otlp/v1/logs`. Protobuf receives `415` with `http/json` setup guidance. `/otlp/v1/traces` is accepted and discarded to prevent exporter retries. Bodies are capped at 1 MiB; the credential has an approximately 50 requests/second limit with a burst allowance. At most 256 sessions, 200 distinct tool names and 64 toolkit entries per session are kept. Ended sessions are evicted oldest first; excess data increments the Settings dropped counters. A bounded queue flushes aggregates to SQLite about every two seconds.

Rootlane's stdio MCP adapter also forwards its parent PID. Per-tool calls, errors and last-call times are recorded for that PID even with agent telemetry disabled, and appear in Process only details. These counts describe calls to Rootlane, not general agent activity.

## Matching and freshness

- **Matched:** Claude's hook PID is alive and is the same observed agent process. Its cwd uses the catalog's closest-project/worktree resolver.
- **Probable:** Codex has no session hook. A session can attach only when exactly one unmatched Codex process on this host began before its first event. With two candidates, neither is chosen. This does not prove process/session identity.
- **Process only:** a detected process has no attached telemetry. Existing process facts and Rootlane MCP counts remain available.

Unmatched sessions appear under a project only when their cwd is known. They are never arbitrarily attached to a process. Rootlane does not infer content or completion from process presence or counters. After two minutes without fresh data, a live session shows its update age. After fifteen minutes without events and without a live PID, it is shown as ended. Reporting now includes only recent sessions.

## Retention, backups and disable/purge

Retention prunes hourly using session `last_seen_at`, cascading through counters, tools, toolkit and the latest context row; Rootlane MCP counts use the same retention. The existing SQLite backup includes all migration-005 tables. Back up before upgrading; rollback to an older schema requires the matching pre-upgrade database.

To stop ingestion and purge retained telemetry, set `telemetry.enabled` to `false` and run `deploy/rootlane-reload`. The receiver closes and the telemetry tables' rows are deleted. New Rootlane MCP counts can still accumulate because those remain available while telemetry is off. Remove the exporters and hooks/status-line wrapper from each agent's settings as well. Existing external backups remain your responsibility; deleting live rows does not rewrite them.
