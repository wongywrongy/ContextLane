# Administration

Rootlane uses one backend for the browser and local MCP adapter. Owner configuration authorizes executable profiles; discovery never authorizes repository scripts.

## Configuration

Docker setup creates `~/.config/rootlane/config.json` and separate `owner.credential` / `agent.credential` files, mode 0600 in a private mode-0700 directory. State lives in `~/.local/state/rootlane`, outside observed project roots. Review [the configuration example](../deploy/config.example.json); replace every example path and hostname before using it. Its disposable profile is unapproved until you explicitly review it.

Configure bounded project/observation roots, canonical HTTPS origins and reviewed launch profiles. Profiles declare working directories, executable/argument arrays, fixed ports, dependencies, bounded readiness checks, previews, effects and data requirements. Git worktrees outside project roots must remain within observation roots. Known project links and agent registrations are explicit owner metadata, not inferred tasks or progress.

Keep configuration outside agent-writable checkouts. This is an owner workflow boundary, not a sandbox against code running as the same Unix user. Do not automatically install project dependencies, migrate/seed databases or adopt existing services.

Setup generates independent 256-bit random credentials. An owner-selected credential may contain 1–256 characters; the agent credential must contain at least 32 characters and differ. Short owner credentials reduce guessing resistance. Keep values out of shell history, commits and logs. Login is limited to ten attempts per sliding minute across operator origins, persisted across restarts. Sustained attempts can temporarily block new logins; existing sessions remain usable.

Browser access requires HTTPS, a secure HttpOnly same-origin session and CSRF validation. Host and supplied Origin must match an allowed operator origin. Additional proxy origins belong in `additionalOrigins`; configure the existing proxy separately. Tailnet access alone is not operation authorization.

## Native installation

Docker is the primary documented installation. A compiled native installation is also possible; never run both backends against the same port/state.

From a source checkout, after `npm ci` and `npm run check`, create private configuration/state and credentials as above. Run the read-only preflight:

```sh
ROOTLANE_CONFIG="$HOME/.config/rootlane/config.json" node dist/host/preflight.js
```

It checks user systemd, Tailscale identity/configuration and candidate ports without changing units/routes. Edit [the user-service template](../deploy/rootlane.service) with your absolute checkout and Node executable paths before installing it under `~/.config/systemd/user/rootlane.service`. The Node executable must satisfy the package's engine requirement; user-systemd PATH may differ from your shell.

```sh
systemctl --user daemon-reload
systemctl --user enable --now rootlane.service
```

Publish only a separately checked Rootlane HTTPS port. The guarded helper preserves conflicting Serve configuration:

```sh
ROOTLANE_CONFIG="$HOME/.config/rootlane/config.json" \
ROOTLANE_AGENT_CREDENTIAL_FILE="$HOME/.config/rootlane/agent.credential" \
node deploy/serve.mjs
```

The native `deploy/rootlane-mcp` wrapper resolves its release directory, reads `ROOTLANE_CONFIG` and `ROOTLANE_AGENT_CREDENTIAL_FILE` (defaulting to the owner locations above), and runs Node from PATH. Register its absolute path instead of the Docker wrapper. Keep it executable and ensure the client's PATH contains the correct Node version. It forwards authenticated loopback calls and never starts a backend.

## Reviewed disposable profile

The sample profile has no database or persistent application data. Review its paths, installed Node/Vite, application ports 19481/19482 and preview HTTPS 19484 before setting `approved: true`. These numbers are examples, not evidence of availability on your host. Rootlane defaults to backend 9480 / operator HTTPS 19483; conflicts are reported rather than taken over.

The fixture's Vite configuration reads the owner's Rootlane configuration for its Tailscale hostname. Its strict loopback binding, API proxy and HMR settings target the sample ports. If you change sample ports, update both the reviewed profile and Vite configuration. Native executables must exist on the host and be readable inside the controller's mounts for preflight checks. Containers do not supply dependencies to host applications.

## MCP and HTTP contracts

Both adapters expose `list_projects`, `get_environment`, `start_environment`, `stop_environment` and `get_logs`. Inputs use strict shared schemas. Start/stop take environment IDs and caller-generated UUID request IDs; commands, paths, unit names and URLs are not accepted from callers.

Retry a timed-out mutation with the same request ID and payload. Reuse with a different payload fails. Start/stop return a durable operation handle; poll `get_environment` for completion. An accepted start is not application readiness or preview availability.

Lists and journals are bounded and paginated. Logs come only from recorded owned invocations; avoid secrets in application output. MCP uses a separate bearer credential over loopback and permits absent Origin while rejecting invalid supplied Origin. Standard tool annotations and client approval settings do not replace backend ownership checks.

[Codex example](../deploy/codex-mcp.example.toml) and [Claude Code example](../deploy/claude-mcp.example.json) use an explicitly replaceable Docker adapter path. Allow only the five tools and keep normal approvals. Claude user scope makes the service available across projects; avoid competing scope definitions. Verify actual Rootlane tool discovery and calls, not saved configuration, launcher source text or list_mcp_resources. Rootlane exposes tools rather than resource entries. If a session lacks tools, inspect the local client’s /mcp errors and reconnect or start a fresh session; a hosted chat may not expose local stdio configuration. Rootlane lists known project links; it does not grant GitHub/Render API access or rewrite application URLs or payment callbacks. There is no remote MCP endpoint or agent-session orchestration.

## Failure and recovery

SQLite records ownership, intent, resource reservations and request mappings, not proof of runtime health. Systemd/listener/readiness observations carry timestamps. Start failure rolls back only resources created by that operation; preview failure retains a healthy application and reports unavailable routing.

Stop requires recorded unit ownership and matching upstream routes, verifies teardown, and retains reservations when cleanup fails. It never kills by port, command-name matching or loose PID attribution. Ownership changes are conflicts, never forced replacements. Startup reconciliation preserves healthy owned applications, handles interrupted operations and does not recreate development environments after host reboot.

If host observation is unavailable, catalog reads can continue while mutations remain blocked until successful reconciliation. Rootlane serializes its own route writes, rechecks ownership and verifies results, but another operator can still race shared Serve changes. Avoid simultaneous manual edits on reserved ports. Never use a global Serve reset.

## Backups

Use the SQLite backup API rather than copying an active database/WAL:

```sh
npm run backup -- "$HOME/.local/state/rootlane/rootlane.sqlite" /absolute/new-backup.sqlite
```

For Docker:

```sh
docker compose exec -T rootlane node dist/state/backup.js \
  /absolute/state/rootlane.sqlite /absolute/state/new-backup.sqlite
```

Use paths within the mounted state directory. The destination must not exist. Stop Rootlane before restoring into private state, preserve installation identity and never run two instances from copies of the same state. Validate restore and reconciliation on your installation. See [verification](../VERIFICATION.md) for historical host checks and remaining acceptance work.
