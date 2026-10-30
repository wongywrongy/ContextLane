# ContextLanes — implementation plan

## Needs Kyle

- **Board for Scheduled lanes:** they live in Settings with existing classes because no board shows them. Design one if they should look different.
- **The phase 3 gate (30% fewer cloud tokens):** with a local model serving, write 3 to 5 tasks typical of your week for one of your repositories into a `tasks.json` and run `contextlanes bench tasks.json`, answering the lanes' questions as they come. Paste the table it prints under 3.9. Each task runs twice, so it costs about twice its usual tokens.
- **Local models (phase 3):** add Ollama (or llama.cpp) under Models → Local models, pull the model you want (`ollama pull <name>`), and check it shows Serving after a brief or Insights run. Nothing in phase 3 has run against a real model yet; the code is tested against a fake OpenAI-compatible server. On neo's 24 GB card a 30B coder model fits only quantized (Q4).
- **3.0 real usage acceptance:** run a real Claude lane with your signed-in account and compare its `/api/usage?project=<id>` totals with Claude Code's own usage report. The fake ACP agent, Claude/Codex JSONL fixtures and desktop/phone browser checks cover implementation; no paid model turn was started for this milestone.
- **Terminals on neo:** the native terminal module is gone (see T). Open a lane terminal and an agent login terminal once on neo to confirm; the real tmux test passes in the build container with Python 3.13.
- **Agents can still reach you through files in your home folder.** See Credentials and sandbox for exactly what remains. If you want this closed, the next step is running lanes as a separate Unix user.
- **bubblewrap on other machines:** lanes refuse to start without a working `bwrap`. neo has it. `install.sh` now requires it, and a fresh machine needs `sudo apt install bubblewrap`. Ubuntu 24.04 needs its AppArmor profile for `bwrap`, which neo has at `/etc/apparmor.d/bwrap`; other distributions have not been tried.
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

Phases 1 and 2 are implemented. On 2026-10-30 the web app was rebuilt from the mockups (see below) and phase 2 landed on top. External credentials, a real merge and device acceptance remain in Needs Kyle. What is left is planned milestone by milestone under Remaining work.

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
| Audit of phases 1–2 | Fixes in; security item closed | See Audit, and Credentials and sandbox |

## Current capabilities

Everything below builds, typechecks and has tests (`pnpm check`). A lane can already be started end to end: project registered, branch and worktree created, tmux session opened, events recorded and streamed.

| Package | What works now | What is stubbed |
|---|---|---|
| `packages/protocol` | Lane ids and colours, the lane lifecycle with allowed moves, all event types with validated payloads, HTTP request and response types | — |
| `apps/daemon` | Config, SQLite event log and migrations, inbox, lane manager, systemd host launch (on by default), durable commands, event acknowledgements, HTTP controls and live stream, credential checks, lane sandbox, detachable terminal clients, recipes, runtime, previews, checker, review and cleanup | `get_brief` and `delegate` return 501 until phase 3 |
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

What the boards show but the app does not yet is planned milestone by milestone under Remaining work. Fonts still load from Google Fonts.

## Updating (2026-10-30)

`contextlanes update` (`apps/daemon/src/update.ts`, run through `update-main.js` so the CLI stays light):

1. Refuses if tracked files in the running copy were edited, and names them. One update runs at a time (`update.lock`).
2. Fetches every branch and lists what is new. It follows the repository's default branch (`main`), or the branch chosen with `--branch` or `CONTEXTLANES_BRANCH` at install time, which is saved in `update.json`; if a chosen branch is gone it goes back to the default. The branch a copy was first cloned from does not count, so installs made from the old `contextlanes` branch move to `main`. A remote still pointing at `wongywrongy/rootlane` is switched to `wongywrongy/contextlane`.
3. Builds the new commit in `releases/<commit>`, a git worktree of the original clone (`app/`), with the same steps as the installer. A failed build changes nothing. A finished build is marked with `.contextlanes-built` and reused on a retry.
4. Copies the database with `VACUUM INTO` (newest five kept in `<data>/backups`) and records its format version.
5. The first time, points the service file and the `contextlanes` commands at `current` instead of the clone. It replaces only files that carry the installer's marker line.
6. Points `previous` at the running release and `current` at the new one, restarts the daemon and waits up to 30 seconds for `/api/health` to report the new commit. Otherwise it stops the daemon, restores the database if the new version changed its format, switches back and starts the old one.
7. Prunes releases, keeping current, previous, the newest three and any a running process still uses. Lane hosts started before the update keep running from their own release folder.

`--check` stops after step 2. `--rollback` goes back to `previous`; when the newer version changed the database format it asks for `--yes`, because the restore drops history recorded since the update. `install.sh` on an installed machine builds the newest commit beside it and runs the same switch (`update-main.js --adopt`), which is how installs from before this command get it. A plain source checkout is not managed and is told to use git. The daemon reports the commit it was built from as its version.

Verified here end to end with real builds, a real daemon restart (systemctl faked by a script that runs the unit file) and a lane waiting on a permission: old install (5e00f6b, single-folder layout) → `install.sh` update to a88b8d2 in 32 s with the lane host still running from the old folder, reconnecting and finishing after the answer → `--check` → update to a new commit → `--rollback` → update again → fresh install with the new layout. Unit tests cover the failure paths (build failure, unhealthy start with database restore, edited files, lock, gone branch, renamed repository, pruning).

## Credentials and sandbox (2026-10-30)

Every request reaches the daemon from 127.0.0.1, because Tailscale Serve proxies to loopback, and a local process can send the same headers Serve sends. So only these decide who a request is from (`apps/daemon/src/http/auth.ts`, the `onRequest` hook in `server.ts`):

| Who | Credential | Accepted on |
|---|---|---|
| Browser | Session token in localStorage, sent as `Authorization: Bearer` | Everything |
| Browser stream or terminal | Ticket from `POST /api/tickets`: one path, one use, 30 seconds, kept in memory | That GET |
| CLI | `<data>/setup-token` as a bearer token, on every request | Everything |
| Lane host and toolbox | Random per-lane token, minted when the lane starts; only its hash is stored | That lane's toolbox routes and lane socket connection; stops when the lane is cleaned or archived |
| Notification buttons | `cl-action-` tokens, unchanged | One recorded answer |

`access.allowLocal` is gone. A Tailscale login that is not the owner is still refused, but the owner's login signs nobody in. The check uses the route the router matched, not `req.url`: the old check read the raw path, so `/%61pi/inbox` skipped it entirely. Migration 8 deletes every old cookie session, because those cookies had been sent to preview ports. A browser that still has the cookie is told why it was signed out, once, and the cookie is cleared. Sign-in links and passkeys now return the session token.

The token reaches the lane host through systemd's inherited environment (`--setenv=NAME`), not arguments, which every process on the machine can read. A lane host from before this change cannot prove itself: its lane is marked failed and says to start a new lane.

**Sandbox: bubblewrap, not `InaccessiblePaths=`.** The plan was `InaccessiblePaths=` on lane units. Checked on neo (systemd 255, Ubuntu 24.04):

- **`InaccessiblePaths=` has no effect in user units.** A unit with it set read the secret anyway and exited 0, with no warning. So does `ProtectHome=` and `ProtectSystem=`. `kernel.apparmor_restrict_unprivileged_userns=1` moves systemd's user namespace into the `unprivileged_userns` AppArmor profile, which denies `sys_admin` (seen in the kernel log), and systemd then silently drops the mounts. `TemporaryFileSystem=` and `BindReadOnlyPaths=` fail the unit with 226/NAMESPACE instead.
- **It would also have been wrong here.** `~/.local/share/contextlanes` holds the releases as well as the data, so hiding that folder hides the lane host's own code. systemd also drops mounts nested under an inaccessible path, so the release cannot be put back.
- **Hiding single files is not safe either.** Replacing a file detaches a mount placed over it.

So `apps/daemon/src/sandbox.ts` prefixes every lane command with `bwrap`, which works without root on neo through the shipped AppArmor profile. That covers lane hosts (and the agents and toolboxes they start), services, setup steps, checks and the "before" services for screenshots. It hides `<data>` (putting `releases/` and `app/` back read-only), the folder holding `config.toml`, all of `/run` (the systemd user bus, Docker and Tailscale sockets; only the DNS folder comes back) and the tmux socket folder. `lanes.sock` moved to `$XDG_RUNTIME_DIR/contextlanes-<hash>/` and only lane hosts get that folder. The "before" checkout moved to `<lanes>/.before`, since services could no longer see it in the data folder. `checkSandbox` proves the sandbox hides `setup-token` before each lane starts, and a machine where it does not work refuses the lane with a plain sentence. Lanes lose Docker, the systemd user bus and `$XDG_RUNTIME_DIR`, so a recipe that needs Docker will fail.

**What an agent running as Kyle's Unix user can still do.** Measured from inside the sandbox on neo. It stops direct owner access, not everything:

- **Write anything in your home folder**, because lanes need your agent logins and tools. That includes `~/.bashrc`, `~/.gitconfig`, `~/.config/systemd/user` and `~/.ssh/authorized_keys`. Each of these turns into running as you later, outside the sandbox: your next shell, the next reboot, or at once for `authorized_keys`, since sshd is listening on neo and an agent can then `ssh localhost`.
- **Change what the daemon's git runs.** The daemon runs git outside the sandbox in lane checkouts, for checks, review and merge. `~/.gitconfig`, and a repository's `.git/config` and `.git/hooks`, can make those commands run agent code as you. This is the shortest route, and needs no action from you.
- **Read your agent logins** in `~/.claude`, `~/.codex` and the like, and anything else in your home folder.
- **Reach the network and the daemon's port.** The daemon answers 401 without a token. A lane process can also take port 4600 while the daemon is restarting, and a page served from there would be on the app's origin; this has not been tried.
- **Use its own lane's token**, which any process in that lane's host unit can find. It works only on that lane's toolbox routes.

Reading other lanes' process environments, expected to be a limit, is blocked: each lane has its own user namespace, and a read of another lane's `/proc/<pid>/environ` failed on neo. So is the daemon's. `sudo`, the systemd user bus, Docker, Tailscale and tmux were all refused from inside.

**Validation.** `pnpm check`. `CONTEXTLANES_REAL_HOSTS=1 CONTEXTLANES_REAL_SANDBOX=1 CONTEXTLANES_REAL_BROWSER=1 pnpm test` passes on neo with two real lane hosts in the sandbox across a daemon restart, a real checkpoint with screenshots, and a preview page in Chromium that reads no token and whose request arrives with no credential. `scripts/check-setup.mjs` and `scripts/check-phase2.mjs` pass, and check-setup now fails on any unexpected 401. Not checked: the browser terminal against a real PTY, because `node-pty` crashes on neo (see Needs Kyle). The ticket path is covered with a fake PTY and through the fixture login terminal.

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

Open:

- Some request bodies use inline zod rather than `packages/protocol` (`preview_url`, `answers`, `LocalSetupRequest`); the diff route's `?file=` is not parsed with zod.
- A recipe approved with no lane asking for it writes the `approval` row but no event.
- `mode: "edits"` is accepted when starting a lane but the host starts in ask mode.
- Routes with no caller: `GET /api/projects/:p/recipe`, `GET /api/lanes/:p/:n/env`, `DELETE /api/push/subscriptions`, `POST /api/setup/tailnet`.
- The Review and Run pages have no unit tests; they are covered by `scripts/check-phase2.mjs`.

## Principles

1. **Borrow, don't build.** ACP for agents, tmux for shells, systemd for processes, Caddy and Tailscale for access, CodeGraph for code, Playwright for screenshots. New code only where nothing fits.
2. **Everything is an event.** The store appends; screens, the CLI and insights read. No second source of truth.
3. **Agents live outside the daemon.** One lane host per lane as its own systemd unit.
4. **One owner.** Bind to loopback; shell access proves ownership. Only a credential says who a request is from: loopback addresses and headers prove nothing. Passkeys are optional after sign-in.
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

Implementation: a mode-0600 local control credential is read automatically by the CLI, never typed or printed. `/api/setup/local` additionally requires a local peer/Host and refuses Origin/Tailscale headers, so a browser or remote caller cannot claim by merely posting to a public endpoint. The local credential remains private; only sign-in-link hashes, origin and expiry are persisted. Consumption uses one atomic SQLite delete; reuse, expiry or another origin fails. URL secrets live in the fragment and are removed on landing. Sessions are bearer tokens kept in localStorage. Auth expiry never answers an agent permission. Existing typed-code endpoints and the initial passkey claim were removed.

Serve preserves other routes, reuses this app’s existing route, and otherwise checks 443, 8443 and 4601–4603 without binding the daemon anywhere except 127.0.0.1. It saves `[access].owner` and `[notifications].publicUrl`. Ports marked public by an existing Funnel configuration are not reused or enabled. Shell ownership is persisted independently for SSH-tunnel use. The CLI proves itself on every request with `<data>/setup-token`.

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

**Who can decide.** Recipe approval, approve and merge, request changes and cleanup need an owner credential, like every other route except the toolbox (see Credentials and sandbox). A lane token is refused on all of them. No tool or token path gives an agent approval.

**Lane setup and runtime** (`apps/daemon/src/runtime.ts`). Ignored `.env*` files are copied (symlinks skipped, existing files kept), `cache` folders are hard-linked with `cp -al`, falling back to a copy across filesystems, then setup steps run once per recipe hash. Hard links share files with the main checkout, so a tool that edits a dependency in place changes both. Each service is a `systemd-run --user` unit with a new random name, `Restart=on-failure` and journald logs. Units outlive the daemon; the `environment` row is how a restarted daemon finds them. The health loop reads the unit, its listeners and an HTTP probe every 5 seconds and writes `env.status` only when something changes. A service listening beyond loopback is stopped and stays stopped, with the reason shown. Per-lane databases were left out of this round, so the board's Database column is not shown.

**Previews** (`apps/daemon/src/previews.ts`). `[previews] mode` is `serve` (default), `services` or `caddy`. Serve gives each service its own HTTPS port on the device from `[previews.ports]` (4700–4799), which is a separate origin, so single-page apps and hot reload work. Named Tailscale Services need a tagged host and an admin definition per name, and neo has no tag. Only our own routes are added or removed; `serve reset` is never used. A failed link never stops the app: it shows on the Run page and retries each minute.

**Checker** (`apps/daemon/src/checker.ts`). `checkpoint` refuses a lane that is not working, uncommitted work, an empty branch or an unapproved recipe, then runs in the background: recipe checks, `git diff --numstat`, plan comparison, screenshots, a `checkpoint` row, `lane.state`. Failed checks are stored, not hidden. New commits during the run cancel it. "After" comes from the lane's running app, "before" from a temporary checkout of the base commit run with the same recipe; a failed picture leaves a note and does not block review. The process signal is computed from events only. Plan comparison is word overlap between file paths and plan text, so it can over-flag until the local model arrives in phase 3.

**Review and merge** (`apps/daemon/src/review.ts`). Approve refuses commits the checkpoint did not cover and uncommitted work, then fetches, rebases, pushes the lane branch without force and opens a PR. A branch already on the remote is merged with the base instead of rebased, so a force-push is never needed. Conflicts abort and leave the lane as it was. If `gh` fails after the push, approving again finishes the job. The lane state `merged` means the PR is open; merging it on GitHub stays with the owner. Failed checks do not block approval, but the page says so next to the button. Request changes sends the note to the same agent as a queued message.

**Cleanup.** Merged lanes only. It refuses unpushed commits and uncommitted files before touching anything, then stops the services and lane host, runs `git worktree remove` without force, and kills the tmux session. Branches stay. tmux targets use `=name`, because a plain name also matches `cl-shop-01-2`.

Validation: `pnpm check` with both real fixture flags. `scripts/check-phase2.mjs` runs real systemd units, real git against a throwaway bare remote and Chromium at 1440px and 390px: recipe approval, environment, logs, checkpoint from the inspector, review from Needs you and Inbox, request changes, second checkpoint, approve and merge, cleanup. `main` on the fixture remote does not move. Fixtures fake `gh` and previews, so they can never reach a real repository or add a tailnet route.

```sh
CONTEXTLANES_REAL_HOSTS=1 CONTEXTLANES_REAL_SANDBOX=1 CONTEXTLANES_REAL_BROWSER=1 CONTEXTLANES_REAL_TERMINAL=1 pnpm check
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs CHROMIUM_BIN=/absolute/path/to/chrome node scripts/check-phase2.mjs
```

Left out because the data or feature does not exist yet: Adopt into a lane and the watched list, Ask Codex to review, Shares a file with 02 (phase 3), changed-area highlights on screenshots, test counts such as 44 / 44, certificate days. Approval items in the Inbox open the lane, not the Run page.

## Remaining work: finish the boards, phase 3, phase 4

Everything not yet built from the boards and the brief, split into milestones small enough for one agent run each. Work in the order of the table.

### How to work through this

- Take the first milestone whose status is **Next**. Build it, run `pnpm check`, commit and push to main. Then set its row to **Done** with evidence (tests, what you checked by hand, what needs Kyle) and set the following row to **Next**. If `git push` is rejected, run `git pull --rebase` and push again; never force-push.
- Build only what the milestone lists. **Not here** lines are hard limits. If you need something the milestone does not list, add it to Open questions and stop there rather than inventing it.
- The board named in the milestone is the spec for its UI (`docs/mockups/`). Where no board exists, use a section in an existing page with existing classes, and add a line to Needs Kyle asking for a board.
- Show only real data. If a number has no real source, leave it off the page and say so in the milestone row. Never fill a board's example numbers.
- Change `packages/protocol` first; every state change is an event; commands go through `Runner`; tests sit next to the package.
- Local models: never hard-code a model name. Read `localModels` from config. Tests use a fake Ollama/OpenAI-compatible HTTP server.
- Work that needs Kyle's accounts, GPU time or money is built against fakes, and the real check is added to Needs Kyle.
- A **Decided** line records a choice already made. Follow it; do not reopen it.

| Milestone | Board | Status |
|---|---|---|
| S. Credentials and lane sandbox (security) | — | Done: see Credentials and sandbox |
| 3.0 Usage and cost | work-lane, models | Done — 5047be0; `pnpm check`: 183 passed, 8 opt-in checks skipped; fake ACP + JSONL + API totals; Chromium at 1440px/390px; real account comparison in Needs Kyle; see Usage implementation and adapter evidence |
| B1 This machine and Data | settings | Done — 3296c7d; `pnpm check`: 187 passed, 8 opt-in checks skipped; real SQLite retention/redaction tests; Settings Chromium 1440px/390px; see Machine and data implementation evidence |
| B2 Run and Projects facts | run, projects | Done — ed0168c; `pnpm check`: 194 passed, 8 opt-in checks skipped; ownership/cache/TLS/adoption tests; Run and Projects Chromium 1440px/390px; see Run and Projects facts implementation evidence |
| T. Terminals survive a node-pty crash | work-lane | Done: PTY host process on the standard POSIX pty, node-pty removed; see T |
| S2. Daemon git runs in the sandbox | — | Done: every daemon git and gh runs in the lane sandbox with hooks and fsmonitor off; see S2 |
| B3 Per-lane databases | run | Done: Postgres template copies and SQLite copies; real Postgres 16 test passes; see B3 |
| B4 Review packet gaps | review | Done: test counts from tool output, changed areas on screenshots; see B4 |
| B5 Composer, editor link, watching only | work-lane | Done: @ file, / command, pictures, Open in editor, Watching only and Take over; see B5 |
| B6 Add from GitHub, branch in the band | projects | Done: see B6 |
| 3.1 Code map | architecture | Done: CodeGraph 1.6.2 in a sandboxed worker; see 3.1 |
| 3.2 Architecture page and `contextlanes arch` | architecture | Done: see 3.2 |
| 3.3 Collision warnings | architecture, review | Done: see 3.3 |
| 3.4 Local model runtime | models | Done with a fake server; real models need Kyle; see 3.4 |
| 3.5 Module briefs, `get_brief`, project notes | architecture, insights | Done: see 3.5 |
| 3.6 Local helper (`delegate`) | models, work-lane | Done with a fake model; see 3.6 (decision changed) |
| 3.7 Insights | insights | Done with a fake model; see 3.7 |
| 3.8 ⌘K Ask | top bar | Done with a fake model; see 3.8 |
| 3.9 Measure the phase 3 gate | — | Built; the real run is Kyle's; see 3.9 |
| 4.1 Hand off, fork, fresh session | work-lane | Done; see 4.1 |
| 4.2 Second-agent review | review | Done; see 4.2 |
| 4.3 More agents | models | Done; Hermes is not in the registry; see 4.3 |
| 4.4 Routing | models | Done; see 4.4 |
| 4.5 Scheduled lanes | — (needs a board) | Done; see 4.5 |
| 4.6 Shared skills | insights | Next |
| 4.7 Final board pass | all | Not started |

### 3.0 Usage and cost

Comes first so real token numbers pile up before the phase 3 tools exist; 3.9 compares against them.

- Record tokens per turn per lane: input, output, cache read, cache write, and cost when given. Source, in this order:
  1. ACP: the prompt response's usage and `usage_update` cost, when the adapter sends them.
  2. The agent's own session log, matched by worktree path and session id: Claude Code `~/.claude/projects/<cwd slug>/<session>.jsonl` (`message.usage`), Codex `~/.codex/sessions/**/rollout-*.jsonl` (`token_count`).
  Record which source was used on each event.
- Add the event in protocol (extend `usage` or add `usage.turn`). `GET /api/usage?project=&since=` sums per lane and per day.
- Work inspector Context block (work-lane): percent used, used of size. Show the compaction count only if the adapter reports compactions; check both adapters' source and write down what you found.
- Models, agent row (models): show "5h · 7d" limits only if the agent reports them; otherwise "limits not reported", as the board does for Codex.
- **Done when:** a fake agent and fixture session logs give the right totals. Kyle checks a real Claude lane against Claude Code's own usage report.
- **Not here:** the per-category context breakdown (3.7), the Projects usage line (B2).

#### Usage implementation and adapter evidence (2026-10-30)

- `usage.turn` records one prompt's fresh input, output, cache reads/writes and reported USD cost, with session/turn IDs and source. The pinned ACP SDK's unstable entry point preserves prompt usage; its stable response schema drops that field. USD cost is the difference between reported session totals, never a price estimate. A missing token counter is `null`; cost-only reports keep unknown tokens. `costSource` identifies ACP costs even when tokens came from a log.
- Fallbacks read the exact session JSONL and verify both session ID and worktree path. Claude message IDs replace streaming duplicates. Codex uses cumulative totals, subtracts cached input from fresh input, and differences the pre/post-prompt snapshots. A counter reset is omitted rather than charged as new history. Logs over 64 MiB are omitted; no transcript contents enter events.
- `/api/usage?project=&since=` validates filters and returns lane/day totals, deduplicating turn IDs without the history endpoint's 500-event cap. Cache/token totals stay `null` if incomplete; `costUsd` sums only reported costs and `costTurns` says how many turns supplied one. Days use UTC event time.
- Both current adapters support completed compaction notifications: [Claude lifecycle](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/src/acp-agent.ts), [Codex handler](https://github.com/agentclientprotocol/codex-acp/blob/main/src/CodexEventHandler.ts). The client advertises compaction support and counts each completed session/compaction ID once. No notification means no count on Work.
- Claude forwards `_claude/rateLimit`; the optional `utilization` and `unifiedWindows` shapes are [reported upstream](https://github.com/anthropics/claude-code/issues/91857). Only validated 5h/7d percentages with future reset times appear on Models. Codex keeps account limits inside the adapter rather than forwarding them in usage updates; its row says "limits not reported". No account endpoint is queried. [Claude prompt counters](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/src/acp-agent.ts) and [Codex prompt counters](https://github.com/agentclientprotocol/codex-acp/blob/main/src/TokenCount.ts) are per prompt and keep fresh input separate from cache tokens.
- Verification: SDK fake-agent turns cover ACP precedence, per-turn cost, compaction deduplication, optional limits, log fallback and missing counters; generated Claude/Codex JSONL fixtures cover duplicate messages, path/session mismatches, malformed lines and counter resets. API tests cover project/date filters, UTC days, duplicate turns, expired limits and missing costs. Chromium against a temporary fake-agent daemon checked Work and Models at 1440px and 390px, including screenshots, no page errors and no horizontal scrolling. The real account comparison is in Needs Kyle.
- Transport regression: the daemon's explicit host-event allowlist now accepts all three new usage event types. A fake-agent integration test sends them through the authenticated Unix socket and checks the database and `/api/usage`, including limits and compactions.

### B1 This machine and Data (settings)

- This machine: host, OS, always on (linger), version (the commit), runs as (systemd user service and address). **Check for updates** runs the same check as `contextlanes update --check` (fetch only), lists the new commits and shows the command to install. Installing stays in the CLI.
- Data: **Backups** become nightly (systemd user timer running the same `VACUUM INTO` as the updater, keep 7) and the row shows the last run and its result. **Export** downloads everything as JSON with secrets masked (reuse `redactedSettings`).
- Access, Public internet: a read-only row that says it is off. No toggle.
- **Not here:** lane history retention and summaries (needs 3.4), installing updates from the browser.

#### Machine and data implementation evidence (2026-10-30)

- Settings reads OS, user, daemon PID, linger and the backup timer's last exit through OS facts and injected commands. Unavailable facts remain unknown. Public internet is read-only and off. Check for updates invokes the existing updater with `--check`; installation remains an SSH command.
- Installation and managed daemon startup provision an owned systemd user service/timer at 03:10 with `Persistent=true`. Source checkouts do not install a timer. Nightly backups use the updater's shared `VACUUM INTO` implementation, keep seven private copies under `<data>/backups/nightly`, and do not prune the updater's five rollback copies. Backup failure never deletes the source database.
- Authenticated JSON export contains all database tables and configuration, reuses `redactedSettings`, masks stored authentication hashes, lane tokens, push credentials, credential fields, configured secret values and agent/host/toolbox environments. Unknown credentials pasted into ordinary prose cannot be reliably identified; review exports before sharing them. The export is not an import format.
- `machine.test.ts` checks live WAL database copies, retention, private permissions, corrupt/missing input, timer ownership/idempotence, machine facts and unavailable services, CLI-only update checking, export redaction and preserved token counts. The updater regression suite also passes. Chromium verified Settings at 1440px and 390px: machine facts, update results, authenticated export download, no page errors and no horizontal scrolling. A real nightly timer firing has not been observed.

### B2 Run and Projects facts (run, projects)

- Run: **Disk** per lane (size of the worktree, cached, refreshed every few minutes). **Certificate** days left for the preview mode in use, read from a TLS handshake to the preview host.
- Run, **Not started by ContextLanes**: listening sockets (`ss -ltnpH` through Runner) whose process folder is inside a project or lane folder and that are not lane units. Show the name, port, pid, folder, and whether it listens on localhost only or on all addresses.
- **Adopt into a lane**, decided: never stop the outside process. Adopt opens New lane for that project and proposes the command and port as a recipe service through the usual recipe approval. The row then says to stop the outside copy once the lane's copy runs.
- Projects tiles: services up or down per project. Usage line: GPU use and memory from `nvidia-smi` through Runner, plus agent limits only where 3.0 found a source.

#### Run and Projects facts implementation evidence (2026-10-30)

- Run reads current worktree bytes with `du -sb` and verifies preview certificate expiry with TLS. Disk, certificate and GPU observations are cached for three minutes. A failed measurement stays unknown; certificate days are omitted unless every recorded preview link can be verified.
- Outside listeners come from `ss -ltnpH` plus `/proc` through Runner. Directory boundaries are checked, lane/service cgroups are excluded, and the row distinguishes localhost, wildcard and specific-address binds. Processes that exit or cannot be inspected are skipped.
- Adopt opens the existing New lane dialog with a concise task and a command/port/folder proposal. The daemon records `service.proposed` and includes the recipe instructions in the agent's first prompt. The agent still needs the existing recipe approval before services run. No outside process is stopped, and matching boot/PID/start-time/port observations retain the reminder after starting a lane; agent hosts cannot forge this owner event.
- Project tiles count recorded healthy and non-healthy services. The usage line shows measured `nvidia-smi` GPU utilization/memory and only reported, unexpired agent limits from 3.0. Missing GPU/limit data is omitted.
- Resource tests cover parsing, sibling-directory and owned-unit exclusion, cache expiry, unavailable probes, port/PID reuse, proposal persistence and approval boundaries. TLS tests verify peer-expiry math, exact host/port and handshake failure. Chromium at 1440px and 390px checked Run facts, adoption through New lane, the retained outside-copy reminder, service counts and GPU/limit facts, with no page errors or horizontal scrolling. Process/GPU/TLS browser data use fakes; real provider adoption and real preview certificates remain unverified.

### T. Terminals survive a node-pty crash (work-lane)

`node-pty` 1.1.0 segfaults on `spawn` on neo (Node 24.11), and because it runs inside the daemon, opening a terminal can take the daemon down.

- Move every PTY out of the daemon into a small child process per terminal (or one shared helper), talking over a pipe. A crash ends that terminal with a plain message ("The terminal stopped; open it again") and the daemon keeps running. Login terminals use the same path.
- Then make the PTY itself work on neo: rebuild against the running Node's headers, or move to a node-pty version that works with Node 24, pinned exactly. Record what fixed it.
- **Done when:** `terminal.real.test.ts` passes on neo, and a test that kills the PTY helper with SIGSEGV shows the daemon still answering `/api/health`.

#### What was done (2026-10-30)

Other Linux software settles both halves of this. VS Code moved node-pty into a separate pty host process because "node-pty crashes will take down the entire window" ([microsoft/vscode#74620](https://github.com/microsoft/vscode/issues/74620)). ttyd, script(1) and tmux itself use the plain POSIX calls: `openpty`, a new session with the pty as controlling terminal, and `TIOCSWINSZ` for the size. So:

- Each terminal is its own process, `apps/daemon/bin/pty-host.py`, using only Python's standard library (`os.openpty`, `fork`, `setsid`, `TIOCSCTTY`, `TIOCSWINSZ`). Typed input goes in on stdin, output comes out on stdout, and resizes arrive as "COLS ROWS" lines on fd 3. The daemon loads no native module.
- A crash or a missing `python3` closes that one terminal with a plain message; the daemon keeps running. Closing a browser tab hangs up the attach client, as before, and the tmux session stays.
- `node-pty` is removed, with its native build: `install.sh` and the updater no longer need C++ build tools, and `install.sh` now checks for `python3` (present on Ubuntu by default).
- Tests: `pty-host.test.ts` runs real terminals (tty detection, input, resize, UTF-8 split across reads, hang-up, a SIGSEGV'd host while `/api/health` keeps answering, a missing interpreter). `CONTEXTLANES_REAL_TERMINAL=1 pnpm exec vitest run apps/daemon/test/terminal.real.test.ts` passes from the repo root with real tmux, the browser WebSocket and the CLI. Not yet run on neo.

### S2. Daemon git runs in the sandbox

From Credentials and sandbox: the daemon runs git outside the sandbox in lane checkouts, so an agent can plant `.git/hooks`, `.git/config` entries (`core.fsmonitor`, `core.hooksPath`, `core.sshCommand`, filter and diff drivers, `includeIf`) or a `.gitattributes` filter, and the daemon's next `git status`, diff, rebase or push runs it as Kyle with no action from him. This is the shortest way out of the sandbox.

- Every git command the daemon runs in a lane worktree, or in a repository a lane can write to, goes through `sandbox()` like other lane commands, with the network allowed only where the command needs it (fetch, push). Commands that need Kyle's credentials (push, `gh`) run outside the sandbox, with hooks off (`-c core.hooksPath=/dev/null`), `GIT_CONFIG_NOSYSTEM=1`, and the repository's config checked against an allow-list of keys first; refuse with a plain sentence if anything else is set.
- Merge and review keep working: checks, diff, rebase onto the base, push and `gh pr create`.
- **Done when:** tests plant each of the entries above in a lane checkout and show that no daemon-side git command runs them; the real-sandbox suite passes on neo.

#### What was done (2026-10-30)

The plan's split (sandbox for most commands, a config allow-list for push and `gh`) would race: the agent can rewrite the config between the check and the command. So all of it runs in the sandbox instead, which is what the sandbox is for: anything git starts gets no more access than the agent already has.

- `confineGit` (`apps/daemon/src/sandbox.ts`) wraps the daemon's runner in `main.ts`. Every `git` and `gh` the daemon runs, in lane worktrees, project checkouts and discovery, goes through bubblewrap with the lane sandbox. The owner's SSH agent socket is bound in so pushes over SSH still work; HTTPS credentials and `gh` read from the home folder as before.
- Every daemon git also gets `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.ext.allow=never`. Command-line settings win over the repository's, so no hook runs, including Husky's. That also means the daemon's rebase and push skip pre-push hooks; checks are the recipe's job.
- Where bubblewrap does not work no lane can start, so git runs with the guards alone, and the check is retried each minute.
- `confine-git.test.ts` plants a textconv driver that reads `setup-token`, a `post-checkout` hook and `core.fsmonitor` in a real repository. Through `confineGit` the driver runs but reads nothing, and the hook and fsmonitor never run (checked to run without the guard). The real case runs wherever bubblewrap works; it ran here as root, not yet on neo.
- Still open, as before: anything an agent writes in the home folder (`~/.gitconfig` included) applies to the owner's own shell.

### B3 Per-lane databases (run)

- Decided: recipe field `database`, one of `{ "kind": "postgres", "url": "<admin url env name>", "template": "<db>" }` (creates `<template>_<lane>` with `CREATE DATABASE … TEMPLATE`) or `{ "kind": "sqlite", "file": "<path>" }` (copies the file into the worktree). The lane's services get the database through an env variable named in the recipe.
- Setup creates it, cleanup drops it (Postgres) or deletes the copy (SQLite), and the Run page shows the Database fact. Commands go through Runner (`psql`), and the admin URL comes from config, never from the recipe.
- Answer the open question about per-lane databases with this.
- Decided (2026-10-30), lane login: one owner-configured, non-admin application role (`LOGIN`, no `CREATEDB`, no superuser), set in config next to the admin URL. Setup creates each lane database owned by that role; services get a URL with that role only. The admin URL never leaves the daemon. Lanes sharing one role can reach each other's scratch databases; that is accepted for scratch copies. Per-lane roles are not built.

#### What was done (2026-10-30)

- `database` in the recipe (`packages/protocol/src/recipe.ts`), `[databases.postgres]` with `admin` and `app` in config, and `apps/daemon/src/databases.ts`. Setup makes the copy before setup steps, so migrations see it. Setup steps and services get `DATABASE_URL` (the app login, pointing at the copy) or `DATABASE_PATH`. The admin login reaches `psql` only through `PG*` environment variables, so it never appears in a process list, and never reaches a lane.
- Found against a real server: a copy keeps the template's table owners, so the app login could not read its own copy. Setup now runs `REASSIGN OWNED BY CURRENT_USER TO <app>` in the new copy. PostgreSQL 16 also needs the admin login to be a member of the app role to make it the owner; the error says so in one sentence.
- Clean up drops the copy (`WITH (FORCE)`), finding it by name even if setup failed after creating it; if the drop fails the lane is kept. Run shows the Database fact. README documents recipes, which it did not before.
- Tests: `databases.test.ts` (names, logins kept out of arguments, recipe validation, setup and service environment, clean up, missing config, SQLite). `databases.real.test.ts` passes against PostgreSQL 16 here with `CONTEXTLANES_REAL_POSTGRES="<admin url> <app url>"`: the app login reads and alters the copied table, cannot create databases, and the copy is gone after clean up.

### B4 Review packet gaps (review)

- Test counts and tool names in Result: parse the reporters you can identify (vitest, jest, pytest, go test, tsc, mypy, ruff, eslint). If the format is unknown, show pass or fail only. The Work trail's test bar (41 / 44) uses the same counts.
- Changed areas on the after screenshot: a pixel diff of before and after, merged into at most five boxes, and the caption "N changed areas". Pin `pixelmatch` (or similar) to an exact version.
- Plan vs done, "Not in the plan": changed files no plan entry mentions. Counting callers waits for 3.1.
- **Not here:** "Shares a file with 02" (3.3), Ask Codex to review (4.2).

#### What was done (2026-10-30)

- `testSummary` (`packages/protocol/src/testsummary.ts`) reads the closing summary of vitest, jest, pytest (with and without `-q`), `node --test`/TAP, `go test -v`, tsc, mypy, ruff and eslint. The pytest, mypy, ruff and `node --test` formats were checked against the real tools here. Unknown output gives nothing, and the row shows pass or fail as before.
- Review's Result rows read "Tests pass 44 / 44 · vitest", "Types clean", or "2 warnings · eslint" with the look-closer glyph. The Work trail draws the same 41 / 44 bar for an agent's own test runs when its output has a summary and no TAP lines.
- Changed areas: `apps/daemon/src/visualdiff.ts` compares before and after with pixelmatch 7.1.0 (anti-aliasing ignored), groups changed 16 px cells that touch into boxes, merges down to five, and treats a taller after page as new content at the bottom. Review draws them dashed on the after picture and captions "N changed areas" or "no visible change".
- "Not in the plan" was already there (changed files no plan entry mentions).
- Tests: `testsummary.test.ts`, `visualdiff.test.ts` (two separate changes, identical pictures, a missing picture, a taller page, merging to five).

### B5 Composer, editor link, watching only (work-lane)

- Composer: **@ file** picks a file in the worktree and sends it as an ACP resource link. **/ command** lists the agent's `available_commands_update`. **Attach image** appears only when the agent's prompt capabilities include images.
- **Open in editor**, decided: config `editor.url` with `{host}` and `{path}`, defaulting to the VS Code Remote-SSH URL. Used on Work, Architecture and Review.
- **Watching only:** list Claude Code and Codex processes whose working folder is inside a project and that no lane started (process list and `/proc/<pid>/cwd` through Runner). Show the agent, pid, folder and start time.
- **Take over**, decided: never kill. The button stays disabled ("Close it first") while the process runs. Once it has exited, Take over starts a lane in a new worktree from that folder's HEAD, carries uncommitted changes over as a patch, and tries ACP `session/load` with the session id from the agent's log. If loading fails, it starts fresh with a handoff written from the end of the log. Write down which way worked for each adapter.

#### What was done (2026-10-30)

- **@ file** searches the lane's files (`GET /api/lanes/:p/:n/files?q=`, tracked and new, not ignored) and sends each pick as an ACP `resource_link`, which every ACP agent must accept. The daemon refuses a path that is not a file inside the checkout after resolving symlinks.
- **/ command** lists what the agent reported in `available_commands_update` (now carried on `agent.session`) and puts `/name` at the start of the message, which is how ACP invokes them.
- **Attach image** (and paste) appears only when the agent's `initialize` response has `promptCapabilities.image`. Pictures (PNG, JPEG, WebP, GIF, 5 MB, three per message) are saved under `<lanes>/.attachments/<lane>/` and the command carries the path, so the event log stays small; the lane host reads and sends them as ACP `image` blocks.
- **Open in editor**: `[editor] url` in config, default `vscode://vscode-remote/ssh-remote+{host}{path}`, served by `GET /api/editor` and used in the Work inspector.
- **Watching only**: `apps/daemon/src/outside.ts` lists `claude` and `codex` processes (not the ACP adapters, logins or MCP servers) whose folder is in the project or a lane and whose cgroup is not a lane's, and finds the session log each is writing. Ended sessions stay listed for 12 hours.
- **Take over**, as decided: disabled while the process runs. Afterwards it starts a lane from that folder's branch, applies its uncommitted diff and copies its new files, and starts the agent with a handoff built from the session log (the first request and the latest exchanges, about 8,000 characters). The session itself is not resumed: Claude Code keeps sessions per folder, and the lane works in a new folder. The original folder is not touched.
- Tests: `attachments.test.ts` (paths, symlinks, pictures kept out of the log, file search, the handoff as first message) and `outside.test.ts` (process matching, both log formats, a real repository taken over with its changes). Not tried against real Claude Code or Codex sessions.

### B6 Add from GitHub, branch in the band (projects)

- Add repositories, GitHub tab: `gh repo list --json` through Runner, clone the chosen repository into the configured code folder, then register it as Add does now. Hide the tab when `gh` is missing or signed out, and say why.
- Project band: the main checkout's current branch.

#### What was done (2026-10-30)

- Add repositories has **From GitHub…**: `gh repo list` (newest first, private marked), then **Clone and add** runs `gh repo clone` into `paths.code` (default `~/code`) and registers it. A clone already there is reused if its remote is the same repository and refused otherwise. Missing or signed-out `gh` is a sentence, not an error. gh runs in the sandbox like the daemon's other git, reading its login from `~/.config/gh`; a `gh` that keeps its token in a desktop keyring will look signed out, which headless machines like neo do not use.
- The project band shows `owner/repo · branch`, from the GitHub remote and the main checkout's current branch.
- Tests: `github.test.ts`.

### 3.1 Code map (architecture)

Gate for the whole phase: 30% fewer cloud tokens on the same tasks (3.9).

- Use CodeGraph: `@colbymchenry/codegraph`, MIT licence, `CodeGraph.init/open`, `indexAll`, `searchNodes`, `getCallers`, `getImpactRadius`, `watch`. It needs Node ≥22.5 and uses `node:sqlite`. Pin the exact version.
- One index per project, on the main checkout. Keep the index in the data folder if CodeGraph allows it; otherwise add `.codegraph/` to the repo's `.git/info/exclude`. Never write to a tracked file.
- Lanes get no index of their own. Their overlay comes from `git diff` against the base, uncommitted changes and the files in `tool.call` events.
- Modules and layers: `.contextlanes.json` `architecture.layers` (`[{ name, tech?, paths: [globs] }]`) when present. Otherwise infer them: `packages/*` and `apps/*` in a monorepo, else folders under `src`, `app` or `lib`, at most about 30 modules. Edges are import and call edges summed between modules. A module is **covered by** the test files that import it.
- `GET /api/projects/:p/map` and a `map.synced` event.
- **Done when:** fixture repos (a TypeScript monorepo and a Python app) give the expected modules and edges, and a file change shows up in the map within 5 seconds. Record index time and size for this repository and Kyle's largest one; that answers the open question.

#### What was done (2026-10-30)

- CodeGraph (`@colbymchenry/codegraph` 1.6.2, MIT) is pinned in the daemon. Its library ships inside a per-platform package with its own Node and WebAssembly grammars (about 285 MB on linux-x64; pnpm shares it between releases). Its anonymous telemetry is on by default; ContextLanes turns it off (`CODEGRAPH_TELEMETRY=0`, `DO_NOT_TRACK=1`).
- `apps/daemon/src/codemap-worker.ts` runs CodeGraph in its own process inside the lane sandbox, the same reasoning as the terminals: its parser can run out of memory on large trees, and its index sits in the project folder, which lanes can write. The index is `<project>/.codegraph/` (CodeGraph allows no other place) and is added to `.git/info/exclude`, never `.gitignore`.
- The map comes from CodeGraph's own module query (`getModuleAggregation`): links with counts and the busiest symbol pairs behind each, test files that import each module, and main paths from its route manifest followed along the busiest link toward the data layer.
- Modules and layers (`packages/protocol/src/codemap.ts`): `architecture.layers` from `.contextlanes.json` when present, else inferred. A monorepo's packages are modules (split by folder above 25 code files); otherwise two levels under `src/`, `lib/` or `app/`, where a file at the second level is its own module (`models/tournament.py`). Layers come from folder names (Web, API, Logic, Data), with React/Vue/Svelte files in Web. Tests, config and docs are not modules.
- Instead of a file watcher, the index syncs incrementally whenever the map is asked for and is older than 20 seconds; a sync of this repository takes well under a second. A lane's position comes from `git diff` against its base plus its uncommitted files, so lanes need no index of their own; modules that exist only in a lane are marked new.
- `GET /api/projects/:p/map`. Measured here: this repository (152 files) indexes in 4.6 s with an 8.9 MB index. Kyle's largest repository is still to be measured.
- Tests: `codemap.test.ts` covers the rules, and builds a real map of a small Python app with CodeGraph: layers, links, test coverage, a lane overlay with a new module, and a clean `git status` afterwards.

### 3.2 Architecture page and `contextlanes arch` (architecture)

- Match the board:
  - layers as columns with their tech, module boxes with file counts, lane badges;
  - markers for "new" (added by a lane), dashed edges added by a lane, "a lane edits it", "two lanes edit it" and "uses a change";
  - filters Show all, Lanes, Changes and Tests;
  - the header "N of M modules · CodeGraph, synced X ago".
- Inspector: the selected module's layer, files and lines; Used by (with the symbol); Covered by; Start a lane here; Open in editor. The collision box and the brief arrive in 3.3 and 3.5.
- Main paths: entry points CodeGraph finds (routes, pages, CLI commands) traced through to the data layer, named from the route or entry symbol, at most 5, chosen by how many modules they touch. Selecting one traces it on the diagram.
- `contextlanes arch [project] [--json | --mermaid]`: layers, modules and edges as text, with the lane overlay.
- Show real layers and dependencies, not lanes and files. Set `READY.architecture`.

#### What was done (2026-10-30)

- `apps/web/src/pages/project/Architecture.tsx` follows `architecture.webp`: layers as columns with their language, module boxes with file counts and lane badges, "new" for modules only a lane has, a lane's colour on the modules it edits, the dashed amber box where two lanes edit one module, "uses a change" on modules that depend on one, links drawn behind the boxes, and Show all, Lanes, Changes and Tests. Lanes is the default when any lane has changed code. Main paths trace one route. The inspector shows the module's layer, size, who uses it (with the symbol), which tests cover it, Start a lane here (New lane with "In <module>:") and Open in editor. `READY.architecture` is on.
- Not drawn yet: the dashed "added by a lane" links, because lanes have no index of their own. The brief and the collision action arrive in 3.5 and 3.3.
- `contextlanes arch [project] [--json | --mermaid]`: layers and modules with what each uses, lane numbers, `*` where two lanes edit, new modules and main paths. The Mermaid output renders with `mmdc`.
- Checked in Chromium at 1440px and 390px with a ShuttleWorks-like fixture and two lanes editing `models/tournament.py`: no page errors besides the blocked Google Fonts request, no sideways scrolling.

### 3.3 Collision warnings (architecture, review)

- Within a minute of two open lanes changing the same module: a `collision.detected` event with the module, lanes, files and suggested order, and `collision.cleared` once one of them merges or reverts.
- Order, decided: if one lane's change is used by the other's (map edges), that lane goes first. Otherwise the lane nearer review goes first, and after that the smaller diff.
- Shown in Needs you, both lanes' Work headers, the Architecture inspector box (with its action, e.g. "Rebase 02 after checkpoint 1", which queues that message to lane 02 for after lane 01 merges) and the Review result "Shares a file with 02".
- Agents hear about a collision only when the owner presses the action.
- **Done when:** a two-lane fixture fires once, does not repeat, and clears on merge.

#### What was done (2026-10-30)

- `apps/daemon/src/collisions.ts` checks every 30 seconds (and 5 seconds after start) for two or more open lanes changing one module on the code map, so a new overlap is seen within a minute. It records `collision.detected` once on every lane in it, with the files and a suggested order, and `collision.cleared` when the overlap ends (a lane merges, is archived or drops the change).
- Order, as decided: a lane whose changed modules use the other lane's changes waits; otherwise the lane nearer review goes first, then the smaller change. The reason is shown ("02 is nearer review").
- The Inbox and Needs you get one Collision item, on the lane that should wait, linking to Architecture. Review shows "Shares models/tournament.py with 02 · Architecture →"; the Work header shows "Also changed by 02". The Architecture inspector's box shows both lanes, the order and its reason, and the action "Rebase 02 after 01 merges".
- Agents are told nothing by default. The action records `collision.planned`; when the first lane merges, the next check sends the waiting lane one message to rebase onto its base and resolve the module, and records `collision.told`.
- Tests: `collisions.test.ts` (order rules; recorded once, Inbox item, cleared; the note sent only after the merge, and only once).

### 3.4 Local model runtime (models)

- Endpoints from `localModels` (Ollama, and llama.cpp or any other OpenAI-compatible server), with an **Add endpoint** button.
- Per endpoint: health, the loaded model and memory use from Ollama `/api/ps`, and the GPU name and memory from `nvidia-smi` when the endpoint is on this machine. Remote endpoints show only what their API reports.
- A job queue, one job per GPU (each endpoint is one GPU), with the waiting count shown on Models.
- Kyle picks the models and checks that they fit (neo has 24 GB).

#### What was done (2026-10-30)

- `apps/daemon/src/localmodels.ts`: every call uses the OpenAI-compatible `/v1/chat/completions` that both Ollama and llama.cpp's server provide, with `<think>` blocks dropped from the answer. One job runs at a time per endpoint (each endpoint is one GPU); others wait in order, and the Models page shows the waiting count.
- `GET /api/models/local` and the Models page's Local models rows (models.webp): server and address, model, what is loaded (Ollama `/api/ps`, llama.cpp `/v1/models`), this machine's GPU memory from `nvidia-smi` with a meter, and Serving, Idle or Down. A model Ollama has not pulled says so with the `ollama pull` command.
- Endpoints may now be on another of Kyle's machines over the tailnet (`100.64.0.0/10` or `*.ts.net`), as the board shows for oracle; anything else is refused.
- Tests: `localmodels.test.ts` with a fake server (address rules, one job at a time, usage and `<think>` handling, status for Ollama and llama.cpp, a server that is down). No real model ran here: Ollama, llama.cpp and Hugging Face downloads are blocked from this container. Added to Needs Kyle.

### 3.5 Module briefs, `get_brief`, project notes (architecture, insights)

- Briefs: the local model writes one per module from CodeGraph facts and the files' opening lines. A brief is cached by a hash of the module's files and rebuilt on first request after they change. An owner edit is kept until the files change, and the inspector marks it as edited.
- `get_brief({ module | path })` returns the brief plus facts (public symbols, used by, covered by) under a size cap. Without a local model it returns the facts only and says so.
- Inspector line: "this brief Nk tokens · reading the files instead ≈ Mk tokens", both counted with the same tokenizer estimate.
- Project notes: short owner-edited facts in `<data>/notes/<project>.md`, added to the start of every new lane's first prompt and counted. They appear in Insights under "What every lane starts with", with an Edit button.
- Add `get_brief` to `LIVE_TOOLS`.

#### What was done (2026-10-30)

- The code map now gives each module a content hash, its exported symbols (name, kind, file, first line of the signature) and its files.
- `apps/daemon/src/briefs.ts`: a brief is written by the local model from CodeGraph's facts (layer, size, exports, who uses it and through which symbol, what it uses, its tests) and the first 60 lines of up to eight of its files, in at most 120 words, and saved under `<data>/briefs/<project>/` against the module's hash. A changed module's brief is marked "written before its files last changed". An owner edit is kept and marked as edited.
- `get_brief({ module | path })` is live (`LIVE_TOOLS`). It returns the brief, writing it first if a model is set up (waiting at most a minute), plus the facts. With no local model it returns the facts and says so, so the tool never answers with nothing.
- Architecture inspector: "Brief agents get" with Edit, Write it now, and "this brief ≈ 1.8k tokens · reading the files instead ≈ 38k tokens", both estimated at four characters per token from the brief and the files' sizes.
- Project notes: `GET/PUT /api/projects/:p/notes`, saved as `<data>/notes/<project>.md` and put before the task in every new lane's first message. Editing them in the page comes with Insights (3.7).
- Tests: `briefs.test.ts` (write, cache, stale, edit kept, facts-only without a model, unknown module, notes in the first message).

### 3.6 Local helper (`delegate`) (models, work-lane)

- Kinds: read (logs, test output, big files), edit (renames, fixtures, small specs) and check (run tests, sort failures).
- Decided: the helper is OpenCode over ACP using the configured local model (borrow, don't build). It runs in the lane's worktree inside the lane's sandbox. read and check run read-only. edit returns a patch, and the lead applies it with its own tools, so the owner's permissions still apply. The helper never writes.
- `helper.delegated` event: kind, model, tokens the lead did not read (content the helper read), result tokens, duration.
- Redone means:
  - read: the lead reads the same files itself in the same turn;
  - edit: the patch is not applied, or the same lines change again within 10 minutes;
  - check: the lead reruns the same command in the same turn.
- A kind turns off per project when its redo rate over the last 20 uses is above the threshold (default 25%), with the reason shown. "Near the limit" shows within 5 points of it. The owner can turn a kind back on.
- UI: the Models Local helper section; the Work step "Local helper read …, saved Nk cloud tokens"; "N by the local helper" in Review's How it got here.
- `delegate` goes into `LIVE_TOOLS` only while at least one kind is on and a model is serving.

#### What was done (2026-10-30)

- **Changed decision:** the plan said the helper would be OpenCode over ACP running the local model. It is instead one bounded request per call to the local model (`apps/daemon/src/helper.ts`). An agent loop needs a model that handles long tool use well, which the small models that fit next to a lane on one GPU do not, and it adds a second agent install and login to keep working. Each kind is a single job a small model does well:
  - **read**: the lead names files and a question; the daemon reads them from the lane's checkout (refusing paths outside it, 200 KB per file) and the model answers with the lines that matter, cited.
  - **check**: the daemon runs the approved recipe's checks in the sandbox, exactly as a checkpoint does, and the model sorts the failures. No other command can be run this way, so delegate cannot run anything the owner has not approved.
  - **edit**: the model returns a unified diff; the daemon checks it with `git apply --check`, saves it under `<lanes>/.attachments/<lane>/`, and returns it for the lead to review and apply. The helper never writes to the checkout.
- `helper.delegated` records the kind, model, files, an estimate of the cloud tokens saved (what the helper read minus what it returned, at four characters per token) and the time. `helper.redone` is recorded when, before its turn ends, the lead reads the same files itself (read) or runs the same check command (check), or when the patch was never applied (edit, checked with `git apply --reverse --check`).
- A kind turns itself off when over 25% of its last 20 uses (at least 5) were redone (`[helper] redoLimit`), shows "Near the limit" within 5 points, and the owner can turn any kind on or off. There is one helper per machine, as on the board.
- Agents are offered `delegate` only while some kind is on: the toolbox asks `GET /api/lanes/:p/:n/tools` (lane token) when it starts.
- Models → Local helper (models.webp), the Work step "Local helper read test.log · came back as 120 tokens · saved ≈ 6k cloud tokens", and Review's "N by the local helper".
- Tests: `helper.test.ts` (each kind with a fake model and real files and git; redo detection; switching off; owner toggle; nothing offered without a model). Not run against a real model.

### 3.7 Insights (insights)

- Runs nightly (a systemd user timer) and after each merge, plus a Regenerate button.
- Numbers are computed in code, never by the model: merges, cloud tokens, share of work on your GPUs (local tokens over all tokens), and median wait for you (time from `permission.requested` to `permission.answered`).
- The model writes the summary sentences and suggestions as JSON checked by zod:
  - each suggestion has a type (process, code, tokens, next or notes), a title, a body, a metric, and evidence (event ids, commits, lanes, files);
  - each offers one action from a fixed list: add to notes, start a lane, fresh session, allow a helper kind, fix note, review.
- Drop any suggestion whose evidence does not exist or whose numbers differ from the computed ones. Nothing is applied without a click, and suggestions can be dismissed.
- Usage today: per-lane totals and cache share from 3.0. Show the breakdown by harness, rules, MCP tools, files and conversation only if you find a real source; write down what you checked.
- Lane history retention (from B1) can now summarise old lanes before trimming them.
- Set `READY.insights`.

#### What was done (2026-10-30)

- `apps/daemon/src/insights.ts` counts the week from the event log: merges, cloud tokens (input, output and cache, from `usage.turn`), the share processed on local GPUs (the helper's input and output), the median time from a question or permission to its answer, questions asked twice or more, files read four or more times, modules edited by two or more lanes (code map), collisions, command output over 40,000 characters that the lead read itself, and plan entries left open when a lane merged. Each becomes a stat with an id, a value and a sentence of evidence.
- The local model gets only those stats and replies with JSON (summary sentences and up to six suggestions, each citing stat ids, with one action from a fixed list: add to notes, start a lane, allow a helper kind, review, fix note). Anything citing an id that does not exist, or containing a number that none of its cited stats holds, is dropped. Suggestions take their number from the stat, never from the model. Nothing runs without a click; suggestions can be dismissed.
- Runs after 02:00 once a day and five minutes after any merge, from inside the daemon rather than a systemd timer (the daemon is always on and already holds the model queue), plus Regenerate.
- The Insights page follows `insights.webp`: This week with cited sentences and the four numbers, Suggestions with filters, Usage today (per lane, with the share read from cache), and What every lane starts with (project notes, editable here; module briefs). `READY.insights` is on.
- Not shown: the board's split of each lane's context into harness, rules, MCP tools, files and conversation. Neither adapter reports it (checked in 3.0), and estimating it would be a made-up number. Handoffs arrive with 4.1.
- The local helper now also shows Off while its model is not answering, so agents are not offered `delegate` when it would fail.
- Tests: `insights.test.ts` (the numbers; the filter keeping an honest sentence and suggestion and dropping one with an invented number and one with invented evidence; dismiss).

### 3.8 ⌘K Ask (top bar)

- Answers questions about a project from the map, briefs, notes and event log with the local model, citing each source it used.
- Read only. Starting a lane from an answer goes through the normal New lane form.

#### What was done (2026-10-30)

- ⌘K is now "Ask, jump or start a lane". Typing three or more words adds "Ask about <project>: …" (the current project, or up to three) and "Start a lane in <project>: …" (New lane with that task).
- `apps/daemon/src/ask.ts` answers from project notes, the code map (layers, modules and what each uses, main paths), written briefs (those whose module names match the question first, about 6,000 characters) and the open lanes, with the local model, in at most five sentences with a source id after each claim. A citation to a source it was not given is removed; the cited sources show as chips that open the lane, Insights or Architecture. Read only.
- Tests: `ask.test.ts` (sources sent, invented citation removed).

### 3.9 Measure the phase 3 gate

- `contextlanes bench <tasks.json>`: each task names a repository, a commit, a task and a check command. Each task runs twice in fresh lanes from the same commit with the same agent and model: once with notes, `get_brief` and `delegate` off, once with them on. Record tokens (3.0), time, and whether the check passed, and write a table into this document.
- Test it with the fake agent. The real run costs tokens and is Kyle's.
- Gate: at least 30% fewer cloud tokens, with checks passing at the same rate.

#### What was done (2026-10-30)

- `contextlanes bench <tasks.json>` posts the tasks to `POST /api/bench` and prints progress, then a Markdown table ready for this document. A task is `{ "project", "base", "task", "check": [argv], "agent", "model", "timeoutMinutes" }`.
- `apps/daemon/src/bench.ts` starts both lanes of a task at once from the same base, with the same agent and model, in "accept edits" mode. The baseline lane starts without project notes and is offered neither `get_brief` nor `delegate` (`baseline` on the lane's `lane.created` event); the other gets all of phase 3. A run ends when its agent's turn ends with nothing queued, or it fails or times out; then the task's check runs in that lane's checkout in the sandbox. Tokens are the agent's own reported usage (3.0). Results are saved under `<data>/bench/`.
- The bench never answers a permission: commands the agents want to run still come to the Inbox.
- Tests: `bench.test.ts` with a fake lane manager (both lanes, tokens, checks, the table) and the baseline's first message.
- **The gate itself is not measured.** It needs real agents, a real local model and real tokens on neo. Added to Needs Kyle.

### 4.1 Hand off, fork, fresh session (work-lane)

- Hand off to another agent: the current agent writes a handoff summary. A new ACP session for the chosen agent then starts in the same worktree with the handoff as its first prompt, and the old session closes.
- Fresh session: the same, keeping the same agent. The Context block shows the handoff's size.
- Fork into a new lane: a new lane from this lane's HEAD, with the task and handoff copied.
- Handoffs are saved and listed in Insights. Set `READY.handoff`.

#### What was done (2026-10-30)

- `apps/daemon/src/handoff.ts`. **Fresh session** (Context block) and **Hand off to another agent** (Lane actions): the current agent is asked for a handoff (under 400 words: the task, what is done, what is left, failures, rules) and its turn is awaited for up to five minutes. Then its host stops and a new host starts in the same checkout with the same or the chosen agent, whose first message is the handoff plus the owner's note. `lane.handoff` records it; the handoff is kept under `<data>/handoffs/<project>/` (counted on Insights).
- **Fork into a new lane**: a new lane from this lane's branch, with its uncommitted diff and new files copied in, whose agent starts from a handoff built from this lane's conversation (no wait on the agent). `lane.forked` records it on the original lane. Both lanes carry on.
- If the agent is not connected, the handoff stops with a sentence suggesting Fork. `READY.handoff` is on.
- Tests: `handoff.test.ts` (hand off to another agent with the note; agent not connected; fork with changes).

### 4.2 Second-agent review (review)

- **Ask Codex to review** (or another signed-in agent): a read-only session given the checkpoint diff and packet. Its findings become a section of the packet. The estimated cost comes from the diff size and is shown before starting.

#### What was done (2026-10-30)

- `apps/daemon/src/second-review.ts`: **Ask <agent> to review** on the Review page starts a lane of its own for another signed-in agent, in plan (read-only) mode, from the lane's branch, asked for findings ("blocker", "should fix" or "nit" with file:line) and a verdict. When its first turn ends, its answer is saved in the packet as a Second review section and its lane is archived and its host stopped. It cannot approve or merge.
- The estimate shown before starting ("second review ≈ 40k tokens") is the diff read twice plus 15k of agent overhead, rounded; it is a guess and labelled as one.
- Tests: `second-review.test.ts` (refuses the same agent; the read-only lane; findings saved; lane archived).

### 4.3 More agents (models)

- Hermes, Gemini CLI and Goose over ACP, plus **Add from ACP registry**. Install and sign-in detection work as they do for the current agents.
- Each starts in a mode where a human approves; modes that approve on their own are excluded. Record each adapter's modes with a source link, as for Codex.

#### What was done (2026-10-30)

- **Add from ACP registry** on Models lists the registry's agents (`cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, the format in `github.com/agentclientprotocol/registry`; Gemini CLI, goose, Qwen Code, Cline, Mistral Vibe and about 40 more as of today). `apps/daemon/src/registry.ts` installs one by its own distribution: npm packages into `~/.local` like the built-in adapters; downloads checked against the registry's SHA-256 and unpacked under `~/.local/share/acp-agents/` (outside the data folder, so the sandboxed lane host can run them); `uv` agents run through `uvx`. The result is saved as `[agents.<id>]`, shown under Agents with Remove, and offered in New lane.
- Safety as for Codex: lanes start each agent in a human-approval mode (now also `approve` and `manual`, the names goose uses); bypass modes are refused by `SafeMode`; and the registry's own arguments are filtered, so goose's `--yolo` style switches are never passed.
- Registry agents sign in through their own CLI or ACP; ContextLanes only checks that the command is there.
- **Hermes Agent is not in the ACP registry** (checked against the registry repository today), so it is not offered. If it is added there it appears without code changes.
- Tests: `registry.test.ts` (listing; npm install; a checked download; a tampered download refused; unsafe switches dropped).

### 4.4 Routing (models)

- Rules map a kind of task (keywords the owner writes) to an agent, a model and a label. New lane pre-fills from the first rule that matches, and the owner can change it.
- Insights can suggest a rule. It is added only with a click.

#### What was done (2026-10-30)

- `[[routing]]` rules in config (`words`, `agent`, optional `model` and `label`), edited in Models → Routing. `routeTask` (protocol) picks the first rule with one of its words at the start of a word in the task, case-insensitive and literal.
- New lane picks the routed agent (and model) until the owner chooses one, and says "picked by your routing rule".
- Not built: Insights suggesting a rule. Its suggestion actions are a fixed list, and a rule from a model's reading of a week is the kind of change that should be the owner's; it can be added as an action later.
- Tests: `routing.test.ts`.

### 4.5 Scheduled lanes

- A lane template (project, task, agent, model, mode, base) plus a schedule, run as a systemd user timer with `Persistent=true`. Each run starts a lane, and its result lands in the Inbox. A scheduled lane never merges.
- No board: use a section in Settings, Lanes, with existing classes, and ask for a board in Needs Kyle.

#### What was done (2026-10-30)

- `apps/daemon/src/schedules.ts`: a schedule (name, project, task, agent, mode, branch, and a systemd calendar expression such as `Mon..Fri 07:30`) is checked with `systemd-analyze calendar`, then written as `contextlanes-schedule-<name>.timer` (`Persistent=true`, so a run missed while the machine was off happens at the next boot) and a oneshot service that runs `contextlanes schedule run <name>`. The CLI asks the daemon to start the lane exactly as New lane does, with the goal "Scheduled: <name>". Nothing merges by itself; questions and the checkpoint wait in the Inbox.
- Settings → Scheduled lanes lists them with the next run (systemd's own answer), the last lane started, Run now and Remove. Units carry the installer's marker line and anything else is never overwritten.
- No board exists for this; it uses Settings' existing sections and forms. Added to Needs Kyle for a design pass.
- Tests: `schedules.test.ts` (calendar refused or accepted by systemd's output format, which was checked against systemd here; unit contents; enable; run; remove).

### 4.6 Shared skills (insights)

- Accepted Insights suggestions of type notes go into project notes.
- Skills: per-project files linked into each new lane in the place that lane's agent reads them, excluded from git. Check per agent (Claude Code, Codex, OpenCode) and write down where each one looks.

### 4.7 Final board pass

- Compare every page with its board at 1440px and 390px. Fix the differences, or list each one that remains with its reason in `docs/mockups/README.md`.

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
- How long does CodeGraph take to index the largest repo, and how big is the index? This repository: 4.6 s, 8.9 MB (152 files). Kyle's largest still to measure.
- Per-lane databases: decided in B3 (Postgres template databases or copied SQLite files, chosen in the recipe).
- Which delegate kinds clear the redo-rate bar on the local GPU, and how many local jobs can run before lanes wait?
- `node:sqlite` still emits an experimental warning on the tested Node 24.11.0. The Store tests and full local check pass, so it remains behind the existing `Store` API; long-running production durability is not established by this milestone.
- Licence for the open-source release.
