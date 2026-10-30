# ContextLanes — implementation plan

This is the build plan. The product brief is in [BRIEF.md](BRIEF.md), the system design in [ARCHITECTURE.md](ARCHITECTURE.md) and the visual system in [DESIGN.md](DESIGN.md). Coding agents: read [AGENTS.md](../AGENTS.md) first.

## Where the scaffold stands

Everything below builds, typechecks and has tests (`pnpm check`). A lane can already be started end to end: project registered, branch and worktree created, tmux session opened, events recorded and streamed.

| Package | What works now | What is stubbed |
|---|---|---|
| `packages/protocol` | Lane ids and colours, the lane lifecycle with allowed moves, all event types with validated payloads, HTTP request and response types | — |
| `apps/daemon` | Config from `config.toml`, SQLite store on `node:sqlite` with migrations, event log with gap-free seq per lane, inbox derived from events, lane manager (worktree + tmux), lane-host socket, HTTP API, live stream (SSE), Tailscale identity check | Launching lane hosts is behind `lanes.launchHosts`; toolbox calls return 501 |
| `apps/lanehost` | ACP client on `@agentclientprotocol/sdk`: spawns the agent, opens a session, runs prompts, coalesces streamed text into steps, maps tool calls and plans to events, relays permission requests and waits for your answer | Not yet launched by the daemon; no reconnect after a daemon restart |
| `apps/cli` | `status`, `lanes`, `lane start`, `term` (tmux attach), `inbox`, `answer` | `arch` and `setup` print where they land |
| `packages/toolbox` | The eight MCP tools declared with input schemas and served over stdio | Every tool returns 501 until its phase |
| `apps/web` | Shell, global nav, project tabs, the section and glyph components, Projects and Inbox from the API, Work with live events and the Steps / Terminal switch | Other pages show their final sections with empty states |

## Principles

1. **Borrow, don't build.** ACP for agents, tmux for shells, systemd for processes, Caddy and Tailscale for access, CodeGraph for code, Playwright for screenshots. New code only where nothing fits.
2. **Everything is an event.** The store appends; screens, the CLI and insights read. No second source of truth.
3. **Agents live outside the daemon.** One lane host per lane as its own systemd unit.
4. **No accounts.** Bind to loopback; Tailscale says who you are.
5. **Agents can ask, never approve.** Recipes are approved once, by hash, from the owner's session. Nothing is allowed on a timer.
6. **One job per page.** Every group of content sits in a section card; a side column only as the inspector of a selection.
7. **Every claim is measured.** Token savings, redo rates and review time are computed from events, not estimated.

## Phase 1 — Lanes you steer

Gate: three lanes a day for a week, answered from the phone.

**1.1 Lane hosts for real**
- Daemon launches `contextlanes-lanehost` with `systemd-run --user` (see `hostCommand`), passing lane, task, agent and the socket path.
- Agents: `claude-agent-acp` and `codex-acp` from the ACP registry; commands overridable under `[agents.<name>]` in `config.toml`.
- Pass the toolbox to every session with `withMcpServer` (stdio, `CONTEXTLANES_LANE` set).
- Reconnect: the host keeps the ACP session when the daemon restarts and re-sends `hello`; the daemon resumes the lane.
- Prompt, cancel, mode and model: `POST /api/lanes/:p/:n/prompt|cancel|mode|model` → host → `session/prompt`, `session/cancel`, `session/set_mode`, `session/set_config_option`.
- Done when: a real Claude Code lane and a real Codex lane run side by side, survive `systemctl --user restart contextlanes`, and their steps appear live.

**1.2 Permission round trip**
- Inbox from events (done); `POST /api/answers` (done) delivers to the host (done for connected hosts).
- Notifier: ntfy action buttons and a Telegram bot with inline keyboards both call `/api/answers`; Web Push for the installed web app. Quiet hours from config.
- Done when: a permission asked by an agent can be answered from the phone in one tap and the agent continues; unanswered requests wait indefinitely.

**1.3 Terminals**
- tmux session per lane (done). Add `GET /api/lanes/:p/:n/terminal` as a WebSocket that spawns `tmux attach-session -t <session>` under `node-pty`; xterm.js in the Work page's Terminal view.
- Kill the session at cleanup only. `contextlanes term` (done).
- Done when: closing the browser tab leaves the shell running and `contextlanes term` shows the same scrollback.

**1.4 Work page**
- Step trail rendered by family (look, change, run, mind, you, team) with the icon tiles, diff bars and test pips from the mockups; thinking collapsed by default.
- Permission card inline; composer with queue (`↵`) and send now (`⌘↵`); interrupt (`Esc`).
- Overview: goal → lanes graph with React Flow + ELK and the last-2-hours timeline.
- Done when: the Work page matches the v4 canvas boards "Work · one lane" and "Work · overview".

**1.5 Setup and install**
- One-line install script: checks Node ≥ 22.13, git, tmux; installs the package; writes a systemd user unit; prints a URL and claim code.
- Browser wizard: claim (owner passkey or tailnet identity), remote access (Tailscale Serve), connect agents (detect `claude`, `codex`, `opencode` and their logins), add projects, notifications, local models. Everything written to `config.toml`.
- Done when: a fresh machine goes from install to first lane without editing a file.

## Phase 2 — Apps and review

Gate: review a checkpoint in under five minutes.

- **Recipes:** `.contextlanes.json` schema (services, ports, health checks, setup steps, checks). Approval by hash in the `approval` table.
- **Lane setup:** copy ignored files (`.env*`), link or copy the dependency cache, create a per-lane database (Postgres template database or copied SQLite file), record disk use.
- **Runtime:** each service as a systemd user unit with its own port; health checks; journald logs in Run.
- **Previews:** one subdomain per lane service (`web-billing.root.example.dev`) through Caddy with a wildcard certificate on the tailnet address; Tailscale Serve as the fallback. Never path-based.
- **Checker:** on `checkpoint`, run the recipe's checks, take before and after screenshots with Playwright, compare the plan with what was done (flag unplanned changes), size the diff. Store as a `checkpoint` row.
- **Review page:** result, process signal, plan vs done, before and after, steps, files; approve and merge (rebase, push, PR via `gh`), request changes (back to the same agent), ask a second agent.
- **Cleanup:** stop units, drop lane databases, remove worktrees, keep branches, never delete unpushed work.
- Toolbox: `env_status`, `env_start`, `get_logs`, `preview_url`, `checkpoint` go live.

## Phase 3 — Shared context

Gate: 30% fewer cloud tokens on the same tasks.

- **Code map:** CodeGraph index per project, refreshed by a file watcher on each worktree. Layers from config or inferred from paths.
- **Architecture page and `contextlanes arch`:** layered dependency view, lane overlay, modules two lanes edit, modules that use a changed module, main paths; `--json` and `--mermaid`.
- **Collision warnings:** within a minute of two lanes editing one module, warn both lanes and suggest a merge order.
- **Module briefs:** written by the local model, cached by file hash; `get_brief` goes live.
- **Local helper:** `delegate` (read, edit, check) runs a small agent on Ollama in the worktree; one job per GPU at a time; tokens saved and redo rate per kind, with automatic switch-off above a redo threshold.
- **Insights:** nightly and after each merge, the local model reads the event log, git, CodeGraph and test results and writes a weekly summary plus typed suggestions, each citing evidence and offering one action.

## Phase 4 — Later

Overview graph polish, scheduled lanes (systemd timers), more ACP agents (Hermes, Gemini, Goose), routing rules, second-agent review, learned skills shared across lanes.

## Testing

- **Unit and API:** Vitest across the repo (`pnpm test`); daemon routes through `fastify.inject`; commands injected through `Runner` so tests never touch git or tmux.
- **Lane host integration:** connect the ACP client to an in-process fake agent built with the SDK's `agent()` app (`ClientApp.connect(agentApp)`), so permission and streaming flows are tested without a real model.
- **Web:** Playwright smoke tests against `vite preview` with a seeded daemon; screenshots compared with the canvas boards by eye at first.
- **End to end:** a nightly job on neo starts a lane on a fixture repo with a cheap local model and checks the full loop.

## Open questions

- Do `claude-agent-acp` and `codex-acp` both support `session/resume`, or must the lane host keep the agent process alive for the whole lane?
- Does a Claude subscription login work through `claude-agent-acp` on a headless machine?
- Can Tailscale Serve give each lane its own name, or do we always need Caddy with a DNS API token?
- How long does CodeGraph take to index the largest repo, and how big is the index?
- Per-lane databases: Postgres template databases or copied SQLite files, chosen per project in the recipe?
- Which delegate kinds clear the redo-rate bar on the local GPU, and how many local jobs can run before lanes wait?
- `node:sqlite` is still marked experimental in Node 22; confirm it is stable enough on Node 24 or fall back to `better-sqlite3` behind the same `Store` API.
- Licence for the open-source release.
