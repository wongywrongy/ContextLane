# ContextLanes — architecture

ContextLanes is one small service on an always-on machine. It turns a task into a **lane**: a branch and worktree, a terminal, a running copy of the app and an agent session. It carries that lane through to a merged change. Everything hard is borrowed: agents speak ACP, shells are tmux, apps run as systemd units, code is mapped by CodeGraph, and access rides on Tailscale.

## Processes

```mermaid
flowchart TB
  subgraph clients[Clients]
    web[Browser · phone web app]
    cli[contextlanes CLI]
    tg[Telegram · ntfy]
  end
  ts[Tailscale Serve<br/>identity headers]
  subgraph machine[Always-on machine]
    daemon[Daemon<br/>Fastify · SQLite · SSE]
    subgraph lane1[Lane 01]
      host1[Lane host<br/>systemd unit]
      agent1[Agent over ACP<br/>claude-agent-acp]
      tmux1[tmux session]
      app1[App services<br/>systemd units]
    end
    toolbox[Toolbox MCP server]
    local[Ollama · llama.cpp]
  end
  web --> ts --> daemon
  cli --> daemon
  tg --> daemon
  daemon <-- Unix socket, JSON lines --> host1
  host1 <-- ACP over stdio --> agent1
  agent1 -- MCP --> toolbox --> daemon
  daemon --> tmux1
  daemon --> app1
  toolbox -. delegate .-> local
```

| Process | Lifetime | Job |
|---|---|---|
| Daemon (`apps/daemon`) | systemd user service | HTTP API, live stream, event log, lane manager, runtime, checker, notifier |
| Lane host (`apps/lanehost`) | one systemd unit per lane | Holds the agent's ACP session; survives daemon restarts |
| Agent | child of the lane host | Claude Code, Codex, OpenCode… each with its own login |
| Toolbox (`packages/toolbox`) | started by the agent over MCP stdio | Lets the agent use the lane: services, logs, previews, ask the owner, checkpoint, briefs, delegate |
| tmux session | one per lane | Your shell in the worktree; never the agent's |
| App services | systemd units per lane | The lane's running copy of the app, on its own ports |

## Data

The six core tables, three notification transport tables and hashed owner-session table live in SQLite (`node:sqlite`, WAL). Lane state and work remain event-derived.

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
| `env.status`, `check.result`, `checkpoint.created` | Runtime and checker |
| `helper.delegated` | The local helper did work, with tokens saved |
| `usage` | Context window use reported by the agent |
| `agent.command`, `agent.command.result` | Durable owner controls and host acknowledgements |
| `agent.session`, `agent.turn`, `agent.error` | Reported settings, active prompt IDs and failures |
| `notification.sent`, `notification.failed` | Delivery evidence; never permission decisions |

## Interfaces

**HTTP** (loopback; Tailscale Serve in front):

| Route | Purpose |
|---|---|
| `GET /api/health` | Version and host |
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
| `GET /api/inbox`, `POST /api/answers` | What waits on you, and your answer |
| `GET /api/stream` | Global event stream for the Inbox |
| `GET /api/notifications` | Public notification configuration and VAPID public key, with no credentials |
| `POST /api/push/subscriptions`, `DELETE /api/push/subscriptions` | Register or remove this browser's push endpoint |

**Lane host socket** (`<data>/lanes.sock`, JSON lines):
- host → daemon: `{"hello":"<lane>"}`, then `{"eventId":"<uuid>","event":{"type":"...","payload":{...}}}`.
- daemon → host: `{"ready":true}`, durable `{"commandId":"<uuid>","command":{"kind":"prompt|answer|cancel|mode|model",...}}` and `{"ack":"<eventId>"}`.
- The host retains observations until acknowledged; `(lane, source_id)` deduplicates replay in SQLite without seq gaps. Commands are `agent.command` events, pending until `agent.command.result`. The surviving host suppresses repeated command IDs. Permission answers are validated against the outstanding request and recorded with their command in one transaction.
- Only the daemon writes owner decisions and commands. The socket is mode 0600; host observations cannot forge `permission.answered`, user messages or lane transitions. New permission events move the lane to `needs_you`; the final pending answer moves it back with a `lane.state` event.

`[lanes].launchHosts` defaults to true. `[agents.<name>]` overrides the ACP command, argument array and environment; `[lanes.host]` and `[lanes.toolbox]` override workspace entry points. Defaults use absolute Node/script paths, so systemd does not depend on package binaries being globally linked. The host reconnects while holding the same agent process and ACP session. Agent failures become events; the host does not restart the task automatically.

**Agent toolbox** (MCP): `env_status`, `env_start`, `get_logs`, `preview_url`, `ask_owner`, `checkpoint`, `get_brief`, `delegate`.

**CLI:** `status`, `lanes`, `lane start`, `term`, `inbox`, `answer`, `arch`, `setup`.

**Terminal wire:** browser messages are validated `TerminalInput` values: `{"type":"input","data":"..."}` or `{"type":"resize","cols":100,"rows":30}`. Output is raw UTF-8 terminal text. The server starts at 80×24 and xterm sends its fitted size on connection and resize (1–500 columns, 1–200 rows). Input messages are bounded; a slow browser is disconnected rather than buffering indefinitely. Reconnect attaches to the existing session; tmux copy mode retains older history. Terminal I/O does not mutate lane state or create agent events.

The native PTY module loads only inside `Runner.terminal`, when attachment is requested. Its build or load failures are contained by the terminal route and cannot prevent daemon startup.

## Security

- The daemon binds `127.0.0.1`. Remote access is Tailscale Serve, which adds `Tailscale-User-Login`; a login that is not the configured owner gets 403. Before claim, application APIs are closed. After claim, requests without identity headers need a valid owner session or loopback hostname with `access.allowLocal` on. Unrelated hostnames cannot use local authorization.
- Terminal upgrades run through the same identity checks. Browser origins must match the request host; non-local browser hostnames additionally require owner authorization. This rejects cross-origin shell access and DNS rebinding. Non-browser clients may omit Origin. Daemon configuration rejects other bind addresses; Vite development and preview also bind loopback.
- Agents never approve their own permissions or recipes. Answers come only through `/api/answers`.
- Notification action bearers grant exactly one recorded lane/request/option, not general API access. A conflicting Tailscale owner is still refused. Telegram callbacks additionally require the configured sender and chat. Replays cannot answer twice; no action expiration, quiet-hour timer or delivery retry supplies an answer. Push subscriptions and action hashes are private; database files use mode 0600.
- Previews are reachable on the tailnet only; nothing listens on `0.0.0.0`.
- Cleanup never deletes unpushed commits.

**Notifications:** the daemon observes pending request events, records `notification.sent` / `notification.failed`, and retries deferred work after quiet hours and on restart. ntfy and Telegram use injected HTTP fetch; Web Push uses an injected VAPID transport. Telegram polls outbound and persists its cursor; it never needs an inbound public bot webhook. Provider credentials remain in configuration and are excluded from public status routes.

## Setup and installation

The daemon serves the built `apps/web/dist` SPA as well as `/api`; unknown API routes never become HTML. Static paths are confined to that directory, assets are immutable and the service worker is not cached. Live event streams end during `preClose`, so a browser cannot hold a daemon restart open. Host startup refuses an active lane socket or non-socket path; only stale sockets are removed.

`SetupManager` writes validated configuration atomically with mode 0600, then applies it to the running managers. Saved projects are re-registered idempotently at startup, and notifier changes close the old transport before starting the new one. Commands remain injected through `Runner`, including agent status/install, Git validation and Tailscale Serve. Model probes are loopback-only and reject redirects.

A random code in `<data>/claim-code` (0600) authorizes the first owner claim. The public API never returns the code; the local CLI prints it. Claim is serialized and consumes the code after saving an owner identity or verified passkey. WebAuthn verification uses pinned SimpleWebAuthn, single-use five-minute challenges bound to origin/RP, user verification and persisted counters. Counters cannot move backwards. Thirty-day random session cookies are HttpOnly/SameSite Strict and Secure over HTTPS; only hashes are stored. These authentication expirations never answer agent permissions. Passkeys registered on localhost work on that RP only; the wizard links the Tailscale node owner for phone access.

`install.sh` bootstraps a new checkout, builds and invokes the installer entry point. The installer writes an absolute-Node user unit and executable wrappers; it refuses to replace unrelated files and never stops lane hosts. Normal installation needs systemd user services, Node, npm, Git and tmux. A failed optional native terminal build does not prevent the daemon from starting.

## Decisions

| Decision | Why |
|---|---|
| TypeScript everywhere | Every borrowed SDK has TypeScript (ACP, Claude Agent SDK, Codex SDK, CodeGraph, Playwright); one language for daemon, host, CLI and web |
| `node:sqlite` instead of a native database module | No extra native database dependency; same SQL. `better-sqlite3` can replace it behind `Store` if needed |
| ACP for every agent | One client for Claude Code, Codex, OpenCode and more; native SDKs only as a fallback |
| One lane host per lane under systemd | Agents survive daemon restarts and upgrades |
| tmux for terminals | Persistent, attachable from the browser and any terminal |
| Subdomain per lane service | Paths break single-page apps and hot reload |
| Local helper as an MCP tool | Works with subscription logins; Claude Code cannot route subagents to other providers |
