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

Added `root.avlis.dev` as Nginx Proxy Manager host 14 through its API, using the existing wildcard certificate 1. DNS already resolved to neo's Tailscale IP, so no DNS/certificate-provider change was needed. The NPM container is bridged and cannot reach host loopback directly: it forwards over verified HTTPS to `neo.taile1abc7.ts.net:19483`, preserving Rootlane's loopback binding. The new host permits tailnet source addresses and the owner-approved exact Docker bridge gateway `172.19.0.1`, redirects HTTP to HTTPS, and verifies the upstream hostname/chain (depth 3). Docker NAT presented the browser through that gateway, causing the initial 403; the approved exception fixes that path. Requests through the gateway now return UI 200 and unauthenticated API 401. Gateway NAT can conceal the original client address, so this allowlist alone does not establish tailnet membership; Rootlane authentication remains required. Every pre-existing proxy-host record was compared with the prior snapshot and remained unchanged; nginx configuration validation passed.

Upgraded only Rootlane to image `rootlane:0.1.1` after backing up SQLite. Added owner-reviewed `additionalOrigins: ["https://root.avlis.dev"]` without changing the original Tailscale origin/routes or owner credentials. The HTTP boundary requires an allowed Host and its matching supplied Origin, secure same-origin session and CSRF token. Alias login/CSRF tests and both SDK modes pass; the normal gate passes **27/27 tests**.

Actual live checks passed for the wildcard TLS certificate, owner login, authenticated catalog, mismatched Host/Origin rejection, HTTP redirect, retained original Tailscale access, and real desktop/mobile Chromium rendering. The container remains healthy. The certificate-chain depth adjustment was confined to this new NPM host; certificate verification remains enabled. No managed launch profile was added and no existing application was controlled.

## Authentication hardening — 2026-10-09

Installed `rootlane:0.1.2` at `/opt/stacks/rootlane` after a SQLite API backup to `pre-security-0.1.2.sqlite`. Login now has a persisted, owner-wide sliding limit of ten attempts per minute, enforced before body parsing. It is shared across operator origins and does not trust forwarded client addresses. Only at most ten attempt timestamps are retained, never submitted credentials. Denied requests return 429 with Retry-After; denials do not extend the cooldown. Authentication uses Fastify's matched route so alternate URL spellings cannot bypass its boundary.

The normal gate passes **29/29 tests**: concurrent attempts, alias/forwarded-header/query/URL variations, malformed/oversized bodies, reopen/restart persistence, expiry/recovery, and existing-session access during throttling. Live HTTPS on root.avlis.dev passed valid login, secure-cookie flags, anonymous/forged-session rejection, CSRF enforcement, concurrent wrong-credential throttling, persisted 429 after a real container restart, and successful valid login after natural cooldown. The production dependency advisory audit reported zero known vulnerabilities. The backend still listens only on 127.0.0.1:9480; private directories are 0700 and credential files 0600. The installation uses a setup-generated 256-bit random owner credential; its value was not printed.

This is a focused authentication/installation review, not an external penetration test or flood-resilience assessment. Sustained requests can temporarily prevent new owner logins; existing sessions remain usable. Stolen credentials and code running as the installation owner remain outside this boundary. The approved Docker-gateway proxy exception cannot prove the original client's tailnet membership. No unrelated proxy host, application, route or owner credential was changed.

## Owner-selected credential policy — 2026-10-09

The owner intentionally selected a shorter credential for the protected private installation. Version 0.1.3 accepts a nonempty owner credential up to 256 characters; the separate agent credential still requires at least 32 characters and must differ. Setup continues generating 256-bit random defaults. The chosen owner credential was neither replaced nor printed. This policy accepts reduced resistance to guessing; it does not establish that a particular password is strong or that DNS privacy alone restricts access.

The normal gate passes **30/30 tests**, including short-owner login, empty/oversized-owner rejection, weak/shared-agent rejection, and all persisted throttling/session/CSRF tests. Installed `rootlane:0.1.3` after SQLite API backup `pre-owner-policy-0.1.3.sqlite`. The container is healthy; live HTTPS using the current credential returned login 200, connected/lifecycle-available/Tailscale-connected status, real catalog 200, and anonymous API 401. Existing host services/routes and credentials were not changed. No second-device retry or new external penetration test was performed.

## Approved Projects UI — 2026-10-09

Installed `rootlane:0.1.4` at `/opt/stacks/rootlane` after SQLite API backup `pre-ui-0.1.4.sqlite`. The approved root PNG governs the dark shell, Projects/Settings navigation, header search and connection status, and compact full-width project cards with Agents, Services, Preview and actions. Worktrees/environments expand inline on demand; absolute paths are secondary details. Real backend catalog pages are grouped by Git metadata before UI pagination: the current eleven discovery entries produce five top-level project cards. No recursive discovery or fictional agent/runtime data was added.

The normal gate passes **34/34 tests**, including grouping detached/external worktrees, nested reviewed environments and non-Git projects; bounded consistent catalog pagination; listener/readiness distinctions; and the strict font asset allowlist. Existing lifecycle ownership, rollback, retry/reconciliation, authentication, bounded logs and modern/legacy MCP tests remain passing. The shared backend services are preserved; the only HTTP change serves the bundled local font with its correct MIME type. Its license ships with the compiled assets.

Independent visual finish review returned **ship** against the supplied reference. Live Chromium through `https://root.avlis.dev`, with certificate validation enabled, passed owner login, five real project rows, collapsed initial details, expanded-state preservation across polling, collapse keyboard focus, search, read-only Settings, desktop/mobile overflow checks and zero JavaScript exceptions. The secure session cookie remained inaccessible to JavaScript; anonymous API returned 401. Live font serving returned 200 with font/woff2. Screenshots and provenance are in `.impeccable/review`; design tokens and component rules are in `DESIGN.md` and `.impeccable/design.json`.

The container is healthy. No existing application, shared preview route, proxy host, private credential or launch profile was changed. Production remains configured with no managed profiles, so unsupported folder opening and managed lifecycle/log controls are unavailable honestly. Native fixture lifecycle and installed-client acceptance were verified earlier, not freshly exercised through this UI deployment. A second tailnet device and host reboot acceptance remain pending.

## MCP setup page — 2026-10-09

Version 0.1.5 adds Settings → MCP setup: local neo Docker prerequisites, copyable Codex and Claude Code registration commands, Codex five-tool allowlist and prompt policy, real read-only verification prompt, credential boundaries and troubleshooting. The guide links official client documentation and does not claim a remote /mcp endpoint. Commands were checked against installed Codex 0.162.0 / Claude Code 2.1.296 help and official documentation. No client configuration or credential was changed.

The normal gate passes **35/35 tests**, including a rendered-guide contract check. The restricted runner initially prevented two existing integration suites; all suites passed with the required host/loopback permissions. Chromium passed Settings-page navigation, exact clipboard content, existing Projects behavior, zero JavaScript exceptions, and desktop/mobile overflow checks. Independent review returned ship; documentation review confirmed the inherited design remains consistent. Live HTTPS verification repeated the same checks after deployment. Captures are in `.impeccable/review/mcp-setup`.

The exact installed adapter taught by the guide completed tools/list (five tools) and a real read-only list_projects call through the running backend. This is SDK acceptance, not a new installed-client lifecycle run. Installed at /opt/stacks/rootlane after SQLite API backup pre-mcp-guide-0.1.5.sqlite; container healthy. Existing applications, routes, profiles and credentials remain unchanged.

## Portable setup and simpler README — 2026-10-09

Version 0.1.6 replaces the implementation-led README with a short product introduction, Docker quick start, client registration and linked administration documentation. Host-specific user paths, domains and machine names were removed from reusable deployment templates, MCP server instructions, product context and Settings help. Historical host acceptance evidence remains here and in labelled screenshots. The native wrapper resolves its release directory, loads owner configuration/agent credentials and forwards to the configured loopback port without consuming MCP stdin. The disposable fixture reads its allowed Tailscale/HMR hostname from owner configuration; the sample profile is unapproved by default.

The normal gate passes **37/37 tests**. New checks exercise a relocated native release containing spaces, a nondefault configured port, clean stdio tools/list and read-only calls, actionable backend-unavailable errors, alternate Tailscale fixture hostname, and invalid-host rejection. Setup tests continue to verify private credentials, derived hostname and repeated setup preserving configuration. Local documentation links resolve; the root README has 69 lines. No different Unix account or second physical host was tested.

Installed at /opt/stacks/rootlane after SQLite API backup pre-portable-docs-0.1.6.sqlite. Container healthy. Live HTTPS Chromium passed generic Settings wording, copy commands, navigation, desktop/mobile overflow and no JavaScript exceptions. The installed Docker adapter returned five tools and a real read-only list_projects result. Independent visual review returned ship and confirmed inherited design consistency. Existing owner configuration/credentials, applications, client registrations and shared routes were preserved. No new installed-client lifecycle, second-device or reboot acceptance run was performed.
