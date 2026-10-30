# ContextLanes — implementation plan

## Needs Kyle

- **Real agents / 1.1 acceptance:** open `/setup` → **Connect agents**, install the Claude Code and Codex adapters, and run the displayed login commands on this machine: `claude-agent-acp --cli` then `/login`, and `codex login --device-auth`. Use `~/.local/bin/claude-agent-acp` if `~/.local/bin` is not on your shell PATH. Run one lane of each, then `systemctl --user restart contextlanes`. The development machine has no ACP adapters; acceptance used SDK fake agents in real systemd units. Installs remain pinned to `@agentclientprotocol/claude-agent-acp@0.99.1` and `@agentclientprotocol/codex-acp@2.5.0`.
- **Remote access:** sign in to Tailscale on the host (`tailscale up`), then choose **Setup → Remote access → Enable Tailscale Serve**. Enable HTTPS in the Tailscale console if prompted, and grant this user Serve/operator access if Tailscale refuses the command. The wizard saves `[access].owner` and `[notifications].publicUrl` in `~/.config/contextlanes/config.toml`. Existing routes are preserved; if both 443 and 8443 are occupied, free a port yourself. Live tailnet routes on this development machine were not changed.
- **ntfy:** in **Settings → Notifications**, set the public HTTPS app URL and a private, unguessable topic; optionally set the server URL and publishing token. Subscribe on the phone. These write `[notifications.ntfy]` and `[notifications].publicUrl` in the same config. Keep the topic and scoped answer capabilities private.
- **Telegram:** in the same form set bot token, numeric chat ID and owner user ID (`[notifications.telegram].botToken`, `.chatId`, `.ownerId`). Start a conversation with the bot. Real bot credentials and delivery need testing.
- **Web Push:** choose **Generate Web Push keys** in that form, set **Push contact** to your `mailto:` address, and save. On the phone, open the HTTPS app, install it on the home screen and choose **Enable push on this device**. Keys live under `[notifications.webPush]`; real provider delivery and browser permission need Kyle.
- **Real machine / phone acceptance:** run the one-line installer on a fresh Linux machine with a systemd user manager, Node ≥22.13, git and tmux. If user services must survive logout, run `sudo loginctl enable-linger "$USER"`. Then use three lanes a day for a week, answer from the phone, and check phone terminal input/reattach. Fresh-config Chromium checks at 390px/1440px and real fixture services pass; fresh-OS provisioning, a physical phone and the week-long phase gate have not been verified.

This is the build plan. The product brief is in [BRIEF.md](BRIEF.md), the system design in [ARCHITECTURE.md](ARCHITECTURE.md) and the visual system in [DESIGN.md](DESIGN.md). Coding agents: read [AGENTS.md](../AGENTS.md) first.

## Milestone status

The current goal is **finish phase 1**, first isolating native terminal loading, then implementing 1.1, 1.2, 1.4 and 1.5 in order. External credentials and physical device acceptance are listed above rather than blocking implementation.

| Milestone | Status | Evidence / next step |
|---|---|---|
| 1.1 Lane hosts for real | Implemented; real-agent acceptance needs Kyle | Complete systemd arguments, agent overrides, MCP toolbox, live steps, durable command/event replay, permission held across restart; SDK fake-agent and real systemd two-lane restart tests pass |
| 1.2 Permission round trip | Implemented; provider/device acceptance needs Kyle | ntfy HTTP actions, owner-checked Telegram keyboards/polling, Web Push + service worker, quiet hours, live Inbox, single-use answers and durable ask_owner; 56 tests and phone-sized browser round trip pass |
| 1.3 Terminals | Done | Validated WebSocket + PTY bridge, xterm, detach/reconnect, fake Runner tests, real tmux + CLI test and Chromium against a transient systemd daemon |
| 1.4 Work page | Done against DESIGN.md | Six families, measured diffs/tests, inline answers, composer and inspector, React Flow + ELK overview and two-hour timeline; desktop/phone browser flow passes |
| 1.5 Setup and install | Implemented; fresh-machine/device acceptance needs Kyle | Private claim + verified passkey or tailnet identity, wizard, config persistence, source installer and user service; 71 tests and fresh-config browser-to-first-lane check pass |
| Phase 2 | Pending | Outside the current goal |

## Current capabilities

Everything below builds, typechecks and has tests (`pnpm check`). A lane can already be started end to end: project registered, branch and worktree created, tmux session opened, events recorded and streamed.

| Package | What works now | What is stubbed |
|---|---|---|
| `packages/protocol` | Lane ids and colours, the lane lifecycle with allowed moves, all event types with validated payloads, HTTP request and response types | — |
| `apps/daemon` | Config, SQLite event log and migrations, inbox, lane manager, systemd host launch (on by default), durable commands, event acknowledgements, HTTP controls and live stream, Tailscale identity checks, detachable terminal clients | Most toolbox calls return 501 until their phase |
| `apps/lanehost` | One independent systemd unit per lane; ACP agent and toolbox session, live coalesced steps, permission waiting, queued/immediate prompts, cancel/mode/model controls, reconnect with unacknowledged event replay | Actual Claude/Codex logins and acceptance need Kyle |
| `apps/cli` | `status`, `lanes`, `lane start`, `term` (tmux attach), `inbox`, `answer`, `setup` | `arch` waits for phase 3 |
| `packages/toolbox` | Eight declared MCP tools, stdio transport; `ask_owner` holds one durable question through daemon restarts and waits for a human choice | Other tools await their phases |
| `apps/web` | Shell, global nav, project tabs, the section and glyph components, Projects and Inbox from the API, Work with live events and an xterm terminal with resize, connection status and reconnect | Setup, Settings and Models work; later-phase pages keep explicit empty states |

## Principles

1. **Borrow, don't build.** ACP for agents, tmux for shells, systemd for processes, Caddy and Tailscale for access, CodeGraph for code, Playwright for screenshots. New code only where nothing fits.
2. **Everything is an event.** The store appends; screens, the CLI and insights read. No second source of truth.
3. **Agents live outside the daemon.** One lane host per lane as its own systemd unit.
4. **One owner.** Bind to loopback; claim with a passkey or tailnet identity. Remote requests retain owner checks.
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

Implementation complete. Default commands are `claude-agent-acp`, `codex-acp`, and `opencode acp`; `[agents.<name>]` overrides `command`, `args`, and `env`. `[lanes.host]` and `[lanes.toolbox]` point to the built workspace entry points by default. Hosts launch by default; set `[lanes].launchHosts = false` only to use terminals without agents. Build once before development (`pnpm build`). New lanes default to `ask`; bypass, auto-approval and Codex auto-review modes are rejected.

Validation: an in-process SDK `agent()` covers MCP injection, live output, unresolved permission waiting, controls, prompt ordering and duplicate command suppression. A real systemd daemon plus two separate systemd lane hosts running the SDK fake agent retain their PIDs and permissions across `systemctl --user restart`. The full gate enables both real fixture tests:

```sh
CONTEXTLANES_REAL_HOSTS=1 CONTEXTLANES_REAL_TERMINAL=1 pnpm check
```

Real Claude/Codex acceptance is blocked only on the installs/logins above; implementation continues to 1.2 as requested.

**1.2 Permission round trip**
- Inbox from events (done); `POST /api/answers` (done) delivers to the host (done for connected hosts).
- Notifier: ntfy action buttons and a Telegram bot with inline keyboards both call `/api/answers`; Web Push for the installed web app. Quiet hours from config.
- Done when: a permission asked by an agent can be answered from the phone in one tap and the agent continues; unanswered requests wait indefinitely.

Implemented. The Inbox updates live and shows single-use buttons. ntfy sends scoped POST actions; Telegram uses inline keyboards and an outbound long poll restricted to both configured owner ID and chat ID; Web Push uses VAPID, persisted device subscriptions and a service worker. Notification capabilities are hashed in SQLite, bind one lane/request/option and remain usable only while that request is pending. All three channels reach `/api/answers`, which rejects stale, invented or repeated choices. No timer resolves a permission.

Quiet hours use `[notifications.quiet] start = "22:00", end = "08:00", timeZone = "Europe/London"`; equal start/end disables quiet hours. Pending notifications are checked again each minute and on startup. Delivery failures leave the permission pending and retry; sent events prevent ordinary duplicate delivery after daemon restart. Delivery is at least once if a process dies between an external send and its recorded event. Only single-use options are sent as notification actions; open the app for other question choices.

`ask_owner` is live in the toolbox. It posts/polls the same question ID, survives daemon unavailability, respects MCP cancellation, and never substitutes an answer. `checkpoint` remains phase 2 alongside checker/review work.

Validation: all 56 tests pass with the real systemd/tmux fixtures enabled. Provider transports are faked; tests cover quiet-hour deferral, authorization, duplicate actions, expired subscriptions, failures, question polling and service-worker clicks. Chromium at 390px answered **Allow once** and **Deny** through the real systemd daemon, the SDK fake agent continued, and the next request arrived through SSE without reloading. Real phone/provider acceptance is the remaining external dependency above, so work continues to 1.4.

**1.3 Terminals**
- tmux session per lane (done). Add `GET /api/lanes/:p/:n/terminal` as a WebSocket that spawns `tmux attach-session -t <session>` under `node-pty`; xterm.js in the Work page's Terminal view.
- Kill the session at cleanup only. `contextlanes term` (done).
- Done when: closing the browser tab leaves the shell running and `contextlanes term` shows the same scrollback.

Completed: closing the tab, switching views or stopping the daemon releases only that PTY's `tmux attach-session` client. The tmux session is never killed by the terminal route. Older history stays in tmux copy mode (**Ctrl+B**, then **[**); use **q** to leave it. There is no cleanup endpoint yet; killing lane sessions belongs to phase 2 cleanup.

Native `node-pty` loading is deferred until a terminal opens. A missing native build closes that terminal connection with an attach error; the daemon, health endpoint and other API routes keep working. A regression test simulates the native module load failure.

Validation: `pnpm check`; opt-in real tmux/fixture-repo test (including CLI attach after daemon recreation); built Vite app in Chromium at 1440×1000 and 390×844 against a transient systemd user service, including an actual daemon restart. Browser input, close/reopen and Steps/Terminal switching passed with no page errors. Only fixture sessions, services and repositories were removed.

```sh
pnpm check
CONTEXTLANES_REAL_TERMINAL=1 pnpm exec vitest run apps/daemon/test/terminal.real.test.ts
pnpm dev
# Open http://127.0.0.1:5173/p/<project>/work and select Terminal.
node apps/cli/dist/main.js term <project>/01
```

**1.4 Work page**
- Step trail rendered by family (look, change, run, mind, you, team) with the icon tiles, diff bars and test pips from the mockups; thinking collapsed by default.
- Permission card inline; composer with queue (`↵`) and send now (`⌘↵`); interrupt (`Esc`).
- Overview: goal → lanes graph with React Flow + ELK and the last-2-hours timeline.
- Done when: the Work page matches the v4 canvas boards "Work · one lane" and "Work · overview".

Completed against `docs/DESIGN.md`, the supplied UI authority (canvas boards are not in this repository). Overview groups lanes by goal and draws owner gates using React Flow with ELK layout. Its two-hour timeline distinguishes recorded working, idle, waiting and failed periods, including the preceding state/turn. Selection is retained in `?lane=project/NN`, including notification links.

One-lane view renders all six families, joins text chunks, folds thinking by default and retains failed-then-fixed tool history. Counts come from ACP old/new content via `diff`; individual test pips come from TAP/check events. Unknown results are not estimated. Diffs exceeding the 100ms comparison budget omit counts; full checkpoint diffs are phase 2. Tool output is capped at 12,000 characters with an explicit marker.

Enter queues; Cmd/Ctrl+Enter interrupts the current turn and sends now; Shift+Enter adds a line; Escape interrupts in Steps and remains a terminal key in Terminal. Queued messages stay visible until their own turn starts. Model/mode changes wait for agent confirmation. The inspector shows plan, reported context use and checkout details. History paginates beyond 500 events and catches up after reconnect; Inbox cards and badge share one stream. Terminal and overview code load only when opened.

Validation: 61 tests pass with real fixture services enabled. Chromium at 1440px/390px verified graph, all step families, collapsed thinking, diff bars, test pips, queue shortcuts, interrupt, model/mode changes, inline permission and terminal switching, with no page errors or horizontal overflow.

**1.5 Setup and install**
- One-line install script: checks Node ≥ 22.13, git, tmux; installs the package; writes a systemd user unit; prints a URL and claim code.
- Browser wizard: claim (owner passkey or tailnet identity), remote access (Tailscale Serve), connect agents (detect `claude`, `codex`, `opencode` and their logins), add projects, notifications, local models. Everything written to `config.toml`.
- Done when: a fresh machine goes from install to first lane without editing a file.

Implemented. `install.sh` checks prerequisites, clones only into a new destination, installs pinned dependencies, builds, writes the user service and CLI wrappers, then prints a localhost setup URL and private claim code. It refuses existing destinations and unrelated service/bin files. It builds esbuild separately and treats a failed node-pty build as a terminal-only limitation. The daemon serves the built SPA directly, so installed use does not need Vite. `contextlanes setup` prints the claim code only when called locally before ownership is set.

The wizard claims once with the private code and either a verified WebAuthn passkey or Tailscale identity. Passkeys require HTTPS or `http://localhost` (not an IP address); challenge expiry/replay/origin/user-verification checks use `@simplewebauthn/server@14.0.3`, added because Node does not provide a complete WebAuthn/CBOR verifier. Session cookies are HttpOnly/SameSite Strict, Secure over HTTPS, and hashed in SQLite. Loopback CLI access remains on by default after claim; `access.allowLocal = false` requires an owner session or matching Tailscale identity. API requests using unrelated hostnames cannot use local authorization.

Remote access chooses an unused Serve HTTPS port without resetting routes. Agent detection checks executable availability and read-only login status; adapter installs use pinned npm packages under `~/.local`. Claude/Codex login output is never returned; OpenCode status stays unknown when its human-readable output cannot be established. Projects are verified with Git and persisted to config; reloading does not register them twice. Notification settings restart the notifier safely, VAPID keys are generated once, and optional local-model health probes accept only HTTP on 127.0.0.1 without redirects. Local helper execution remains phase 3. Model and Settings pages reuse these controls.

Validation: 71 tests pass with both real systemd/tmux fixtures enabled. API tests cover claim protection, owner/session checks, replay/origin rejection, safe config writes, project validation, pinned installs, preserving Serve routes, model probes, static serving, socket ownership and closing live streams during restart. `scripts/check-setup.mjs` drives Chromium against a fresh config and actual systemd daemon: native browser passkey creation/verification, claim replay rejection, wizard registration/settings, first SDK fake-agent lane, permission answer, phone layout, restart with a live browser, persisted session, passkey sign-in and rejection without user verification. Installer unit generation is tested with a fixture home and fake Runner. A disposable source copy also passed frozen/offline dependency installation with scripts disabled, separate esbuild and node-pty builds, and the full production build. This has not provisioned a fresh OS.

```sh
curl -fsSL https://raw.githubusercontent.com/wongywrongy/rootlane/contextlanes/install.sh | sh
# Or, from a built source checkout:
node apps/daemon/dist/install-main.js
~/.local/bin/contextlanes setup
# Optional browser acceptance, with existing Playwright/Chromium paths:
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs CHROMIUM_BIN=/absolute/path/to/chrome node scripts/check-setup.mjs
```

Plan adjustments: the built daemon also serves the UI, which makes installation usable without a second server; setup added private owner sessions and a passkey verifier. Browser testing exposed live SSE streams delaying restart, so shutdown now ends them before closing HTTP. The existing lane socket is probed before stale-socket removal, preventing a second daemon from unlinking an active daemon's socket. External acceptance remains listed above; phase 2 was not started.

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
- **Terminal end to end:** `CONTEXTLANES_REAL_TERMINAL=1 pnpm exec vitest run apps/daemon/test/terminal.real.test.ts` opts into real tmux, PTYs, a throwaway git repo and loopback HTTP. The ordinary suite fakes all commands through `Runner`, including its terminal launcher. The opt-in test checks shell state, history beyond the screen, prompt client cleanup, daemon recreation and the actual CLI entry point.

## Open questions

- **Resolved from adapter code:** both current registry adapters support `session/resume` and `session/load`. Claude advertises `resume: {}` in [`acp-agent.ts`](https://github.com/agentclientprotocol/claude-agent-acp/blob/2fd46c866d4ff2939fe1b1245b15a536d6de7c0b/src/acp-agent.ts); Codex does so in [`CodexAcpServer.ts`](https://github.com/agentclientprotocol/codex-acp/blob/ac8d9251de43ab8648a89eb0520e0c606ad78be5/src/CodexAcpServer.ts). ContextLanes keeps the existing process/session alive across daemon restarts because resume cannot preserve an outstanding in-process permission handler. Agent connection failures are recorded; tasks are not silently rerun. Investigate forcibly killed hosts through their systemd journal.
- **Resolved from Claude adapter code, not a login test:** it advertises Claude subscription terminal authentication, and detects SSH/`NO_BROWSER` to select the interactive `--cli` TUI login flow. It is not an unattended ACP login. Kyle still needs to authenticate and verify his subscription on this machine. `--hide-claude-auth` can intentionally disable subscriptions; ContextLanes does not set it. Source: [`acp-agent.ts`](https://github.com/agentclientprotocol/claude-agent-acp/blob/2fd46c866d4ff2939fe1b1245b15a536d6de7c0b/src/acp-agent.ts).
- **Safety finding:** Codex's current default `agent` mode delegates approvals to auto review. ContextLanes forces `INITIAL_AGENT_MODE=read-only`, selects a human-approval mode before prompting, and excludes `agent` and full-access modes. Source: [`AgentMode.ts`](https://github.com/agentclientprotocol/codex-acp/blob/ac8d9251de43ab8648a89eb0520e0c606ad78be5/src/AgentMode.ts).
- **Resolved from current Tailscale docs:** named [Tailscale Services](https://tailscale.com/docs/features/tailscale-services) can give separate `name.<tailnet>.ts.net` addresses through `serve --service=svc:name`; they require a tagged host plus admin service definition/host approval. The phase-1 wizard uses the user-owned device address and an unused HTTPS port. Phase 2 may use Services as a named fallback; custom wildcard domains still need the planned DNS/certificate integration. This was documentation research, not a change to Kyle’s tailnet.
- **OpenCode login detection limit:** its [CLI docs](https://opencode.ai/docs/cli/#list-1) document `auth list` as a provider list, without a stable JSON login-status API. The wizard runs it but reports unknown when it cannot establish status; it never treats command success alone as a login. Local-model and environment-provided credentials can also work without an interactive provider login.
- How long does CodeGraph take to index the largest repo, and how big is the index?
- Per-lane databases: Postgres template databases or copied SQLite files, chosen per project in the recipe?
- Which delegate kinds clear the redo-rate bar on the local GPU, and how many local jobs can run before lanes wait?
- `node:sqlite` still emits an experimental warning on the tested Node 24.11.0. The Store tests and full local check pass, so it remains behind the existing `Store` API; long-running production durability is not established by this milestone.
- Licence for the open-source release.
