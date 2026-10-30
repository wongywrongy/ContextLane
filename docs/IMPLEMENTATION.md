# ContextLanes — implementation plan

## Needs Kyle

- **Decide how far to trust processes on this machine (security, from the 2026-10-30 audit).** Agents and the services they write run as your Unix user next to the daemon. Two consequences:
  - Any local process can answer a permission, change a lane's mode, rewrite settings or install an agent adapter through the loopback API, with no header forging, because loopback requests are trusted after the machine is claimed (`access.allowLocal`, on by default). A recipe check that runs a `package.json` script the agent edited can do this without a prompt.
  - In the default `serve` preview mode, previews are the app's own hostname on another port, and browsers send cookies to every port. Opening a lane preview sends your 30-day owner cookie to code the agent wrote.
  - Proposed fix: run lane hosts and lane services in sandboxed units that cannot reach the daemon's port or read its data folder, accept only Tailscale identity at the tailnet address (no cookie there), and keep the cookie for SSH-tunnel use on localhost. Until then, prefer `caddy` or `services` preview modes, which use other hostnames.
- **Real agent accounts:** run `contextlanes setup`, open its sign-in link, and use **Agent → Install / Sign in**. Sign in runs the provider’s fixed command in the browser terminal (`claude auth login`, `codex login --device-auth`, or `opencode auth login`). Complete the provider’s account flow, then choose **Check again** if needed. Real Claude/Codex acceptance still needs your accounts; tests use the SDK fake agent and a fake login terminal. No model call or credential is supplied automatically.
- **Tailscale / linger privileges:** setup enables Serve automatically when Tailscale is installed and signed in. If it prints a `tailscale up`, HTTPS/operator-access or `sudo loginctl enable-linger <user>` instruction, do that on the host and run `contextlanes setup` again. If Tailscale is missing, install it from the printed link or run the printed SSH tunnel command on your computer. No privileged command runs automatically. Setup reuses a route already pointing at this daemon; other routes are preserved.
- **Notifications:** after your first lane, use **Settings → Notifications** (Phone notifications) for Web Push; the app generates its VAPID keys when you enable it. Real browser permission/provider delivery still need Kyle. Set a reachable **Push contact** in notification settings if required by your push provider. Under **Other ways**, supply an ntfy topic/server/token or Telegram bot token, numeric chat ID and owner ID, then save. These remain `[notifications]` settings in `~/.config/contextlanes/config.toml`; Serve fills the public URL automatically. Subscribe to ntfy or start a bot conversation as appropriate.
- **Fresh machine / physical phone / timing:** run the one-line installer over SSH, scan the terminal QR code on a real phone and complete a real provider login. Check install-to-running-lane time under five minutes, including downloads and provider interaction; the measured Chromium fixture time starts at CLI setup and uses fakes for provider login and Tailscale. Check phone terminal input and reattach, then the phase-1 gate of three lanes daily for a week. Fresh OS provisioning, real QR scanning, provider delivery and the week-long gate have not been verified.
- **Previews on named Tailscale Services (optional):** the default works today: each lane service gets its own HTTPS port on this device (4700–4799, tailnet only). For named links, tag this machine, define the `svc:` names in the Tailscale admin console and approve the host, then set `[previews] mode = "services"`. neo has no tag now, so this path is built and tested with a fake only.
- **Previews through Caddy (optional):** install Caddy, point a wildcard DNS name at this machine's tailnet address, give Caddy a DNS-provider token for the wildcard certificate, bind it to the tailnet address only, then set `[previews] mode = "caddy"` and `[previews.caddy] domain = "root.example.dev"`. Tested with a fake admin API; no real certificate or DNS has been tried.
- **Real merge:** `gh` is signed in on neo, but approve and merge has only run against a throwaway bare repository with `gh` faked. Try it first on a repository you do not mind. `Approve and merge` opens the pull request; merging it on GitHub stays with you.
- **Phone and timing:** open Review and Run on a real phone, and time a real checkpoint against the five-minute gate. The browser check covers 390px in Chromium; nobody has timed a review.
- **Browser on a fresh machine:** checkpoint screenshots use Playwright's Chromium 1248, already on neo. Elsewhere run `pnpm --filter @contextlanes/daemon exec playwright-core install chromium`, or set `[checker] chromium = "/path/to/chrome"`. Without a browser a checkpoint still works and says why it has no pictures.
- **GitHub Actions billing:** CI has not run on this branch since at least 4197ca7; GitHub refuses to start the job because of a failed payment or spending limit. Fix it under Billing & plans. Every result in this document comes from this machine.

This is the build plan. The product brief is in [BRIEF.md](BRIEF.md), the system design in [ARCHITECTURE.md](ARCHITECTURE.md) and the visual system in [DESIGN.md](DESIGN.md). Coding agents: read [AGENTS.md](../AGENTS.md) first.

## Milestone status

Phases 1 and 2 are implemented. On 2026-10-30 the web app was rebuilt from the mockups (see below) and phase 2 landed on top. External credentials, a real merge and device acceptance remain in Needs Kyle. The next goal is phase 3.

| Milestone | Status | Evidence / next step |
|---|---|---|
| 1.1 Lane hosts for real | Implemented; real-agent acceptance needs Kyle | Complete systemd arguments, agent overrides, MCP toolbox, live steps, durable command/event replay, permission held across restart; SDK fake-agent and real systemd two-lane restart tests pass |
| 1.2 Permission round trip | Implemented; provider/device acceptance needs Kyle | ntfy HTTP actions, owner-checked Telegram keyboards/polling, Web Push + service worker, quiet hours, live Inbox, single-use answers and durable ask_owner; 56 tests and phone-sized browser round trip pass |
| 1.3 Terminals | Done | Validated WebSocket + PTY bridge, xterm, detach/reconnect, fake Runner tests, real tmux + CLI test and Chromium against a transient systemd daemon |
| 1.4 Work page | Done against DESIGN.md | Six families, measured diffs/tests, inline answers, composer and inspector, React Flow + ELK overview and two-hour timeline; desktop/phone browser flow passes |
| 1.5 Setup and install | Implemented; fresh-machine/device acceptance needs Kyle | Shell claim, automatic Serve, expiring sign-in link/QR, three gated steps, repo discovery, browser login and optional post-lane setup; 86 tests and both Chromium widths pass |
| UI to the mockups | Done | Every phase-1 page ported from `docs/mockups/` with the canvas class names; later-phase tabs and actions hidden behind `apps/web/src/features.ts`; walkthrough at 1440px and 390px with no page errors or sideways scrolling; `scripts/check-setup.mjs` passes at both widths |
| 2.1 Lane host units | Done | Free unit names alongside branches, checkouts and tmux sessions; stored in `lane.host_unit` |
| 2.2 Recipes | Done | `.contextlanes.json` schema in `packages/protocol`; approval by hash of the exact bytes, owner session only |
| 2.3 Setup and runtime | Done | Ignored `.env*`, dependency cache, setup steps, one systemd unit per service on a free port, health loop, journald; real systemd fixture passes, including a killed service recovering |
| 2.4 Run page | Done | `READY.run`; compared with `run.webp` at 1440px and 390px; Environment block in the lane inspector |
| 2.5 Previews | Done on Serve; Services and Caddy need Kyle | One real Serve link checked through the tailnet and removed; Services and Caddy tested with fakes |
| 2.6 Checker | Done | Real checks, diff and before/after screenshots in a real fixture; Playwright core pinned at 1.64.1 |
| 2.7 Review page | Done; real merge needs Kyle | `READY.review`; compared with `review.webp`; merge tested with real git against a throwaway bare remote and fake `gh` |
| 2.8 Cleanup | Done | Refuses unpushed or uncommitted work before touching anything; keeps branches; kills tmux only here |
| `contextlanes update` | Done | Builds beside the running version, backs up the database, switches with a health check and switches back on failure; `--check`, `--rollback`; end-to-end run with a live lane (see Updating) |
| Audit of phases 1–2 | Fixes in; two security decisions open | See Audit and Needs Kyle |

## Current capabilities

Everything below builds, typechecks and has tests (`pnpm check`). A lane can already be started end to end: project registered, branch and worktree created, tmux session opened, events recorded and streamed.

| Package | What works now | What is stubbed |
|---|---|---|
| `packages/protocol` | Lane ids and colours, the lane lifecycle with allowed moves, all event types with validated payloads, HTTP request and response types | — |
| `apps/daemon` | Config, SQLite event log and migrations, inbox, lane manager, systemd host launch (on by default), durable commands, event acknowledgements, HTTP controls and live stream, Tailscale identity checks, detachable terminal clients, recipes, runtime, previews, checker, review and cleanup | `get_brief` and `delegate` return 501 until phase 3 |
| `apps/lanehost` | One independent systemd unit per lane; ACP agent and toolbox session, live coalesced steps, permission waiting, queued/immediate prompts, cancel/mode/model controls, reconnect with unacknowledged event replay | Actual Claude/Codex logins and acceptance need Kyle |
| `apps/cli` | `status`, `lanes`, `lane start` (base defaults to the project's default branch, `--base` to change it), `term` (tmux attach), `inbox`, `answer`, `setup`, `add`, `update` (`--check`, `--rollback`) | `arch` arrives with phase 3 |
| `packages/toolbox` | Eight declared MCP tools, stdio transport; `ask_owner` holds one durable question through daemon restarts and waits for a human choice; `env_status`, `env_start`, `get_logs`, `preview_url` and `checkpoint` are live | `get_brief` and `delegate` await phase 3 |
| `apps/web` | Ported from `docs/mockups/`: top bar with inbox count and ⌘K jump; Projects (Needs you with inline answers, project tiles, Add repositories dialog with discovery and a contained folder browser); Work (lanes grouped by goal, controls, step trail, permission card, message box, inspector, overview graph, terminal); Inbox (list and detail with what led here); Setup (machine and browser columns, Done / Now / Next steps); Settings; Models; Run; Review | Architecture and Insights tabs and their lane actions are built but hidden until their phase (`features.ts`) |

## UI rebuilt to the mockups (2026-10-30)

The earlier pages were written from DESIGN.md without the boards and drifted from them. They were rebuilt directly from the canvas: `docs/mockups/` holds every board as an image, `docs/mockups/README.md` maps each board to its route and files, and `app.css` uses the canvas class names. What changed beyond layout:

- **Project discovery** (`apps/daemon/src/projects.ts`) first reads Claude Code and Codex session history (`~/.claude/projects`, `~/.codex/sessions`) for the folders agents worked in, including ones outside home, newest first. The home walk then stops at each repository, skips folders with more than 300 subfolders (named in the dialog), goes five levels deep and stops after 6,000 folders or 3 seconds. Before, one large folder such as `~/data` used up the 2,000-folder budget and repositories elsewhere were never found. Repositories git refuses (another owner) or without commits are listed with a one-sentence reason instead of disappearing. Lane checkouts are excluded.
- **Folder browser** lives inside the Add repositories dialog (fixed height, scrolls), with breadcrumbs, a git tag and an Add button on each repository, and a path field for `~` and paths outside home.
- **Lane names** skip leftovers: if `lane/01-task`, its checkout folder, tmux session `cl-project-01` or host unit `contextlanes-lane-project-01` already exists (from an earlier install or a kept branch), the lane uses `-2`, `-3`… Existing shells and units are never killed. Before, the lane failed with a raw git or tmux error.
- **Failed lanes** open anyway and show why they stopped.
- **Idle lanes** (working, but the agent finished its turn) show the idle glyph and "Idle · waiting for your message".
- **Agents get only working tools.** `LIVE_TOOLS` in `packages/toolbox` lists the tools whose daemon routes work (after phase 2: `ask_owner` and the five environment and checkpoint tools); `get_brief` and `delegate` join in phase 3.
- `GET /api/lanes` lists every project's lanes for the home page and ⌘K.

Not built from the boards yet (left out rather than faked): the "Ask" part of ⌘K, composer chips (@ file, / command, attach image), Watching only / Take over, context compaction count and "fresh session from handoff", the usage line on Projects, picking repositories from GitHub in Add repositories, per-project branch in the band. Fonts still load from Google Fonts.

## Updating (2026-10-30)

`contextlanes update` (`apps/daemon/src/update.ts`, run through `update-main.js` so the CLI stays light):

1. Refuses if tracked files in the running copy were edited, and names them. One update runs at a time (`update.lock`).
2. Fetches every branch and lists what is new. It follows the branch recorded in `update.json`, else the clone's upstream, else `main`; if that branch is gone it follows the repository's default branch. A remote still pointing at `wongywrongy/rootlane` is switched to `wongywrongy/contextlane`.
3. Builds the new commit in `releases/<commit>`, a git worktree of the original clone (`app/`), with the same steps as the installer. A failed build changes nothing. A finished build is marked with `.contextlanes-built` and reused on a retry.
4. Copies the database with `VACUUM INTO` (newest five kept in `<data>/backups`) and records its format version.
5. The first time, points the service file and the `contextlanes` commands at `current` instead of the clone. It replaces only files that carry the installer's marker line.
6. Points `previous` at the running release and `current` at the new one, restarts the daemon and waits up to 30 seconds for `/api/health` to report the new commit. Otherwise it stops the daemon, restores the database if the new version changed its format, switches back and starts the old one.
7. Prunes releases, keeping current, previous, the newest three and any a running process still uses. Lane hosts started before the update keep running from their own release folder.

`--check` stops after step 2. `--rollback` goes back to `previous`; when the newer version changed the database format it asks for `--yes`, because the restore drops history recorded since the update. `install.sh` on an installed machine builds the newest commit beside it and runs the same switch (`update-main.js --adopt`), which is how installs from before this command get it. A plain source checkout is not managed and is told to use git. The daemon reports the commit it was built from as its version.

Verified here end to end with real builds, a real daemon restart (systemctl faked by a script that runs the unit file) and a lane waiting on a permission: old install (5e00f6b, single-folder layout) → `install.sh` update to a88b8d2 in 32 s with the lane host still running from the old folder, reconnecting and finishing after the answer → `--check` → update to a new commit → `--rollback` → update again → fresh install with the new layout. Unit tests cover the failure paths (build failure, unhealthy start with database restore, edited files, lock, gone branch, renamed repository, pruning).

## Audit of phases 1–2 (2026-10-30)

An independent review checked the code against this plan. Fixed:

- A lane failed by one agent error (a 429, a dropped connection) is working again when the agent takes a new turn, instead of never reaching review.
- Lane host arguments use `--name=value` and escape `$` for systemd, so a task starting with `-` or containing `$` reaches the agent.
- Approving again after a rebase onto a moved base and a failed push or `gh` finishes the merge (`checkpoint.updated` records the rebased head).
- A newly approved recipe stops and restarts running services (keeping ports) and drops removed ones.
- Only each lane's latest recipe asks for approval; an earlier, replaced one leaves the Inbox.
- Merged lanes with running services stay on Run so they can be stopped.
- `tmux attach` uses `=name`, so it cannot open another lane's shell.
- `GET /api/setup/settings` masks tokens and keys; saving the mask keeps the stored value.
- A base branch git would read as an option (`--force`, `a..b`) is refused.
- The lane limit and other refusals return a plain sentence instead of a generic error.
- CLI `lane start` uses the project's default branch and takes `--base`; the Work page shows the right `contextlanes term` command; Run approves a recipe in a project with no lanes; cleanup reports "could not be checked" instead of inventing one unpushed commit; unbuilt phase-3 pages redirect to Work.
- Docs no longer claim cleanup keeps ignored files or that nothing ever listens on 0.0.0.0.

Open (see Needs Kyle for the first two):

- Loopback trust and the preview cookie, above.
- Some request bodies use inline zod rather than `packages/protocol` (`preview_url`, `answers`, `LocalSetupRequest`); the diff route's `?file=` is not parsed with zod.
- A recipe approved with no lane asking for it writes the `approval` row but no event.
- `mode: "edits"` is accepted when starting a lane but the host starts in ask mode.
- Routes with no caller: `GET /api/projects/:p/recipe`, `GET /api/lanes/:p/:n/env`, `DELETE /api/push/subscriptions`, `POST /api/setup/tailnet`.
- The Review and Run pages have no unit tests; they are covered by `scripts/check-phase2.mjs`.

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

Completed: closing the tab, switching views or stopping the daemon releases only that PTY's `tmux attach-session` client. The tmux session is never killed by the terminal route. Older history stays in tmux copy mode (**Ctrl+B**, then **[**); use **q** to leave it. Cleanup (phase 2) is the only place a lane's tmux session is killed.

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

Completed against `docs/DESIGN.md`, then rebuilt from the boards in `docs/mockups/` (see "UI rebuilt to the mockups"). Overview groups lanes by goal and draws owner gates using React Flow with ELK layout. Its two-hour timeline distinguishes recorded working, idle, waiting and failed periods, including the preceding state/turn. Selection is retained in `?lane=project/NN`, including notification links.

One-lane view renders all six families, joins text chunks, folds thinking by default and retains failed-then-fixed tool history. Counts come from ACP old/new content via `diff`; individual test pips come from TAP/check events. Unknown results are not estimated. Diffs exceeding the 100ms comparison budget omit counts; full checkpoint diffs are phase 2. Tool output is capped at 12,000 characters with an explicit marker.

Enter queues; Cmd/Ctrl+Enter interrupts the current turn and sends now; Shift+Enter adds a line; Escape interrupts in Steps and remains a terminal key in Terminal. Queued messages stay visible until their own turn starts. Model/mode changes wait for agent confirmation. The inspector shows plan, reported context use and checkout details. History paginates beyond 500 events and catches up after reconnect; Inbox cards and badge share one stream. Terminal and overview code load only when opened.

Validation: 61 tests pass with real fixture services enabled. Chromium at 1440px/390px verified graph, all step families, collapsed thinking, diff bars, test pips, queue shortcuts, interrupt, model/mode changes, inline permission and terminal switching, with no page errors or horizontal overflow.

**1.5 Setup and install — headless follow-up**

Goal: a new user over SSH reaches a running lane without typing a path or setup code, in under five minutes.

- `contextlanes setup` checks linger and prints the exact sudo command only when needed; claims for the shell user; uses Tailscale Serve automatically when signed in; prints a single-use, ten-minute sign-in URL and the same URL as a terminal QR code. With no Tailscale it prints one install-link line and the exact SSH tunnel fallback.
- Browser steps are **Sign in → Connect an agent → Add projects → Start your first lane**, each marked Done, Now or Next; the current step is the first one not done. Agent requires at least one Ready agent; Project requires an added repository; a working lane completes the last step.
- Agents have one status: **Ready**, **Install**, **Sign in**. Installed CLIs appear first, the rest under **Other agents**. Install uses fixed pinned packages under `~/.local`; Sign in opens only that agent’s fixed login command in the owner’s browser terminal. Login completion refreshes readiness. Known failures give an actionable sentence; raw process/network exceptions are not rendered.
- Project discovery reads agent session history, then walks home (see "UI rebuilt to the mockups" for the current rules). Repositories show name, path and current branch; none are selected initially. The folder browser resolves canonical paths and refuses links/paths outside home. Explicit owner-entered paths and `contextlanes add [path]` accept `~`; CLI add defaults to the current folder. Discovery, browsing and branch APIs are owner-only.
- First lane reads local branches from Git, prefers `origin/HEAD` as default (then main/master/first local branch), offers only Ready agents, and supplies an example task placeholder. Notifications and local endpoints live in Settings and Models, with Web Push first and ntfy/Telegram under **Other ways**. The public URL comes from Serve. Local helper execution remains phase 3.
- A passkey is offered only after owner sign-in at the configured HTTPS tailnet address, labelled **Add a passkey for this address**. It never blocks onboarding.

Implementation: a mode-0600 local control credential is read automatically by the CLI, never typed or printed. `/api/setup/local` additionally requires a local peer/Host and refuses Origin/Tailscale headers, so a browser or remote caller cannot claim by merely posting to a public endpoint. The local credential remains private; only sign-in-link hashes, origin and expiry are persisted. Consumption uses one atomic SQLite delete; reuse, expiry or another origin fails. URL secrets live in the fragment and are removed on landing. HttpOnly/SameSite Strict sessions are Secure over HTTPS. Auth expiry never answers an agent permission. Existing typed-code endpoints and the initial passkey claim were removed.

Serve preserves other routes, reuses this app’s existing route, and otherwise checks 443, 8443 and 4601–4603 without binding the daemon anywhere except 127.0.0.1. It saves `[access].owner` and `[notifications].publicUrl`. Ports marked public by an existing Funnel configuration are not reused or enabled. Shell ownership is persisted independently for SSH-tunnel use. As before, `access.allowLocal` permits local CLI calls after ownership is established; disabling it requires an owner session or tailnet identity for application APIs.

The source installer still checks prerequisites, refuses existing install destinations/unrelated unit or bin files, builds esbuild separately, tolerates an unavailable native terminal build and writes the user service. Built web assets are served directly by the daemon. `qrcode-terminal@0.12.0` (no runtime dependencies, types pinned to 0.12.2) was added because Node and the repo have no QR encoder. WebAuthn continues to use `@simplewebauthn/server@14.0.3`. CLI install versions are pinned in `apps/daemon/src/setup.ts`.

Validation: **86 tests pass** with real systemd/tmux fixtures enabled. API tests cover shell proof, link origin/expiry/concurrent replay, owner and browser-origin guards, fixed login commands, native failure containment, config persistence, home traversal, depth/count limits and default branch selection. The real terminal fixture now starts a clean bash so user prompt hooks cannot erase captured proof; all persistence assertions remain.

`scripts/check-setup.mjs` starts fresh configurations at **1440px and 390px**. It runs the actual CLI, follows its URL (including when Setup was already open), signs in through a fixed fake browser login terminal, selects an initially unchecked repository, checks a non-main default branch, starts a real systemd host with the SDK fake agent, and explicitly answers its permission. Both reached a running lane in **about 2.6 seconds from CLI invocation** on this machine. It then verifies post-lane cards, automatic public URL, real WebAuthn registration at the fixture HTTPS address and link replay rejection. Tailscale is faked exclusively through the injected Runner; fixture HTTPS binds 127.0.0.1. This is not a timing claim for real downloads/provider sign-in.

```sh
curl -fsSL https://raw.githubusercontent.com/wongywrongy/contextlane/main/install.sh | sh
~/.local/bin/contextlanes setup
# Open the link or scan the QR; then Agent → Project → First lane.
~/.local/bin/contextlanes add          # optional: add the current repository
~/.local/bin/contextlanes add ~/code/project
CONTEXTLANES_REAL_HOSTS=1 CONTEXTLANES_REAL_TERMINAL=1 pnpm check
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs CHROMIUM_BIN=/absolute/path/to/chrome node scripts/check-setup.mjs
```

Generated installer units are also validated by the real `systemd-analyze --user verify` gate, including an install path with spaces and specifier characters. `WorkingDirectory` uses a literal path value (with percent specifiers escaped), not ExecStart-style quotes. After rebuilding an existing source checkout, restart its daemon before using the new CLI. Setup detects an older status response and prints a specific restart instruction instead of a generic failure. External acceptance remains in Needs Kyle.

## Phase 2 — Apps and review

Gate: review a checkpoint in under five minutes. Implemented; the timing itself has not been measured with a person (see Needs Kyle).

**Recipes.** `.contextlanes.json` in the repository, validated strictly, so a typo cannot silently drop a health check:

```json
{
  "cache": ["node_modules"],
  "setup": [{ "name": "Migrate", "command": ["pnpm", "migrate"] }],
  "services": [
    { "name": "api", "command": ["pnpm", "api", "--port", "$PORT"], "health": { "path": "/status" } },
    { "name": "web", "command": ["pnpm", "dev", "--port", "$PORT", "--host", "$HOST"], "env": { "API_PORT": "$PORT_API" } }
  ],
  "checks": [{ "name": "Tests", "command": ["pnpm", "test"] }],
  "screenshots": ["/"]
}
```

Commands are argument arrays. `$PORT`, `$PORT_<SERVICE>` and `$HOST` are filled in inside arguments and set in the environment; `service.port.env` names another variable for the port. The hash covers the file's exact bytes, so any edit needs approval again, and agents can edit the copy in their lane. Only bytes present right now, in the project or an open lane, can be approved, and only if they parse. Refused starts create one `recipe.requested` event, which shows in the Inbox.

**Who can decide.** Recipe approval, approve and merge, request changes and cleanup need `ownerSession`: a signed-in cookie, or the owner's Tailscale identity on a non-loopback host. The general `authorized()` check is not enough, because it accepts any local request and agents run on this machine. Limit: agents run as the same Unix user, so an agent deliberately forging headers or reading the data folder is not stopped by this; that takes a separate user or sandbox. No tool or token path gives an agent approval.

**Lane setup and runtime** (`apps/daemon/src/runtime.ts`). Ignored `.env*` files are copied (symlinks skipped, existing files kept), `cache` folders are hard-linked with `cp -al`, falling back to a copy across filesystems, then setup steps run once per recipe hash. Hard links share files with the main checkout, so a tool that edits a dependency in place changes both. Each service is a `systemd-run --user` unit with a new random name, `Restart=on-failure` and journald logs. Units outlive the daemon; the `environment` row is how a restarted daemon finds them. The health loop reads the unit, its listeners and an HTTP probe every 5 seconds and writes `env.status` only when something changes. A service listening beyond loopback is stopped and stays stopped, with the reason shown. Per-lane databases were left out of this round, so the board's Database column is not shown.

**Previews** (`apps/daemon/src/previews.ts`). `[previews] mode` is `serve` (default), `services` or `caddy`. Serve gives each service its own HTTPS port on the device from `[previews.ports]` (4700–4799), which is a separate origin, so single-page apps and hot reload work. Named Tailscale Services need a tagged host and an admin definition per name, and neo has no tag. Only our own routes are added or removed; `serve reset` is never used. A failed link never stops the app: it shows on the Run page and retries each minute.

**Checker** (`apps/daemon/src/checker.ts`). `checkpoint` refuses a lane that is not working, uncommitted work, an empty branch or an unapproved recipe, then runs in the background: recipe checks, `git diff --numstat`, plan comparison, screenshots, a `checkpoint` row, `lane.state`. Failed checks are stored, not hidden. New commits during the run cancel it. "After" comes from the lane's running app, "before" from a temporary checkout of the base commit run with the same recipe; a failed picture leaves a note and does not block review. The process signal is computed from events only. Plan comparison is word overlap between file paths and plan text, so it can over-flag until the local model arrives in phase 3.

**Review and merge** (`apps/daemon/src/review.ts`). Approve refuses commits the checkpoint did not cover and uncommitted work, then fetches, rebases, pushes the lane branch without force and opens a PR. A branch already on the remote is merged with the base instead of rebased, so a force-push is never needed. Conflicts abort and leave the lane as it was. If `gh` fails after the push, approving again finishes the job. The lane state `merged` means the PR is open; merging it on GitHub stays with the owner. Failed checks do not block approval, but the page says so next to the button. Request changes sends the note to the same agent as a queued message.

**Cleanup.** Merged lanes only. It refuses unpushed commits and uncommitted files before touching anything, then stops the services and lane host, runs `git worktree remove` without force, and kills the tmux session. Branches stay. tmux targets use `=name`, because a plain name also matches `cl-shop-01-2`.

Validation: `pnpm check` with both real fixture flags. `scripts/check-phase2.mjs` runs real systemd units, real git against a throwaway bare remote and Chromium at 1440px and 390px: recipe approval, environment, logs, checkpoint from the inspector, review from Needs you and Inbox, request changes, second checkpoint, approve and merge, cleanup. `main` on the fixture remote does not move. Fixtures fake `gh` and previews, so they can never reach a real repository or add a tailnet route.

```sh
CONTEXTLANES_REAL_HOSTS=1 CONTEXTLANES_REAL_TERMINAL=1 pnpm check
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs CHROMIUM_BIN=/absolute/path/to/chrome node scripts/check-phase2.mjs
```

Left out because the data or feature does not exist yet: Adopt into a lane and the watched list, Ask Codex to review, Shares a file with 02 (phase 3), changed-area highlights on screenshots, test counts such as 44 / 44, certificate days. Approval items in the Inbox open the lane, not the Run page.

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
- **Updates:** `apps/daemon/test/update.test.ts` uses real git (a bare remote and the clone install.sh makes) with npm, systemctl and the health check faked. The full path, with real builds, a real daemon restart and a lane waiting through it, was run by hand on 2026-10-30 (see Updating); repeat it before changing the release layout.
- **Terminal end to end:** `CONTEXTLANES_REAL_TERMINAL=1 pnpm exec vitest run apps/daemon/test/terminal.real.test.ts` opts into real tmux, PTYs, a throwaway git repo and loopback HTTP. The ordinary suite fakes all commands through `Runner`, including its terminal launcher. The opt-in test checks shell state, history beyond the screen, prompt client cleanup, daemon recreation and the actual CLI entry point.

## Open questions

- **Resolved from adapter code:** both current registry adapters support `session/resume` and `session/load`. Claude advertises `resume: {}` in [`acp-agent.ts`](https://github.com/agentclientprotocol/claude-agent-acp/blob/2fd46c866d4ff2939fe1b1245b15a536d6de7c0b/src/acp-agent.ts); Codex does so in [`CodexAcpServer.ts`](https://github.com/agentclientprotocol/codex-acp/blob/ac8d9251de43ab8648a89eb0520e0c606ad78be5/src/CodexAcpServer.ts). ContextLanes keeps the existing process/session alive across daemon restarts because resume cannot preserve an outstanding in-process permission handler. Agent connection failures are recorded; tasks are not silently rerun. Investigate forcibly killed hosts through their systemd journal.
- **Resolved from Claude adapter code, not a login test:** it advertises Claude subscription terminal authentication, and detects SSH/`NO_BROWSER` to select the interactive `--cli` TUI login flow. It is not an unattended ACP login. Kyle still needs to authenticate and verify his subscription on this machine. `--hide-claude-auth` can intentionally disable subscriptions; ContextLanes does not set it. Source: [`acp-agent.ts`](https://github.com/agentclientprotocol/claude-agent-acp/blob/2fd46c866d4ff2939fe1b1245b15a536d6de7c0b/src/acp-agent.ts).
- **Safety finding:** Codex's current default `agent` mode delegates approvals to auto review. ContextLanes forces `INITIAL_AGENT_MODE=read-only`, selects a human-approval mode before prompting, and excludes `agent` and full-access modes. Source: [`AgentMode.ts`](https://github.com/agentclientprotocol/codex-acp/blob/ac8d9251de43ab8648a89eb0520e0c606ad78be5/src/AgentMode.ts).
- **Resolved from current Tailscale docs:** named [Tailscale Services](https://tailscale.com/docs/features/tailscale-services) can give separate `name.<tailnet>.ts.net` addresses through `serve --service=svc:name`; they require a tagged host plus admin service definition/host approval. The phase-1 wizard uses the user-owned device address and an unused HTTPS port. Phase 2 may use Services as a named fallback; custom wildcard domains still need the planned DNS/certificate integration. This was documentation research, not a change to Kyle’s tailnet.
- **OpenCode login detection limit:** its [CLI docs](https://opencode.ai/docs/cli/#list-1) document `auth list` as a provider list, without a stable JSON login-status API. The wizard accepts a recognized positive credential count in its human-readable output; otherwise it shows Sign in. It never treats command success alone as a login. Local-model and environment-provided credentials can also work without an interactive provider login.
- How long does CodeGraph take to index the largest repo, and how big is the index?
- Per-lane databases: Postgres template databases or copied SQLite files, chosen per project in the recipe? Not built in phase 2.
- Which delegate kinds clear the redo-rate bar on the local GPU, and how many local jobs can run before lanes wait?
- `node:sqlite` still emits an experimental warning on the tested Node 24.11.0. The Store tests and full local check pass, so it remains behind the existing `Store` API; long-running production durability is not established by this milestone.
- Licence for the open-source release.
