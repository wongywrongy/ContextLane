# Rootlane

A private, self-hosted workspace for your projects, worktrees, development environments, coding agents and useful links.

- Discover nested projects to depth three and Git worktrees, stopping at repositories and manifests.
- See observed services, detected Codex/Claude processes, registered agents and known preview links in one place.
- Publish approved running loopback services through the browser or MCP without owning their processes.
- Start and stop owner-reviewed environments with logs, recipe approval and operation history.

Existing projects are **observe-only**. Rootlane controls only resources it owns.

## Install

Requires Linux amd64, Docker Compose 2.15+, Node 24 for setup, a running user-systemd manager and connected Tailscale. Review the host mounts and permissions in the [installation guide](deploy/RELEASE.md) first.

Build the checked-out 0.7.0 source and image as the installation owner:

```sh
npm ci
npm run check
node deploy/setup.mjs "$HOME/code"
docker compose up -d --build --wait
deploy/preflight-docker
docker compose exec -T rootlane node deploy/serve.mjs
```

Replace `$HOME/code` with your project root. Setup derives your user, home directory and Tailscale hostname; it creates private configuration and separate owner/agent credentials. No launch profiles are enabled automatically.

Open the HTTPS URL printed by the final command. Unlock with your private `~/.config/rootlane/owner.credential` file. For an existing installation, follow the [upgrade instructions](deploy/RELEASE.md#upgrades).

## Connect Codex or Claude Code

Run on the same host as Rootlane, as the installation owner. These commands use the installation above:

```sh
codex mcp add rootlane -- "$HOME/stacks/rootlane/deploy/rootlane-mcp-docker"
```

```sh
claude mcp add --transport stdio --scope user rootlane -- "$HOME/stacks/rootlane/deploy/rootlane-mcp-docker"
```

For another directory, such as `/opt/stacks/rootlane`, substitute its absolute adapter path. Restart your coding session and ask:

> Call Rootlane locate with your working directory first. Do not start or stop anything.

The adapter reads its private agent credential inside the running container. Keep normal tool approvals; never put credential values in client configuration. **Settings → MCP setup** covers tool permissions, troubleshooting and an optional agent setup prompt. Rootlane currently supports local stdio, not a remote `/mcp` endpoint.

Agent detection uses bounded same-user native and npm Node/Bun process metadata, start times and the closest checkout. “Detected process” does not establish a task or active session. Wrapper/child pairs count once; remote agents are not detected; unassigned processes appear in discovery notices.

## MCP workflows

The fifteen MCP tools share the same authenticated backend: `list_projects`, `get_project`, `get_capabilities`, `get_environment`, `start_environment`, `stop_environment`, `get_logs`, `publish_preview`, `get_preview`, `unpublish_preview`, `locate`, `request_environment`, `list_operations`, `list_checks`, `list_events`.

| Intent | Workflow |
|---|---|
| Observe | `locate {path}` → `get_project {projectId}` or `get_environment {environmentId}` as needed. No approval or lifecycle mutation. |
| Publish a running service | `locate` → `get_capabilities` and identify an approved target → `publish_preview {targetId, requestId}` → poll `get_preview {previewId}`. |
| Start a managed environment | `locate` → `request_environment` and owner review at `approvalUrl` when required → `start_environment {environmentId, requestId}` → poll `get_environment`. |

`path` is an absolute host directory. `projectId` comes from `locate.project.id` or `list_projects.projects[].id`; checkout IDs identify directories, not managed environments. `environmentId` comes from `locate.environments[].id`, `locate.instances[].id`, or `request_environment.resolvedPreview.instanceId`. `targetId` comes from approved target IDs in `locate`, `get_project`, or capability approval scope. Use the independent `previewId` returned by `publish_preview` or `get_project.previews[].previewId` for `get_preview` and `unpublish_preview`; managed route IDs in `locate.previews` are not independent publications.

Start, stop, publish, and unpublish return durable operations with an operation UUID. Poll the corresponding environment or preview status tool; `list_operations` lists recent operation history. Use a new request UUID for a new action and preserve the same UUID **and payload** when retrying a timeout or connection failure. A failed durable operation remains the result for that request ID; after correcting its cause, submit a new action with a new UUID. For a failed independent publication, inspect and unpublish its recorded preview before publishing again. Approval requests return a review, not a lifecycle operation.

Publication changes only its reserved route; unpublishing leaves the application running. A URL can be returned before verification: inspect route, upstream, and HTTPS states separately, and share it as verified only after HTTPS succeeds. Missing or changed routes are reported after restart and never recreated automatically.

Connection failure (`BACKEND_UNAVAILABLE`), timeout (`BACKEND_TIMEOUT`), and malformed/schema-invalid responses (`BACKEND_INVALID_RESPONSE`) are distinct. Check the existing service and matching adapter version before retrying. Invalid inputs require the documented schema and returned IDs; approval requires owner review; route conflicts must preserve unrelated mappings; unready upstreams require checking the application. No adapter error includes raw transport exceptions or credential values.

The owner approves `previewTargets` independently of launch profiles in private host configuration. See [configuration](docs/ADMINISTRATION.md#independent-preview-targets). Discovery and an observed listener grant no approval. The dashboard loads checkout, service, route and agent details in a dialog through the three-dot menu, one project at a time.

## Recipes and owner approval

Commit `.rootlane.json` at a Git checkout root. An agent calls `locate` with its cwd, then `request_environment {path, requestId}`. Rootlane returns a resolved review and `approvalUrl`. The owner opens that URL, reviews commands, working directories, environment **names**, ports, readiness and setup hints, and confirms Approve. The agent polls `locate`, starts the returned instance ID and polls `get_environment` until Ready and Available. Agents never approve or edit Rootlane configuration. Approval itself does not launch anything.

Each worktree gets its own deterministic instance ID, service ports, HTTPS ports and private state directory. Approval binds the project's Git common directory, recipe SHA256 and the configured/resolved toolchain paths used by that recipe. Recipe or used-toolchain changes require a new review. Stop and recorded logs remain available after a recipe becomes stale. Existing config-file profiles and independent approved preview targets remain supported.

See [recipe format, secrets and migration](docs/RECIPES.md), including the disposable recipe in `fixtures/disposable/.rootlane.json`.

## Host setup and reload

The owner sets `toolchains` (absolute Node/Python executables and per-project venv directories) and `instancePorts`, for example `[20000,20999]`, in private `config.json`. Missing toolchains return `TOOLCHAIN_MISSING`; repository recipes cannot change this map.

```sh
node /opt/stacks/rootlane/deploy/setup.mjs /home/OWNER/code
cd /opt/stacks/rootlane
docker compose up -d --build --wait
deploy/preflight-docker
deploy/rootlane-reload
```

Use your installation's absolute paths. Setup preserves existing config and credentials. It generates read-only binds for observation roots, profile executable directories, toolchain executable directories, full venv directories, and the owner's home (so private `~/…` env files can be read). Configuration and state retain their existing dedicated mounts. Paths under `/etc`, `/root`, `/proc`, `/sys` and `/` are refused. Files outside these mounts are unavailable in Docker; keep recipe env files in the owner's home outside observation roots. When mounts or toolchains change, rerun setup and recreate the container before reload.

Reload sends SIGHUP to the container or native user service. Config is also checked every ten seconds; invalid config retains the last valid config and exposes an error. Origin, tailnet hostname, state-directory and backend-port changes require a restart. Rootlane never writes owner config. Settings remains read-only; recipe approval/rejection is the owner review action in Projects.

Set `editorUrlTemplate`, for example `vscode://vscode-remote/ssh-remote+{host}{path}`, to enable editor links; otherwise paths have Copy.

## Development

For source development, use Node 24.11+ within the 24 LTS series:

```sh
npm ci
npm run check
```

Host acceptance is explicitly opt-in and controls only the disposable fixture using isolated config and state:

```sh
ROOTLANE_HOST_ACCEPTANCE=1 npm run host:acceptance
```

It checks recipe request, owner cookie/CSRF approval (and agent rejection), real HTTP start/readiness/HTTPS/HMR/logs/stop, locate, config reload and exact Serve restoration. Allocation skips occupied ports. Second-device preview/HMR, reboot and SSH-disconnect acceptance still require the owner.

The gate runs TypeScript checks, builds the UI/backend and tests lifecycle, discovery, authentication and MCP behavior. SQLite uses `better-sqlite3`; source builds may require Python, make and a C++ compiler.

## Documentation

- [Installation and upgrades](deploy/RELEASE.md)
- [Configuration, native installation, backups and ownership](docs/ADMINISTRATION.md)
- [Actual verification results and remaining acceptance checks](VERIFICATION.md)

Rootlane is a trusted, single-owner Linux host controller. The current release has been tested on one Linux amd64 host; other installations require their own acceptance checks.
