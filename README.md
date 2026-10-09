# Rootlane

Private project discovery and a durable development-environment controller for neo. One Fastify process serves React and authenticated HTTP; the local MCP adapter forwards the same five operations to that process.

**Implementation status: first slice works on neo; final deployment checks remain.** The normal gate passes all 30 tests. Real discovery, browser login, native systemd start/readiness/logs/stop, Tailscale preview/API/HMR, failure rollback, restart reconciliation and stopped-state backup restore passed. Installed Codex and Claude Code each completed the same managed lifecycle through MCP. Test-owned resources were removed and existing routes were preserved. Release v0.1.3 is installed with Docker Compose at `/opt/stacks/rootlane` on neo. Second-device access and exact mockup matching remain pending. See [verification](VERIFICATION.md).

On neo, open [Rootlane](https://root.avlis.dev). The original Tailscale HTTPS address also remains available. Owner login is required; existing projects are observe-only.

## Downloadable Docker release

A compiled Linux amd64 release with a prebuilt Docker image and Compose setup is available from [GitHub releases](https://github.com/wongywrongy/rootlane/releases). Follow [the folder deployment instructions](deploy/RELEASE.md). This optional packaging was explicitly requested after the original host-native implementation; it connects to existing user systemd and Tailscale rather than managing applications through Docker.

## Build and checks

Node 24 LTS is required (observed: 24.11.0). Exact compatible direct versions are in `package.json` and `package-lock.json`; installation and the local gate passed on Node 24.11.0. Fastify is pinned to patched version 5.12.5; installation reports zero known vulnerabilities. The MCP client dependency is test-only.

```sh
npm ci
npm run check
```

The gate checks server, browser and test TypeScript, builds the compiled backend/static frontend, then runs focused Node tests. Tests use temporary SQLite files and controlled host adapters; discovery tests create real Git worktrees. MCP tests use the real SDK/stdio transport against a temporary authenticated backend, in legacy and modern modes.

better-sqlite3 is a required native installation dependency. Verify installation and database/backup tests on Node 24.11.0 and neo's architecture. Do not suppress a native-binding failure or substitute Node's experimental SQLite API. If this pinned release lacks a compatible shipped binary, review its source-build instructions and install the required Python/make/C++ toolchain as an owner administration step. A successful npm metadata lookup is not native-binding verification.

On 2026-10-09 the owner removed `dev-test` and explicitly authorized direct checks on neo. Follow the current owner policy on any other installation; do not assume this exception applies elsewhere.

## Owner configuration

`deploy/config.example.json` contains only the explicitly approved disposable fixture. It uses API 19481, Vite 19482, preview HTTPS 19484, backend 9480 and Rootlane HTTPS 19483. These fixed ports passed read-only preflight on 2026-10-09; availability must be rechecked immediately before launch. There is no automatic port increment or route takeover.

After the gate passes, install a mode-0600 copy of this configuration outside observation roots at `/home/kyle/.config/rootlane/config.json`. Keep its directory private. Review paths and executable locations before installation. Rootlane validates owner permissions, canonical observation boundaries, dependencies and port assignments.

Create two distinct random credentials, preferably 256-bit generated values, in mode-0600 files `owner.credential` and `agent.credential` in that same private directory. An owner-selected credential may be 1–256 characters; the agent credential still requires at least 32 characters. Short or predictable owner credentials provide less resistance to guessing. Keep them out of the repository and shell history. `openssl rand -hex 32` can generate each credential directly into its private file. The service reads their paths from the environment variables in `deploy/rootlane.service`; credential values are not unit arguments.

The state directory is `/home/kyle/.local/state/rootlane`, mode 0700, outside discovery roots. It contains the SQLite database/WAL and lifetime instance lock. The database stores ownership, intent, invocation IDs, request mappings and bounded failure snapshots, not executable arguments, process environments or agent prompts. SQLite rows do not establish runtime health.

Profiles are executable authorization supplied by the owner, not discovered repository scripts. This is a single-owner workflow boundary, not a sandbox against other code running as kyle. Avoid secrets in application logs; only bounded logs from owned invocations are exposed.

## Host preflight and installation

After configuring the environment, run the read-only check before any install:

```sh
ROOTLANE_CONFIG=/home/kyle/.config/rootlane/config.json node dist/host/preflight.js
```

It checks user systemd, Tailscale identity/configuration and candidate ports. It changes no units or routes and does not establish second-device reachability.

`deploy/rootlane.service` is the proposed user service; it has not been installed or enabled. Its compiled backend binds to 127.0.0.1. Install/enable this unit only after checks pass. Rootlane-managed transient fixture units are separate from the backend service and survive backend restart. Existing projects are never adopted.

Rootlane's own HTTPS route is an installation step, separate from managed fixture previews. Immediately recheck that HTTPS 19483 has no TCP/Web/Funnel configuration and no conflicting listener. Only when it is unused, add the dedicated mapping `tailscale serve --bg --https=19483 http://127.0.0.1:9480`. Verify the resulting upstream without resetting or rewriting existing routes. Keep the original shared Serve configuration for comparison. Do not run this command on an occupied port.

Open `https://neo.taile1abc7.ts.net:19483/` and exchange the owner credential for a secure, HttpOnly, same-origin session. Plain HTTP browser login is intentionally unsupported. Host and Origin policies must be tested through the actual Tailscale proxy. The local API permits authenticated agent requests with no Origin; an invalid supplied Origin is rejected.

The disposable profile has been exercised with real user-systemd units under the owner's direct-test authorization. User-systemd services do not inherit a test launcher's cgroup; account for this explicitly if a limiter is introduced again. Existing applications remain observe-only.

## HTTP and MCP

`POST /api/tools/{name}` exposes exactly `list_projects`, `get_environment`, `start_environment`, `stop_environment`, and `get_logs`. Both adapters use strict shared Zod contracts. Mutations take `environmentId` and UUID `requestId`; no command/path/unit/URL input is accepted. Reuse the request ID after a timeout. Reuse with another payload fails. An accepted operation is not readiness success; poll `get_environment`.

Browser requests use session cookies and the CSRF token obtained from `/api/session`. MCP uses a separate bearer credential on loopback. `/api/status` returns backend, lifecycle availability and independently observed Tailscale connection state. Results are paginated; journal reads return bounded tails and a cursor for subsequent output, not unlimited history.

Install `deploy/rootlane-mcp` as an executable owned by kyle at an absolute path. It loads the private agent credential into its launch environment and executes the pinned local compiled adapter. It does not start a backend, open SQLite or manage resources. Stdout is exclusively SDK protocol traffic.

A reviewable Codex entry is in `deploy/codex-mcp.example.toml`. For Codex, configure that absolute command in a single `mcp_servers.rootlane` entry, with only these five `enabled_tools`, a short startup timeout and a tool timeout sufficient for a bounded read (start/stop return immediately). Keep normal approvals; record the effective per-tool policy during acceptance. Do not use blanket bypasses.

For Claude Code, the entry is in `deploy/claude-mcp.example.json`. Register it with `claude mcp add --transport stdio --scope user rootlane -- /home/kyle/.local/bin/rootlane-mcp` after installation. Register the same executable as `rootlane` in **user** scope; avoid competing local/project entries. Keep credentials out of `.mcp.json`. The five tools have descriptions and truthful annotations; no custom search, always-interactive metadata or agent-session SDK is required.

Do not claim compatibility from saved settings alone. Run real discovery and tool calls from the installed clients using the procedure in [VERIFICATION.md](VERIFICATION.md). Current client setup references: [Codex MCP](https://developers.openai.com/codex/mcp), [Claude Code MCP](https://code.claude.com/docs/en/mcp), [SDK protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions).

## Failure, recovery and backups

Resource intent and request mappings precede side effects. Start rolls back only resources created by that operation; a healthy app survives preview failure. Stop requires recorded unit ownership and an exact matching route, verifies teardown, and preserves reservations when cleanup fails. Route conflicts also retain upstream-port reservations to prevent an old route from being redirected into a different environment.

A backend restart reconciles observed units and routes without recreating applications. An interrupted partial start is cleaned up when unhealthy; healthy owned applications survive. An interrupted stop resumes its recorded intent. If host observation is unavailable, the catalog can still load but mutations stay blocked until reconciliation succeeds on a subsequent restart. Changed ownership is a visible conflict, never forced cleanup.

Back up using SQLite's backup API:

```sh
npm run backup -- /home/kyle/.local/state/rootlane/rootlane.sqlite /absolute/new-backup.sqlite
```

The destination must not exist. Restore only with Rootlane stopped, into a private state directory, preserving the installation identity. Do not run two instances from copies of the same state. The focused restore test checks ownership and operation IDs in a backup; real stopped-service restore and subsequent reconciliation also passed on neo.

Shared Serve state has no cross-operator compare-and-swap in this implementation. Rootlane serializes its own writes, rechecks ownership immediately before them and verifies results, but an operator can still race a CLI update. Avoid simultaneous manual edits on Rootlane's reserved ports; mismatches remain conflicts. No global reset is used.
