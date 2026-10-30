# ContextLanes — implementation plan

## Needs Kyle

- **Real agent accounts:** run `contextlanes setup`, open its sign-in link, and use **Agent → Install / Sign in**. Sign in runs the provider’s fixed command in the browser terminal (`claude auth login`, `codex login --device-auth`, or `opencode auth login`). Complete the provider’s account flow, then choose **Check again** if needed. Real Claude/Codex acceptance still needs your accounts; tests use the SDK fake agent and a fake login terminal. No model call or credential is supplied automatically.
- **Tailscale / linger privileges:** setup enables Serve automatically when Tailscale is installed and signed in. If it prints a `tailscale up`, HTTPS/operator-access or `sudo loginctl enable-linger <user>` instruction, do that on the host and run `contextlanes setup` again. If Tailscale is missing, install it from the printed link or run the printed SSH tunnel command on your computer. No privileged command runs automatically. Setup reuses a route already pointing at this daemon; other routes are preserved.
- **Notifications:** after your first lane, use **Projects → Phone notifications** for Web Push; the app generates its VAPID keys when you enable it. Real browser permission/provider delivery still need Kyle. Set a reachable **Push contact** in notification settings if required by your push provider. Under **Other ways**, supply an ntfy topic/server/token or Telegram bot token, numeric chat ID and owner ID, then save. These remain `[notifications]` settings in `~/.config/contextlanes/config.toml`; Serve fills the public URL automatically. Subscribe to ntfy or start a bot conversation as appropriate.
- **Fresh machine / physical phone / timing:** run the one-line installer over SSH, scan the terminal QR code on a real phone and complete a real provider login. Check install-to-running-lane time under five minutes, including downloads and provider interaction; the measured Chromium fixture time starts at CLI setup and uses fakes for provider login and Tailscale. Check phone terminal input and reattach, then the phase-1 gate of three lanes daily for a week. Fresh OS provisioning, real QR scanning, provider delivery and the week-long gate have not been verified.

This is the build plan. The product brief is in [BRIEF.md](BRIEF.md), the system design in [ARCHITECTURE.md](ARCHITECTURE.md) and the visual system in [DESIGN.md](DESIGN.md). Coding agents: read [AGENTS.md](../AGENTS.md) first.

## Milestone status

Phase 1 is implemented. On 2026-10-30 the web app was rebuilt from the mockups (see below); the next goal is phase 2. External credentials and device acceptance remain in Needs Kyle.

| Milestone | Status | Evidence / next step |
|---|---|---|
| 1.1 Lane hosts for real | Implemented; real-agent acceptance needs Kyle | Complete systemd arguments, agent overrides, MCP toolbox, live steps, durable command/event replay, permission held across restart; SDK fake-agent and real systemd two-lane restart tests pass |
| 1.2 Permission round trip | Implemented; provider/device acceptance needs Kyle | ntfy HTTP actions, owner-checked Telegram keyboards/polling, Web Push + service worker, quiet hours, live Inbox, single-use answers and durable ask_owner; 56 tests and phone-sized browser round trip pass |
| 1.3 Terminals | Done | Validated WebSocket + PTY bridge, xterm, detach/reconnect, fake Runner tests, real tmux + CLI test and Chromium against a transient systemd daemon |
| 1.4 Work page | Done against DESIGN.md | Six families, measured diffs/tests, inline answers, composer and inspector, React Flow + ELK overview and two-hour timeline; desktop/phone browser flow passes |
| 1.5 Setup and install | Implemented; fresh-machine/device acceptance needs Kyle | Shell claim, automatic Serve, expiring sign-in link/QR, three gated steps, repo discovery, browser login and optional post-lane setup; 86 tests and both Chromium widths pass |
| UI to the mockups | Done | Every phase-1 page ported from `docs/mockups/` with the canvas class names; later-phase tabs and actions hidden behind `apps/web/src/features.ts`; walkthrough at 1440px and 390px with no page errors or sideways scrolling; `scripts/check-setup.mjs` passes at both widths |
| Phase 2 | Pending | Next. Flip `READY.review` and `READY.run` as each part works |

## Current capabilities

Everything below builds, typechecks and has tests (`pnpm check`). A lane can already be started end to end: project registered, branch and worktree created, tmux session opened, events recorded and streamed.

| Package | What works now | What is stubbed |
|---|---|---|
| `packages/protocol` | Lane ids and colours, the lane lifecycle with allowed moves, all event types with validated payloads, HTTP request and response types | — |
| `apps/daemon` | Config, SQLite event log and migrations, inbox, lane manager, systemd host launch (on by default), durable commands, event acknowledgements, HTTP controls and live stream, Tailscale identity checks, detachable terminal clients | Most toolbox calls return 501 until their phase |
| `apps/lanehost` | One independent systemd unit per lane; ACP agent and toolbox session, live coalesced steps, permission waiting, queued/immediate prompts, cancel/mode/model controls, reconnect with unacknowledged event replay | Actual Claude/Codex logins and acceptance need Kyle |
| `apps/cli` | `status`, `lanes`, `lane start`, `term` (tmux attach), `inbox`, `answer`, `setup`, `add` | `arch` waits for phase 3 |
| `packages/toolbox` | Eight declared MCP tools, stdio transport; `ask_owner` holds one durable question through daemon restarts and waits for a human choice | Other tools await their phases |
| `apps/web` | Ported from `docs/mockups/`: top bar with inbox count and ⌘K jump; Projects (Needs you with inline answers, project tiles, Add repositories dialog with discovery and a contained folder browser); Work (lanes grouped by goal, controls, step trail, permission card, message box, inspector, overview graph, terminal); Inbox (list and detail with what led here); Setup (machine and browser columns, Done / Now / Next steps); Settings; Models | Review, Run, Architecture and Insights tabs and their lane actions are built but hidden until their phase (`features.ts`) |

## UI rebuilt to the mockups (2026-10-30)

The earlier pages were written from DESIGN.md without the boards and drifted from them. They were rebuilt directly from the canvas: `docs/mockups/` holds every board as an image, `docs/mockups/README.md` maps each board to its route and files, and `app.css` uses the canvas class names. What changed beyond layout:

- **Project discovery** (`apps/daemon/src/projects.ts`) first reads Claude Code and Codex session history (`~/.claude/projects`, `~/.codex/sessions`) for the folders agents worked in, including ones outside home, newest first. The home walk then stops at each repository, skips folders with more than 300 subfolders (named in the dialog), goes five levels deep and stops after 6,000 folders or 3 seconds. Before, one large folder such as `~/data` used up the 2,000-folder budget and repositories elsewhere were never found. Repositories git refuses (another owner) or without commits are listed with a one-sentence reason instead of disappearing. Lane checkouts are excluded.
- **Folder browser** lives inside the Add repositories dialog (fixed height, scrolls), with breadcrumbs, a git tag and an Add button on each repository, and a path field for `~` and paths outside home.
- **Lane names** skip leftovers: if `lane/01-task`, its checkout folder, tmux session `cl-project-01` or host unit `contextlanes-lane-project-01` already exists (from an earlier install or a kept branch), the lane uses `-2`, `-3`… Existing shells and units are never killed. Before, the lane failed with a raw git or tmux error.
- **Failed lanes** open anyway and show why they stopped.
- **Idle lanes** (working, but the agent finished its turn) show the idle glyph and "Idle · waiting for your message".
- **Agents get only working tools.** `LIVE_TOOLS` in `packages/toolbox` is `ask_owner` today; a tool joins when its daemon route works.
- `GET /api/lanes` lists every project's lanes for the home page and ⌘K.

Not built from the boards yet (left out rather than faked): the "Ask" part of ⌘K, composer chips (@ file, / command, attach image), Watching only / Take over, context compaction count and "fresh session from handoff", the usage line on Projects, picking repositories from GitHub in Add repositories, per-project branch in the band. Fonts still load from Google Fonts.

## Principles

1. **Borrow, don't build.** ACP for agents, tmux for shells, systemd for processes, Caddy and Tailscale for access, CodeGraph for code, Playwright for screenshots. New code only where nothing fits.
2. **Everything is an event.** The store appends; screens, the CLI and insights read. No second source of truth.
3. **Agents live outside the daemon.** One lane host per lane as its own systemd unit.
4. **One owner.** Bind to loopback; shell access proves ownership. Remote requests use tailnet identity or an owner session; passkeys are optional after sign-in.
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

**1.5 Setup and install — headless follow-up**

Goal: a new user over SSH reaches a running lane without typing a path or setup code, in under five minutes.

- `contextlanes setup` checks linger and prints the exact sudo command only when needed; claims for the shell user; uses Tailscale Serve automatically when signed in; prints a single-use, ten-minute sign-in URL and the same URL as a terminal QR code. With no Tailscale it prints one install-link line and the exact SSH tunnel fallback.
- Browser steps are **Sign in → Connect an agent → Add projects → Start your first lane**, each marked Done, Now or Next; the current step is the first one not done. Agent requires at least one Ready agent; Project requires an added repository; a working lane completes the last step.
- Agents have one status: **Ready**, **Install**, **Sign in**. Installed CLIs appear first, the rest under **Other agents**. Install uses fixed pinned packages under `~/.local`; Sign in opens only that agent’s fixed login command in the owner’s browser terminal. Login completion refreshes readiness. Known failures give an actionable sentence; raw process/network exceptions are not rendered.
- Project discovery reads agent session history, then walks home (see "UI rebuilt to the mockups" for the current rules). Repositories show name, path and current branch; none are selected initially. The folder browser resolves canonical paths and refuses links/paths outside home. Explicit owner-entered paths and `contextlanes add [path]` accept `~`; CLI add defaults to the current folder. Discovery, browsing and branch APIs are owner-only.
- First lane reads local branches from Git, prefers `origin/HEAD` as default (then main/master/first local branch), offers only Ready agents, and supplies an example task placeholder. Notifications and local endpoints are post-lane Projects cards, with Web Push first and ntfy/Telegram under **Other ways**. The public URL comes from Serve. Local helper execution remains phase 3.
- A passkey is offered only after owner sign-in at the configured HTTPS tailnet address, labelled **Add a passkey for this address**. It never blocks onboarding.

Implementation: a mode-0600 local control credential is read automatically by the CLI, never typed or printed. `/api/setup/local` additionally requires a local peer/Host and refuses Origin/Tailscale headers, so a browser or remote caller cannot claim by merely posting to a public endpoint. The local credential remains private; only sign-in-link hashes, origin and expiry are persisted. Consumption uses one atomic SQLite delete; reuse, expiry or another origin fails. URL secrets live in the fragment and are removed on landing. HttpOnly/SameSite Strict sessions are Secure over HTTPS. Auth expiry never answers an agent permission. Existing typed-code endpoints and the initial passkey claim were removed.

Serve preserves other routes, reuses this app’s existing route, and otherwise checks 443, 8443 and 4601–4603 without binding the daemon anywhere except 127.0.0.1. It saves `[access].owner` and `[notifications].publicUrl`. Ports marked public by an existing Funnel configuration are not reused or enabled. Shell ownership is persisted independently for SSH-tunnel use. As before, `access.allowLocal` permits local CLI calls after ownership is established; disabling it requires an owner session or tailnet identity for application APIs.

The source installer still checks prerequisites, refuses existing install destinations/unrelated unit or bin files, builds esbuild separately, tolerates an unavailable native terminal build and writes the user service. Built web assets are served directly by the daemon. `qrcode-terminal@0.12.0` (no runtime dependencies, types pinned to 0.12.2) was added because Node and the repo have no QR encoder. WebAuthn continues to use `@simplewebauthn/server@14.0.3`. CLI install versions are pinned in `apps/daemon/src/setup.ts`.

Validation: **86 tests pass** with real systemd/tmux fixtures enabled. API tests cover shell proof, link origin/expiry/concurrent replay, owner and browser-origin guards, fixed login commands, native failure containment, config persistence, home traversal, depth/count limits and default branch selection. The real terminal fixture now starts a clean bash so user prompt hooks cannot erase captured proof; all persistence assertions remain.

`scripts/check-setup.mjs` starts fresh configurations at **1440px and 390px**. It runs the actual CLI, follows its URL (including when Setup was already open), signs in through a fixed fake browser login terminal, selects an initially unchecked repository, checks a non-main default branch, starts a real systemd host with the SDK fake agent, and explicitly answers its permission. Both reached a running lane in **about 2.6 seconds from CLI invocation** on this machine. It then verifies post-lane cards, automatic public URL, real WebAuthn registration at the fixture HTTPS address and link replay rejection. Tailscale is faked exclusively through the injected Runner; fixture HTTPS binds 127.0.0.1. This is not a timing claim for real downloads/provider sign-in.

```sh
curl -fsSL https://raw.githubusercontent.com/wongywrongy/rootlane/contextlanes/install.sh | sh
~/.local/bin/contextlanes setup
# Open the link or scan the QR; then Agent → Project → First lane.
~/.local/bin/contextlanes add          # optional: add the current repository
~/.local/bin/contextlanes add ~/code/project
CONTEXTLANES_REAL_HOSTS=1 CONTEXTLANES_REAL_TERMINAL=1 pnpm check
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs CHROMIUM_BIN=/absolute/path/to/chrome node scripts/check-setup.mjs
```

Generated installer units are also validated by the real `systemd-analyze --user verify` gate, including an install path with spaces and specifier characters. `WorkingDirectory` uses a literal path value (with percent specifiers escaped), not ExecStart-style quotes. After rebuilding an existing source checkout, restart its daemon before using the new CLI. Setup detects an older status response and prints a specific restart instruction instead of a generic failure. External acceptance remains in Needs Kyle. Phase 2 was not started.

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
- **OpenCode login detection limit:** its [CLI docs](https://opencode.ai/docs/cli/#list-1) document `auth list` as a provider list, without a stable JSON login-status API. The wizard accepts a recognized positive credential count in its human-readable output; otherwise it shows Sign in. It never treats command success alone as a login. Local-model and environment-provided credentials can also work without an interactive provider login.
- How long does CodeGraph take to index the largest repo, and how big is the index?
- Per-lane databases: Postgres template databases or copied SQLite files, chosen per project in the recipe?
- Which delegate kinds clear the redo-rate bar on the local GPU, and how many local jobs can run before lanes wait?
- `node:sqlite` still emits an experimental warning on the tested Node 24.11.0. The Store tests and full local check pass, so it remains behind the existing `Store` API; long-running production durability is not established by this milestone.
- Licence for the open-source release.
