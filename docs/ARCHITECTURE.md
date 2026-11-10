# ContextLanes — architecture

ContextLanes is one small service on an always-on machine. It turns a task into a **lane**: a branch and worktree, a tmux terminal, a running copy of the app on its own ports, and a link for each service. Agents (Claude Code, Codex) run as their own CLIs in the lane's terminal and use it through the `contextlanes` command; a lane can also run no agent at all. Everything hard is borrowed: git worktrees, tmux, systemd (or plain process groups where there is none), bubblewrap, SQLite, and the owner's own reverse proxy. Why it looks like this: [V3.md](V3.md).

## Processes

```mermaid
flowchart TB
  subgraph clients[Clients]
    agent[Agent CLI in a lane<br/>Claude Code · Codex]
    cli[contextlanes CLI]
    browser[Browser · phone]
  end
  proxy[Your reverse proxy<br/>*.domain, TLS]
  subgraph machine[Always-on machine]
    daemon[Daemon<br/>Fastify · SQLite · SSE · 127.0.0.1:4600]
    router[Preview router<br/>one port, by hostname]
    subgraph lane1[Lane 01]
      tmux1[tmux session<br/>the agent or your shell]
      app1[App services<br/>systemd units or process groups]
    end
  end
  agent --> cli --> daemon
  browser --> proxy --> router
  router -- lanes.domain --> daemon
  router -- service-01-project.domain --> app1
  daemon --> tmux1
  daemon --> app1
```

| Process | Lifetime | Job |
|---|---|---|
| Daemon (`apps/daemon`) | systemd user service, or `contextlanes daemon` in the foreground | HTTP API on loopback, live stream, event log, lane manager, runtime, notifier |
| Preview router (`apps/daemon/src/preview-router.ts`) | inside the daemon | One port (`[previews] localPort`) answering `<label>.<domain>` and `<label>.localhost`: lane services, and the web app under `lanes` |
| Supervisor (`apps/daemon/src/supervisor/`) | inside the daemon | Runs lane services and one-shots: systemd user units, or process groups the daemon watches (restart on failure, logs under `<data>/logs`, re-adopted after a restart) |
| tmux session | one per lane | The lane's terminal: the agent's CLI, or your shell |
| Agent CLI | in the lane's tmux pane, inside bubblewrap | Claude Code or Codex with their own logins; hooks report its steps to the event log |
| App services | one per recipe service | The lane's running copy of the app, on its own ports, on 127.0.0.1 |

Features outside the core are off until turned on under `[features]` (`apps/daemon/src/features.ts`): `acp` (ACP lane hosts, `apps/lanehost`, and the agent registry), `review` (checker, judge, merge), `architecture` (CodeGraph code map, collisions), `insights` (briefs, Ask, Tidy, nudges), `helper` (local models, `delegate`), `sublanes`, `handoff`, `bench`, `schedules`, `adoption`. A feature that is off answers its routes with 404 `feature_off`, starts no background work and gives agents none of its tools.

## Data

The six core tables, three notification transport tables, hashed owner-session table and expiring setup-link table live in SQLite (`node:sqlite`, WAL). Lane state and work remain event-derived.

| Table | Holds |
|---|---|
| `project` | A repo on this machine: path, remote, approved recipe hash |
| `lane` | One task in one worktree: agent, model, mode, branch, worktree, tmux session, state, colour |
| `event` | Every update in order, `(lane, seq)` gap-free |
| `checkpoint` | A change ready for review: base, head, checks, screenshots, decision |
| `environment` | A lane's running services: units, ports, hostnames, health |
| `approval` | Recipes approved by the owner, by hash |
| `push_subscription` | Private browser push endpoints and encryption keys |
| `notification_action` | Hashed, single-choice notification capabilities |
| `notification_cursor` | Last processed Telegram polling offset |

### Lane lifecycle

```mermaid
stateDiagram-v2
  [*] --> draft
  draft --> setting_up
  setting_up --> working
  setting_up --> failed
  failed --> setting_up: retry
  working --> needs_you: asks
  needs_you --> working: you answer
  working --> in_review: checkpoint
  in_review --> working: changes requested
  in_review --> merged: approve
  merged --> cleaned
  working --> paused
  paused --> working
```

A lane waits on you only in `needs_you` and `in_review`. `archived` can be reached from any open state.

### Events

| Type | When |
|---|---|
| `lane.created`, `lane.state` | The lane manager creates or moves a lane |
| `agent.plan`, `agent.thought`, `agent.message` | ACP plan updates and streamed text, joined into one step per run |
| `tool.call`, `tool.update` | ACP tool calls with kind, title and files |
| `permission.requested`, `permission.answered` | An agent asks; you answer from web, phone, Telegram or CLI |
| `recipe.requested`, `recipe.approved` | A lane needs a recipe approved; the owner approved it |
| `env.status`, `check.result`, `checkpoint.created`, `checkpoint.decided` | Runtime, checker and the owner's decision |
| `helper.delegated` | The local helper did work, with tokens saved |
| `usage` | Context window use reported by the agent |
| `agent.command`, `agent.command.result` | Durable owner controls and host acknowledgements |
| `agent.session`, `agent.turn`, `agent.error` | Reported settings, active prompt IDs and failures |
| `notification.sent`, `notification.failed` | Delivery evidence; never permission decisions |

## Interfaces

**HTTP** (loopback; the web app is also reached through the router as `lanes.<domain>`):

| Route | Purpose |
|---|---|
| `GET /api/health` | Version and host; `sandbox: "off"` when confinement is turned off |
| `GET /api/features`, `GET /api/doctor` | Which features are on; the health check (`contextlanes doctor`) |
| `GET /api/machine`, `POST /api/machine/updates`, `GET /api/data/export` | Machine/backup observations, fetch-only CLI update check, redacted JSON download |
| `GET /api/usage?project=&since=` | Per-lane and UTC-day token/cost totals, with reported agent limits |
| `GET /api/resources` | Project service counts and measured GPU facts; Run's environment response also includes worktree/TLS facts and outside listeners |
| `POST /api/tickets` | A one-use, 30-second ticket for one stream or terminal path |
| `GET /api/projects`, `POST /api/projects` | List and register repos |
| `GET /api/projects/:project/lanes` | Lanes in a project |
| `GET /api/projects/:project/activity?since=` | Timeline events and preceding lifecycle/turn states |
| `GET /api/projects/:project/stream` | Server-sent events for every lane in the project |
| `POST /api/lanes` | Start a lane |
| `GET /api/lanes/:project/:n/events?after=` | Event history |
| `POST /api/lanes/:project/:n/prompt` | Message the agent |
| `POST /api/lanes/:project/:n/cancel`, `/mode`, `/model` | Interrupt or change an agent setting; commands survive daemon restart |
| `GET /api/lanes/:project/:n/terminal` | WebSocket: attach a PTY tmux client; browser disconnect detaches only that client |
| `POST /api/lanes/:project/:n/tools/:tool` | Toolbox calls from the agent |
| `GET /api/projects/:project/recipe`, `POST …/recipe/approve` | The project's recipe; approve by hash (owner session only) |
| `GET /api/projects/:project/environments` | Run page: recipes, environments and what can be cleaned up |
| `GET /api/lanes/:project/:n/env`, `POST …/env/start`, `/stop`, `/restart` (`{ services }` restarts only those), `GET …/logs`, `GET …/url?service=` | A lane's services, their logs and a service's working link |
| `POST /api/lanes/:project/:n/checkpoint` | Start the checker |
| `GET /api/projects/:project/checkpoints`, `GET /api/checkpoints/:id/shots/:file`, `GET /api/checkpoints/:id/diff` | Review packets |
| `POST /api/lanes/:project/:n/approve`, `/request-changes`, `/cleanup` | The owner's decisions (owner session only) |
| `GET /api/inbox`, `POST /api/answers` | What waits on you, and your answer |
| `GET /api/stream` | Global event stream for the Inbox |
| `GET /api/notifications` | Public notification configuration and VAPID public key, with no credentials |
| `POST /api/push/subscriptions`, `DELETE /api/push/subscriptions` | Register or remove this browser's push endpoint |

**Lane host socket** (`$XDG_RUNTIME_DIR/contextlanes-<hash>/lanes.sock`, JSON lines):
- host → daemon: `{"hello":"<lane>","token":"<lane token>"}`, then `{"eventId":"<uuid>","event":{"type":"...","payload":{...}}}`.
- daemon → host: `{"ready":true}`, durable `{"commandId":"<uuid>","command":{"kind":"prompt|answer|cancel|mode|model",...}}` and `{"ack":"<eventId>"}`.
- The host retains observations until acknowledged; `(lane, source_id)` deduplicates replay in SQLite without seq gaps. Commands are `agent.command` events, pending until `agent.command.result`. The surviving host suppresses repeated command IDs. Permission answers are validated against the outstanding request and recorded with their command in one transaction.
- Only the daemon writes owner decisions and commands. The socket is mode 0600; host observations cannot forge `permission.answered`, user messages or lane transitions. New permission events move the lane to `needs_you`; the final pending answer moves it back with a `lane.state` event.

`[lanes].launchHosts` defaults to true. `[agents.<name>]` overrides the ACP command, argument array and environment; `[lanes.host]` and `[lanes.toolbox]` override workspace entry points. Defaults use absolute Node/script paths, so systemd does not depend on package binaries being globally linked. The host reconnects while holding the same agent process and ACP session. Agent failures become events; the host does not restart the task automatically.

**Agent toolbox** (MCP, also `POST /api/lanes/:project/:n/tools/:tool` with the lane token): core tools are `ask_owner`, `env_status`, `env_start`, `env_stop`, `env_restart`, `recipe_status`, `get_logs`, `preview_url`; the others join while their feature is on.

**CLI:** lanes (`lanes`, `status`, `lane start [--no-agent] [--here]`, `lane rm`, `claude`, `codex`, `send`, `term`), a lane's app (`env [start|stop|restart]`, `logs`, `url`, `recipe [approve]`), the owner (`inbox`, `answer`), the machine (`setup`, `add`, `daemon`, `doctor`, `update`) and `agent-notes`. Every command takes `--json`; exit codes are 0 done, 1 failed, 2 usage, 3 unreachable, 4 waiting on the owner. Inside a CLI lane the agent's `contextlanes` is a wrapper in the lane's data folder (the installed one runs through the data folder, which the sandbox hides), and it authenticates with the lane token, which reaches only that lane's tool routes.

**Terminal wire:** browser messages are validated `TerminalInput` values: `{"type":"input","data":"..."}` or `{"type":"resize","cols":100,"rows":30}`. Output is raw UTF-8 terminal text. The server starts at 80×24 and xterm sends its fitted size on connection and resize (1–500 columns, 1–200 rows). Input messages are bounded; a slow browser is disconnected rather than buffering indefinitely. Reconnect attaches to the existing session; tmux copy mode retains older history. Terminal I/O does not mutate lane state or create agent events.

Each terminal runs in its own PTY host process (`apps/daemon/bin/pty-host.py`, Python standard library: `openpty`, `setsid`, `TIOCSWINSZ`), the pattern VS Code uses for its pty host. No native module is loaded into the daemon, and a crashed terminal closes alone.

## Security

- The daemon binds `127.0.0.1`, and the router or Tailscale Serve proxies to it, so every request arrives from loopback. A local process can send any header, so loopback addresses, `Host` and Tailscale headers prove nothing. Only a credential says who a request is from: a browser session token (`Authorization: Bearer`, kept in localStorage), `<data>/setup-token` from the CLI, a single-use ticket for a stream or terminal, a lane token, or a notification action token. Every route except health, setup status and the sign-in routes answers 401 without one. A Tailscale login that is not the configured owner gets 403; the owner's login signs nobody in.
- Sessions are in localStorage because storage belongs to one origin. Lane previews are sibling names under the same domain (`web-01-shop.<domain>` beside `lanes.<domain>`) and cookies could be shared with them; localStorage cannot. Origin checks accept `localhost`, the Tailscale Serve address and `lanes.<domain>` only, never a preview's name.
- The router passes the `Host` header through unchanged, so the local control endpoint and the setup-token path, which require `Host: localhost`, stay unreachable through it. It answers only names it published; anything else, including `127.0.0.1`, gets its 404.
- A lane token is accepted only on that lane's toolbox routes and on its socket connection. Agents never approve their own permissions or recipes: answers come only through `/api/answers`, and recipe approval, merge, request changes and cleanup all need an owner credential.
- Every command started for a lane runs inside `bwrap` (`apps/daemon/src/sandbox.ts`), which hides the data folder except the releases, the config folder, all of `/run` and the tmux sockets. systemd's `InaccessiblePaths=` is not used: it has no effect in user units on Ubuntu 24.04, and could not leave the release readable. A lane does not start unless the sandbox is proven to hide `setup-token`.
- The daemon itself runs outside the sandbox, and an agent controls everything in its checkout, symlinks included. So the daemon reads, copies and writes lane files only through `apps/daemon/src/safefs.ts`: real path inside the checkout, no final symlink, no FIFO or device, a size cap. Its own git and gh run inside `bwrap` too (`confineGit`), with hooks, fsmonitor and other config-run programs turned off.
- Agents from the ACP registry are installed only when their arguments and environment contain nothing that turns off permission prompts; downloads must match the registry's sha256.
- Limits: agents still run as the owner's Unix user, with write access to the home folder. They can edit dotfiles, `~/.ssh/authorized_keys` and git configuration, and the daemon's own git commands or the owner's next shell then run that outside the sandbox. They cannot read other lanes' process environments, or the daemon's, because each lane has its own user namespace. IMPLEMENTATION.md, Credentials and sandbox, has the full list.
- Terminal WebSockets also check that the browser origin matches the request host. Daemon configuration rejects other bind addresses; Vite development and preview also bind loopback.
- Notification action bearers grant exactly one recorded lane/request/option, not general API access. A conflicting Tailscale owner is still refused. Telegram callbacks additionally require the configured sender and chat. Replays cannot answer twice; no action expiration, quiet-hour timer or delivery retry supplies an answer. Push subscriptions and action hashes are private; database files use mode 0600.
- Services are started on 127.0.0.1, and one found listening on another address is stopped by the next probe (every 5 seconds); the "before" services the checker starts for screenshots are short-lived and not probed. Previews are reachable through the router, which binds `[previews] bind` (127.0.0.1 unless the owner's proxy needs another address); only the router may leave loopback.
- `[sandbox] mode = "off"` (for machines without bubblewrap) runs agents and services unconfined. It is never chosen automatically; every lane started that way records `sandbox: "off"`, and status, Settings and the doctor say so.
- Cleanup refuses unpushed commits and uncommitted changes to tracked files, and nothing force-pushes. It does remove the checkout's ignored files (`.env`, local databases, build output) with it.

**Notifications:** the daemon observes pending request events, records `notification.sent` / `notification.failed`, and retries deferred work after quiet hours and on restart. ntfy and Telegram use injected HTTP fetch; Web Push uses an injected VAPID transport. Telegram polls outbound and persists its cursor; it never needs an inbound public bot webhook. Provider credentials remain in configuration and are excluded from public status routes.

## Setup and installation

The daemon serves the built `apps/web/dist` SPA as well as `/api`; unknown API routes never become HTML. Static paths are confined to that directory, assets are immutable and the service worker is not cached. Live event streams end during `preClose`, so a browser cannot hold a daemon restart open. Host startup refuses an active lane socket or non-socket path; only stale sockets are removed.

`SetupManager` writes validated configuration atomically with mode 0600, then applies it to the running managers. Saved projects are re-registered idempotently at startup, and notifier changes close the old transport before starting the new one. Commands remain injected through `Runner`, including agent status/install, Git validation and Tailscale Serve. Model probes are loopback-only and reject redirects.

The CLI proves local shell access by reading `<data>/setup-token` (0600) automatically and sends it on every request. The local control endpoint additionally requires a loopback peer and hostname and refuses Origin/Tailscale headers. It persists the shell owner, checks linger, enables/reuses Serve through Runner, then mints an origin-bound ten-minute sign-in link. Only link hashes are persisted; one atomic delete consumes a link, including under concurrent requests. Secrets are carried in URL fragments, removed on landing, and never sent in request URLs or referrers. Initial typed-code/passkey claim endpoints no longer exist. A shell owner is distinct from the optional Tailscale owner identity; no application API opens before one is established.

Browser setup steps are sign in, a Ready agent, an added project and a working lane. Repository discovery first reads Claude Code and Codex session history, then walks home five levels deep (at most 6,000 folders or 3 seconds), stopping at each repository and skipping hidden folders, node_modules, symlinks and folders with more than 300 subfolders. Folder browsing canonicalizes paths and confines them to home. Explicit path registration accepts `~`, verifies Git through Runner, and remains owner-only, as do scan/browse/branch and fixed-command login-terminal endpoints. Login terminals use the same PTY host and never accept a shell command from a request. Closing one stops the login command, not any lane.

Passkeys can be added only to the owner’s configured HTTPS address after sign-in. WebAuthn uses single-use five-minute challenges bound to origin/RP, required user verification and persisted counters, which cannot move backwards. Thirty-day random session tokens are kept in the browser's localStorage; only hashes are stored. These authentication expirations never answer agent permissions. Existing passkeys remain valid at their original RP. Notification and local endpoint settings live in Settings and Models. Serve’s URL is persisted for notification links; existing routes are preserved.

`install.sh` bootstraps a new checkout, builds and invokes the installer entry point; without a systemd user manager it installs only the commands, and `contextlanes daemon` runs the daemon in the foreground under any supervisor; on a machine that already has it, it builds the newest commit beside the running one and hands over to the updater. The installer writes an absolute-Node user unit and executable wrappers that point at `~/.local/share/contextlanes/current`; it replaces only files carrying its own marker line, refuses unrelated files and never stops lane hosts. `contextlanes update` builds each version in `releases/<commit>`, backs up the database, swaps the `current` link, restarts the daemon and switches back if the new version does not report healthy within 30 seconds (IMPLEMENTATION.md, Updating). Normal installation needs systemd user services, Node, npm, Git, tmux and bubblewrap. A failed optional native terminal build does not prevent the daemon from starting.

## Decisions

| Decision | Why |
|---|---|
| TypeScript everywhere | Every borrowed SDK has TypeScript (ACP, Claude Agent SDK, Codex SDK, CodeGraph, Playwright); one language for daemon, host, CLI and web |
| `node:sqlite` instead of a native database module | No extra native database dependency; same SQL. `better-sqlite3` can replace it behind `Store` if needed |
| Native CLIs for Claude Code and Codex; ACP behind a feature | The agents' own interfaces, with their own logins and updates; ACP kept for other agents |
| One lane host per lane under systemd | Agents survive daemon restarts and upgrades |
| tmux for terminals | Persistent, attachable from the browser and any terminal |
| Subdomain per lane service, one DNS label | Paths break single-page apps and hot reload; a wildcard certificate covers one label |
| One router port behind the owner's proxy | One wildcard entry is the whole network setup, whatever proxy the owner runs |
| A supervisor interface | systemd where it exists; process groups on macOS and Linux without a user session |
| Local helper as an MCP tool | Works with subscription logins; Claude Code cannot route subagents to other providers |
