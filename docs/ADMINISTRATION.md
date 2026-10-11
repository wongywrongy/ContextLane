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

The recipe fixture derives its loopback/API/HMR ports and allowed tailnet host from Rootlane-provided environment variables, without reading private config. Legacy config-profile fixtures retain their existing fallback ports. Native executables must exist on the host and be readable inside the controller's mounts for preflight checks. Containers do not supply dependencies to host applications.

## MCP and HTTP contracts

Both adapters expose the fifteen tools listed in the README. Inputs use strict shared schemas. Start/stop take environment IDs and caller-generated UUID request IDs; mutation commands, unit names and URLs are not accepted from callers. Read-only locate accepts a bounded absolute cwd; request_environment validates a checkout recipe and records a non-approving owner review; cookie sessions and CSRF are required to approve.

Retry a timed-out mutation with the same request ID and payload. Reuse with a different payload fails. Start/stop return a durable operation handle; poll `get_environment` for completion. An accepted start is not application readiness or preview availability.

Lists and journals are bounded and paginated. Logs come only from recorded owned invocations; avoid secrets in application output. MCP uses a separate bearer credential over loopback and permits absent Origin while rejecting invalid supplied Origin. Standard tool annotations and client approval settings do not replace backend ownership checks.

`list_checks {projectId}` reads existing histories for the project and its checkouts, grouped by subject and kind, with 30 retained results per subject. It does not run probes. `list_events {projectId, limit}` reads the newest recorded listener, route, agent and pass/fail-change observations (at most 50; 500 retained globally). The detail panel merges these observations with lifecycle and publication `list_operations` results. These records establish observations and Rootlane operations, never transcripts or inferred activity. Route and readiness results use existing observation cadence; HTTP probes stay scoped to the open panel and its existing 30-second cache.

[Codex example](../deploy/codex-mcp.example.toml) and [Claude Code example and tool policy](../deploy/claude-mcp.example.md) use an explicitly replaceable Docker adapter path. Allow only the fifteen documented tools and keep normal approvals. Claude user scope makes the service available across projects; avoid competing scope definitions. Verify actual Rootlane tool discovery and calls, not saved configuration, launcher source text or list_mcp_resources. Rootlane exposes tools rather than resource entries. If a session lacks tools, inspect the local client’s /mcp errors and reconnect or start a fresh session; a hosted chat may not expose local stdio configuration. Rootlane lists known project links; it does not grant GitHub/Render API access or rewrite application URLs or payment callbacks. There is no remote MCP endpoint or agent-session orchestration.

## Failure and recovery

SQLite records ownership, intent, resource reservations and request mappings, not proof of runtime health. Systemd/listener/readiness observations carry timestamps. Start failure rolls back only resources created by that operation; preview failure retains a healthy application and reports unavailable routing.

Stop requires recorded unit ownership and matching upstream routes, verifies teardown, and retains reservations when cleanup fails. It never kills by port, command-name matching or loose PID attribution. Ownership changes are conflicts, never forced replacements. Startup reconciliation preserves healthy owned applications, handles interrupted operations and does not recreate development environments after host reboot.

If host observation is unavailable, catalog reads can continue while mutations remain blocked until successful reconciliation. Rootlane shares a host route lock across lifecycle and independent publication. Bounded Unix-socket Serve requests require ETag/If-Match and fail closed on missing guards or concurrent changes. The local API is version-sensitive; inspect conflicts before retrying. Never use a global Serve reset.

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

## Agent observations

Rootlane scans same-user native Codex and Claude process metadata when the catalog refreshes. It reads executable identity, process start time and working directory, not command arguments, environments, prompts or transcripts. Working directories must resolve inside observation roots and a known project or Git worktree. Rootlane does not infer project associations from a parent project-root directory.

Detected process rows are separate from owner registrations. Each scan has a two-second budget, an 8,192-process entry limit and a 128-observation limit. Permission failures and limits appear in discovery notices; unknown associations contribute an unassigned count without exposing their directories. These observations are not persisted and disappear after an expired catalog refresh when the process exits. Native helper processes can be included; process counts are not session counts or evidence of active work. Generic Node wrappers and remote agents are unsupported.

## Independent preview targets

Publication approves an existing service, independently of `profiles`. Example owner configuration (replace paths and hostname; check the HTTPS port is unused):

```json
"previewTargets": [{
  "id": "disposable-web", "approved": true,
  "projectPath": "/home/owner/code/rootlane",
  "checkoutPath": "/home/owner/code/rootlane/fixtures/disposable",
  "serviceId": "web", "serviceName": "Disposable frontend",
  "port": 19482, "httpsPort": 19484,
  "readiness": { "path": "/", "status": 200, "bodyIncludes": "rootlane-disposable-frontend", "timeoutMs": 15000 }
}]
```

Paths resolve within observation roots. Operator ports, application ports and profile route reservations cannot overlap target HTTPS ports. Publication requires a live attributable listener within the approved checkout, bound only to `127.0.0.1` and/or `::1` by one attributable process. The application port is deliberately neither reserved nor adopted by Rootlane. Start the disposable API/frontend separately before publishing. Never approve infrastructure, databases or arbitrary discovered services.

`get_capabilities {}` distinguishes observed support from unverified write/lifecycle permissions. `get_project {projectId}` returns checkout associations, known services, agent sources, links, approved targets and recorded previews. `publish_preview {targetId, requestId}` records durable intent and reserves HTTPS before changing the host; inspect `get_preview {previewId}` for the latest operation, actual routing, upstream readiness and verified HTTPS. `unpublish_preview {previewId, requestId}` removes only the recorded matching route and leaves the upstream running. Neither mutation accepts caller-provided ports, paths or URLs.

Request IDs share collision protection with lifecycle actions. Repeated publication returns the recorded preview and operation. Changed target configuration requires explicit unpublication first. Removed approval blocks new publication but recorded route removal remains available. Interrupted publication never recreates a route. Interrupted removal resumes only against recorded ownership; uncertain removal retains its reservation. Missing and conflicting routes are observations, never automatic repairs.

The guarded Serve API follows [Tailscale's official local client](https://raw.githubusercontent.com/tailscale/tailscale/main/client/local/serve.go), which documents ETag conditional writes and labels this API unstable. Missing guards block changes. Foreground routes and unrelated Serve configuration are preserved.


## Config reload and recipes

Edit private config on the host and run `deploy/rootlane-reload` from the installation; SIGHUP or the ten-second mtime check validates through loadConfig. Validation errors keep the previous config and appear in status/capabilities. Existing recorded resources are preserved; changed profile revisions still require Stop before Start. Backend port, origin/aliases, tailnet hostname and state-directory changes need restart. Rerun setup and recreate the container to change mount paths. `deploy/preflight-docker` checks capabilities in the container rather than assuming host path visibility.

`instancePorts` defaults to `[20000,20999]` (at most 1000 ports). Recipes reserve application and HTTPS ports through the existing reservations table. See [recipe format and owner approval](RECIPES.md). The former proposal tools are replaced by request_environment; previewPortRange remains accepted for old configs but is no longer used. Config is never written by tools.

`editorUrlTemplate` accepts vscode, vscode-insiders, cursor, zed and jetbrains schemes and `{host}` / `{path}` placeholders. Without it paths render as plain text with Copy. Agents should call locate with their working directory first; the result includes attributable service names and both managed and independently recorded preview URLs. No argv or environment values are returned. list_operations returns at most twenty recent operations with their backend error codes.
