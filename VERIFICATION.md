# Verification record — 2026-10-09

## Observed directly in this session

| Component | Observed |
| --- | --- |
| Hostname | neo |
| Node | v24.11.0, command at `/home/kyle/.local/bin/node` |
| npm | 11.6.1 |
| Codex | codex-cli 0.162.0 |
| Claude Code | 2.1.295 |
| Tailscale | 1.102.1 |
| systemd | 255; local help includes `--expand-environment` |
| Starting checkout | Empty except environment metadata; no approved UI artifact |

The discovery report at `/home/kyle/code/DEV_PLATFORM_DISCOVERY.md` is historical host evidence. The new catalog was subsequently executed against neo; its observed results are recorded below.

## Verified after reviewed escalation

The initial commands failed inside the sandbox, rather than because neo lacked the capabilities. Reviewed escalation succeeded for npm, the required `dev-test` launcher, user systemd and Tailscale observation. The earlier blocked-only report was premature.

- Installed the pinned dependencies and generated `package-lock.json`. The initial Fastify 5.6.1 pin had reported vulnerabilities; updated it to compatible patched 5.12.5. npm reports zero known vulnerabilities.
- `dev-test -- npm run check` passed after that update: all server/browser/test TypeScript checks, production build and **25/25 tests**.
- Native better-sqlite3 loads and its database/backup/restore tests pass on Node 24.11.0.
- Real SDK stdio tests pass for both modern 2026-07-28 and legacy initialize traffic, including tools/list, calls, strict schemas, duplicate requests and harmless adapter disconnect. Installed-client acceptance is recorded separately below.
- Rootlane's read-only host preflight passes. Tailscale identity is `neo.taile1abc7.ts.net`; ports 9480, 19483, 19481, 19482 and 19484 were unused at the time of the check.
- Real discovery returned **16 project/worktree entries**, including **11 with Git metadata** and **4 with associated listeners**. Every observed runtime remains observe-only. Eight out-of-root/unavailable worktree warnings were returned rather than accessing those paths.
- At this initial checkpoint, no service was installed/enabled, no fixture was launched, and no route was changed. Subsequent temporary real-host checks are recorded below.

The build emitted two non-fatal Rollup warnings about Zod pure-comment annotations; it completed successfully.

## Test coverage passed

Focused tests cover real Git/non-Git discovery with detached and out-of-root worktrees; configuration boundaries; strict HTTP schemas, sessions, Origin/Host, CSRF and credentials; duplicate/concurrent starts and cross-environment reservations; readiness failures; partial startup rollback; preview-only failure; changed unit/route ownership; failed stops and retained reservations; interrupted start/stop/reboot reconciliation; bounded response/log contracts; lifetime backend locking; SQLite backup restore; real SDK stdio discovery/calls and disconnect for modern and legacy eras.

Lifecycle effects use fake host adapters. They do not establish real Linux/Tailscale lifecycle acceptance.

## Client/protocol matrix

| Client/path | Version or protocol | Discovery | Actual tool calls |
| --- | --- | --- | --- |
| Installed Codex | 0.162.0 | Passed | Real catalog, start, ready/preview, bounded logs, stop and safe rejection passed |
| Installed Claude Code | 2.1.295 | Passed | Real catalog, start, ready/preview, bounded logs, stop and safe rejection passed |
| SDK test client, legacy | v2.3.1; legacy initialize | Passed | Passed |
| SDK test client, modern | v2.3.1; 2026-07-28 pin | Passed | Passed |

Neither installed client was upgraded or persistently reconfigured. Acceptance used temporary per-process configuration. SDK package installation, compilation and both protocol tests are verified. See the [SDK stdio documentation](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio) and [protocol-version documentation](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions).

## Additional real-host acceptance

The owner removed `dev-test` and explicitly authorized direct checks. Earlier backend/client checks ran inside `/devtests.slice`; subsequent native integration checks ran directly under that authorization. No persistent deployment was installed.

- Installed Codex and Claude Code subsequently each started `disposable`, observed succeeded/ready/available status and its usable preview link, fetched bounded API logs, stopped it and observed succeeded/stopped status. Assertions on actual tool events and structured results passed; neither client used another environment.
- The fixture's real Vite HMR WebSocket connected through HTTPS 19484. A temporary source edit generated a `full-reload` notification; the source was restored. This checks local proxy/WebSocket behavior, not a second-device browser update.
- Browser inspection exposed eight identical discovery warnings obscuring the first rows; the UI now displays each identical warning once.
- The compiled backend served the built application and real catalog through temporary Tailscale HTTPS port 19483. Actual socket tests passed for anonymous rejection, invalid Host/Origin, distinct agent authentication, owner login, Secure/HttpOnly/SameSite cookies, CSRF and browser-session invalidation after restart.
- Installed Codex 0.162.0 and Claude Code 2.1.295 each discovered and called all five tools against that backend. Real project listing succeeded; get/start/stop/logs for a deliberately unapproved environment returned `NOT_FOUND`. The temporary configuration initially contained no profiles, so these calls could not launch anything.
- Codex used only the five enabled Rootlane tools, default approval `prompt`, and explicit per-tool `approve` overrides for this authorized check. Claude used strict temporary MCP configuration, those five allowed tools, no built-in tools, `dontAsk` and no session persistence. Neither client configuration nor version was changed globally. Protocol era was not exposed by these installed-client traces; both protocol paths remain separately covered by SDK tests.
- Real Chromium authenticated through HTTPS and rendered six grouped project rows. Desktop and 390-pixel mobile layouts had no horizontal overflow or JavaScript exceptions; the HttpOnly session cookie was inaccessible to JavaScript. Chromium required `--no-sandbox` for this temporary trusted-local test because the installed browser could not use the host's namespace sandbox; no host security setting was changed.
- The approved disposable profile started exactly two real user-systemd services in dependency order. Concurrent starts, including a repeated request ID, returned the same durable operation. Application readiness and the exact reserved preview mapping passed; HTTPS port 19484 served the frontend and `/api/message` proxy.
- Invocation-scoped API/web journal pages obeyed a one-line request bound. Stop removed the owned preview, stopped the control groups, released listeners, and left a separately running unmanaged test sentinel untouched.
- A competing test-owned listener produced `PORT_CONFLICT`. A controlled second-service exit produced a visible failure, removed newly created services and retained its journal diagnostics. No existing application was used to provoke a failure.
- Killing only Rootlane preserved healthy owned units and their invocation IDs on restart. Killing Rootlane during deliberately incorrect frontend readiness produced `INTERRUPTED` on restart and reconciled the partial startup without leaving its listeners running.
- A SQLite backup through the backup API was restored with the backend stopped. Restart preserved installation identity, stopped state and the original request-ID-to-operation mapping.
- Each temporary integration run removed its owned HTTPS routes and listeners and compared Serve configuration with its initial snapshot. Existing routes were preserved. No existing application/database/infrastructure lifecycle was changed.
- The normal gate was rerun directly after authorization: type checks, production build and **25/25 tests passed**.

Temporary harness and client traces were kept privately under `/tmp`; credentials were removed after successful runs.

## Remaining deployment checks

- Open the Rootlane UI and disposable preview from a second tailnet device, including API proxying and an actual browser HMR refresh. SSH to the available second Linux device rejected the current key; owner access from that device is still needed. Local HTTPS/API/HMR checks passed.
- Exercise an actual SSH disconnect and interrupted-stop timing if required before rollout. Healthy units survived abrupt backend death; interrupted-stop behavior passes focused adapter tests, but these two exact host scenarios were not reproduced.
- Review the approved visual reference when provided; only the agreed row structure is implemented and browser checked.
- Completed for the owner-requested Compose installation: persistent private configuration/state and dedicated HTTPS were installed under the release deployment described below. A native user-service installation remains an alternative, not a second backend to enable concurrently.
- During a separately authorized maintenance window, verify reboot behavior: Rootlane starts, development units remain absent and no application is automatically relaunched. Do not reboot neo solely to finish this session.

## Known limits

- Shared Tailscale CLI updates cannot be made atomic with unrelated operator changes. Immediate rechecks and postchecks reduce but do not remove that race; avoid simultaneous edits on owned ports.
- Logs are bounded journal tails with forward cursors; oversized journal command output fails rather than returning unbounded data. Failure snapshots are best-effort if journald itself is unavailable.
- Catalog process-to-project association uses cwd metadata, not proof of task identity or application health. Readiness claims apply only to managed services with the reviewed check and listener/control-group match.
- Real managed-unit lifecycle, installed-client discovery/calls, local HTTPS/browser access and stopped-service restoration are verified as recorded above. Second-device preview/HMR, real interrupted-stop timing, SSH-disconnect survival, host reboot and exact mockup matching remain unverified. SSH to the available second Linux tailnet device rejected the current key (`Permission denied (publickey)`).

## Docker release verification — 2026-10-09

The owner requested a downloadable GitHub release runnable from a folder with Docker Compose and explicitly approved disabling AppArmor confinement for this Rootlane container only. The native deployment remains available. Compose uses the installation owner's UID, host network/PID/cgroup namespaces, read-only project and journal mounts, the existing user manager/Tailscale sockets, a private writable state directory, no privileged mode, no Docker socket, and all capabilities dropped.

- Built a Linux amd64 image with Node 24.11.0, Ubuntu 24.04/systemd 255 host tools and a separately built better-sqlite3 binding. Pinned base-image digests; no compiler is included in the runtime image.
- The initial default-AppArmor container could start a host unit but failed readiness because host listener attribution was unavailable. With the owner's approved container-only setting, real Compose integration passed concurrent/idempotent starts, two owned host services, readiness, exact Tailscale preview/API proxy, bounded invocation logs, control-group stop, untouched unmanaged sentinel, test-owned port conflict, second-service failure/diagnostic rollback, abrupt container restart preserving healthy unit invocations, interrupted startup reconciliation and stopped-container SQLite backup/restore.
- The dedicated HTTPS publication command passed against the authenticated container backend. Every integration run removed its temporary container, routes and listeners and compared original shared Serve configuration. No persistent deployment or existing application was changed.
- The Docker stdio wrapper passed real tools/list, owned-environment reads, duplicate mutation request-ID mapping and harmless disconnect against the running container in both modern 2026-07-28 and legacy SDK modes.
- Setup's focused test verifies private/distinct credentials, initially observe-only profiles, repeat setup preserving credentials and configuration, and refusal of incompatible roots. The normal gate passes **26/26 tests**.

The image is tested on neo/Linux amd64 only. Second-device acceptance and exact approved visual matching are still pending. See `deploy/RELEASE.md` for mount requirements, host trust boundary, configuration, upgrade and teardown behavior.

## Persistent installation on neo — 2026-10-09

At the owner's request, installed the published `v0.1.0` archive at `/opt/stacks/rootlane`, loaded its prebuilt image and started `rootlane-rootlane-1` through Docker Compose. The container is healthy with `restart: unless-stopped`. Private owner configuration and distinct credentials are under `/home/kyle/.config/rootlane`; SQLite state is under `/home/kyle/.local/state/rootlane`. The configuration observes `/home/kyle/code` and initially contains no launch profiles.

The dedicated HTTPS origin is `https://neo.taile1abc7.ts.net:19483`. Actual HTTPS login/session/CSRF catalog calls passed, returning 11 real project/worktree entries, all observe-only. Lifecycle reconciliation is available and Tailscale reports connected. Private-file/directory checks passed; comparison with the pre-install Serve snapshot established that other mappings are unchanged. The installed `/opt/stacks/rootlane/deploy/rootlane-mcp-docker` wrapper exposed five tools and successfully called `list_projects` against this running backend. No global Codex/Claude configuration was changed, and no existing application was started, stopped or reconfigured.

Second-device access, reboot behavior and exact visual-reference matching remain pending. The container uses the previously approved Rootlane-only AppArmor setting.

## Owner-requested NPM domain — 2026-10-09

Added `root.avlis.dev` as Nginx Proxy Manager host 14 through its API, using the existing wildcard certificate 1. DNS already resolved to neo's Tailscale IP, so no DNS/certificate-provider change was needed. The NPM container is bridged and cannot reach host loopback directly: it forwards over verified HTTPS to `neo.taile1abc7.ts.net:19483`, preserving Rootlane's loopback binding. The new host permits only tailnet source addresses, redirects HTTP to HTTPS, and verifies the upstream hostname/chain (depth 3). Every pre-existing proxy-host record was compared with the prior snapshot and remained unchanged; nginx configuration validation passed.

Upgraded only Rootlane to image `rootlane:0.1.1` after backing up SQLite. Added owner-reviewed `additionalOrigins: ["https://root.avlis.dev"]` without changing the original Tailscale origin/routes or owner credentials. The HTTP boundary requires an allowed Host and its matching supplied Origin, secure same-origin session and CSRF token. Alias login/CSRF tests and both SDK modes pass; the normal gate passes **27/27 tests**.

Actual live checks passed for the wildcard TLS certificate, owner login, authenticated catalog, mismatched Host/Origin rejection, HTTP redirect, retained original Tailscale access, and real desktop/mobile Chromium rendering. The container remains healthy. The certificate-chain depth adjustment was confined to this new NPM host; certificate verification remains enabled. No managed launch profile was added and no existing application was controlled.
