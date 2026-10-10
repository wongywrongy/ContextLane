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

## Optional agent-assisted MCP setup — 2026-10-09

Version 0.1.7 retains CLI registration as the primary setup and adds a collapsed optional setup prompt in Settings → MCP setup. The prompt asks the current coding client to inspect existing registration, preserve unrelated configuration and normal approvals, restrict Codex to the five tools, protect credentials, avoid backend/software/route/environment changes and verify actual read-only calls or report fresh-session instructions. Missing/inaccessible installations are blockers, not authorization to replace them.

All **37/37 tests** pass. Real Chromium preview and live HTTPS checks passed disclosure opening, copied prompt contents, ordinary command copying, navigation, desktop/mobile overflow and absence of JavaScript exceptions. Independent review returned ship; inherited design documentation is unchanged. Installed at /opt/stacks/rootlane after SQLite API backup pre-setup-prompt-0.1.7.sqlite; container healthy. Client registrations, credentials, profiles, existing applications and routes were unchanged. The prompt was not executed in installed coding clients; its instructions are not an enforcement boundary and client permissions/restart may be needed.

## Reported Codex missing-tools diagnosis — 2026-10-09

The installed Rootlane 0.1.7 container was healthy and Codex registration pointed to the correct executable. Legacy and modern SDK tools/list returned all five tools; real read-only list_projects calls succeeded. With explicit owner approval, a fresh installed Codex 0.162.1 session using the existing registration completed an actual Rootlane list_projects(limit:1) call. No client config, environment or application URLs were changed. This establishes fresh local CLI operation, not the cause of the original session's tool exposure.

Version 0.1.8 clarifies that Rootlane exposes tools rather than resource entries; list_mcp_resources and inspection of launcher source text do not establish tool availability. Setup guidance requires actual tool discovery/calls, reconnect/fresh-session steps and an honest failure report. Server instructions and catalog tool descriptions distinguish known project links from GitHub/Render API access and public URL/payment callback changes. Hosted chat tool exposure may differ from local client configuration.

All **37/37 tests** pass, independent visual review returned ship, and live HTTPS desktop/mobile disclosure/clipboard/navigation checks passed. Updated adapter metadata and a read-only call passed after deployment. Installed at /opt/stacks/rootlane after backup pre-discovery-help-0.1.8.sqlite; container healthy. Original session reconnect, hosted client access and a new Claude Code acceptance run remain unverified.

## Native agent process detection — 2026-10-10

Version 0.1.9 adds bounded, read-only same-user native Codex/Claude process observations to the shared catalog. Native Claude versioned executables are recognized; generic Node wrappers and code-mode helpers are excluded. Process start time protects identities against PID reuse. Working directories resolve inside observation roots and attach to the deepest known checkout; no new projects are inferred from processes. Registrations remain separate. Unassigned counts and incomplete/unavailable scans appear in discovery notices. No process arguments, environments, prompts or transcripts are read or stored.

Type checks, frontend/backend build and **42/42 behavior tests** pass. New checks cover native identification, deleted executable names, malformed/changed identities, exited/inaccessible processes, other-user exclusion, all scan budgets, approved Git worktree and nested-directory associations, symlink boundaries, expired-cache removal, distinct same-name observations, and validated agent output through modern/legacy MCP calls.

On neo, the existing deployed container can read the required metadata without permission changes. Authenticated live Chromium desktop/mobile checks passed at root.avlis.dev, including collapsed details, polling, search, navigation and no horizontal overflow or JavaScript exceptions. Rendered evidence is in .impeccable/review/agent-detection. The deployed Docker adapter completed actual tools/list and list_projects through both legacy and 2026-07-28 SDK clients before and after Rootlane replacement. At that observation time, ShuttleWorks had five native agent processes, rootlane three and paypalaihack26 one; five additional processes remained unassigned. Some same-user metadata was inaccessible, reported as incomplete rather than complete absence.

Installed in /opt/stacks/rootlane; Rootlane alone was replaced and became healthy. Detection recovered with the observed processes still present after replacement. State backup: pre-agent-detection-0.1.9.sqlite via the SQLite backup API. No project processes, owner configuration, credentials or proxy/Tailscale routes were changed. Fresh model-driven Codex/Claude calls, a host reboot and another tailnet device were not repeated for this update. Process counts can include native helper processes and do not establish sessions, tasks or active work.

## Preview publishing and interface reliability — 0.2.0 (2026-10-10)

Rootlane alone was restarted before implementation to load the owner's edited credential. Actual Chromium login then succeeded without changing that credential. At 360, 390, 768, 1280 and 1440px, baseline bottom-row menus extended below the 844px viewport (bottom approximately 954px), and neither Escape nor outside clicks dismissed them. Horizontal overflow and JavaScript exceptions were absent. These are reproduced defects; eager workspace environment fan-out, effect recreation on refresh, global error handling and unguarded CLI Serve writes were source findings.

The dashboard now uses compact project rows, one selected inline details section, explicit checkout/service associations and native auto-popovers. CSS anchor positioning flips menus at edges; a fixed viewport-contained placement handles missing anchor support. Details contain paths, links, agents, recorded logs and separate route/upstream/HTTPS observations. No prominent lifecycle, folder or preview buttons remain. A single polling controller performs visible-page five-second polling, allows one refresh in flight and one queued refresh, preserves successful data and interaction state, and aborts obsolete selections and cleanup requests. Errors stay beside the affected content, with retained observations labeled stale.

Independent `previewTargets` authorize only reviewed existing loopback services. Durable publication records and operations share request-ID protection and HTTPS reservations with lifecycle actions. Publication does not start/adopt processes or reserve their upstream application ports. One route lock covers both workflows. Bounded Tailscale Unix-socket requests use ETag/If-Match, preserve unrelated configuration, reject foreground/conflicting routes and fail closed without guarded writes. The official local API is version-sensitive. Restart reconciliation preserves matching routes, reports missing/conflicting routes, resumes recorded removal safely and never recreates applications or missing routes.

Verification:

- Type checks, production build and **61/61 behavior tests** passed. Tests include approval, strict local binding and rejection of extra bindings on the same process, unknown checkout association, occupied HTTPS ports, occupied upstream publication, concurrent duplicates, shared request IDs/reservations, failed readiness, uncertain publication, failed removal, target drift, removed approval, interrupted publication/removal, version-one migration preservation and guarded-write concurrency conflicts.
- `node tests/browser.mjs` passed Chromium captures at all five widths, bottom-edge containment, Escape/outside dismissal, focus restoration without stealing focus from outside-clicked controls, touch activation, long content, project/log/environment/preview/catalog failures, delayed project/log responses, rapid selection, refresh coalescing, disconnect/reconnect and page cleanup. It verifies no eager environment fan-out and no overlapping catalog refresh. Controlled failures use intercepted HTTP responses; these are regression evidence, separate from live host observations.
- Live authenticated deployed Chromium rendered five grouped rows, had no horizontal overflow or JavaScript exceptions, and kept its secure session cookie inaccessible to JavaScript. All five menu captures stayed inside the viewport; Escape dismissed each. [Desktop capture](docs/evidence/0.2.0/live-desktop.png), [mobile capture](docs/evidence/0.2.0/live-mobile.png), [baseline measurements](docs/evidence/0.2.0/baseline.json), [live measurements](docs/evidence/0.2.0/live.json), [controlled regression results](docs/evidence/0.2.0/browser-results.json). The controlled suite establishes actual outside-click behavior; the live capture helper closes the popover programmatically after its Escape check.
- `node tests/host-preview.mjs` and `ROOTLANE_INSTALLED=1 node tests/host-preview.mjs` exercised the real separately started disposable API/frontend through native and deployed Docker adapters. Actual modern/legacy tools/list returned ten tools. Discover → identify → publish → inspect → verified URL → unpublish passed. HTTPS HTML, transformed assets, API proxy requests, redirects, Vite WebSocket connection and traffic after a fixture file change passed. Rootlane restarted while the route and fixture existed without restarting their processes or duplicating the preview. After unpublishing, both services still answered locally; the harness then cleaned up only its own processes. Original Serve configuration matched exactly after cleanup.
- Installed Codex and Claude Code each made actual read-only `get_capabilities`, `list_projects` and `get_project` calls using their existing Docker registrations. Both reported only `disposable-web` approved and write/lifecycle permissions explicitly unverified. Codex's existing registration now has the ten-tool allowlist and prompt approvals; unrelated configuration was preserved. Claude's check allowed only those three read-only tools for that invocation, without changing its saved registration or mutating-tool policy. Native process detection remains intact, including its existing metadata warnings.
- The owner opened the temporary preview on another tailnet device and confirmed the HTML page and “The disposable API is reachable.” message loaded. Second-device WebSocket/HMR instrumentation was not performed; those checks ran on the Rootlane host.

Rootlane 0.2.0 was deployed at `/opt/stacks/rootlane` with a SQLite backup through its backup API at `/home/kyle/.local/state/rootlane/pre-preview-0.2.0.sqlite`. Owner configuration backup is `config.pre-preview-0.2.0.json` in the private config directory. Only `disposable-web` is publication-approved; no lifecycle profiles were enabled. Credentials, existing applications, databases, infrastructure and unrelated Serve/Nginx Proxy Manager routes were preserved. The temporary second-device preview was removed after confirmation. An older Rootlane build cannot open the migrated database; downgrade requires stopping Rootlane and restoring the pre-migration backup, which would discard later preview history.

The mechanical design detector reported the pinned Inter font and existing palette/type-ramp advisories; the requested visual direction was retained. Existing Impeccable product-schema/sidecar drift remains outside this change. No generic Node agent wrappers, remote detection, host reboot or broader accessibility certification was added or claimed.

Example MCP workflow (replace identifiers with actual returned IDs, use distinct UUID request IDs):

```text
get_capabilities {}
list_projects {"limit":50}
get_project {"projectId":"<project ID>"}
publish_preview {"targetId":"disposable-web","requestId":"<UUID>"}
get_preview {"previewId":"<returned preview UUID>"}
unpublish_preview {"previewId":"<returned preview UUID>","requestId":"<new UUID>"}
```

Retries reuse the original request ID and payload. An accepted operation is not a readiness or HTTPS claim. Start the fixture separately; Rootlane owns only its publication route.

## Signal deployment — 2026-10-10

Deployed the tested Signal build to the existing `/opt/stacks/rootlane` stack as `rootlane:0.2.0-signal-20261010`. The image was built from this workspace's compiled backend and Vite assets. The package/API version remains 0.2.0; this image tag identifies the Signal revision. Hosted HTML at `https://root.avlis.dev` matches the workspace's compiled asset hashes exactly. Container health passed, and authenticated deployed `list_projects` and `get_project` responses validated against the updated contracts, including worktrees, attributed listeners, and observed preview links.

SQLite backup: `/home/kyle/.local/state/rootlane/pre-signal-20261010-014745.sqlite`, created through the SQLite backup API before replacement. Previous installed compiled assets, package and Compose file: `/opt/stacks/rootlane/pre-signal-20261010-014745.tar.gz`. The previous `rootlane:0.2.0` image remains available. Configuration-directory file hashes (including both credentials) and Tailscale Serve configuration were identical before and after deployment. Only Rootlane was recreated.

The build gate passed typecheck, production build and all 66 tests. Deterministic UI regression evidence remains in `.impeccable/review`; live deployment captures are separately identified under `.impeccable/review/live-signal`. Lifecycle actions, second-device acceptance, and host reboot were not repeated during this UI deployment.

Live Chromium smoke testing subsequently passed HTTPS owner login, the actual project catalog, collapsed summary panels, local Geist/Geist Mono, 1440/1000/390 viewport overflow checks, expanded details, Settings/MCP, an inaccessible HttpOnly cookie and zero JavaScript exceptions. Captures and provenance: `.impeccable/review/live-signal/`.


## Rootlane 0.3.0 six-phase verification — 2026-10-10

The Signal baseline was recorded separately, then each implementation phase received its own commit and a passing `npm run check`: phase 1 (68 tests), phase 2 (72), phase 3 (77), phase 4 (78), phase 5 (79). Phase 6 passes the full check with 82 tests and adds the gated host harness and regression coverage. No runtime dependency was added. Package and MCP version is 0.3.0.

The opt-in `ROOTLANE_HOST_ACCEPTANCE=1 npm run host:acceptance` passed against the real HTTP API on neo with isolated temporary private config/state. It used only the owner-reviewed disposable API/Vite fixture, not existing applications or installed approval/config files. Checks passed:

- Idempotent Start, reviewed Ready and independently verified HTTPS Available.
- Invocation-scoped bounded logs and HTTP Stop; fixture ports released.
- locate returned the real Vite listener and both managed and independently recorded preview URLs.
- Both proposal tools returned unapproved JSON with the literal readiness placeholder, without changing config or routes.
- The harness reviewed its disposable target, reloaded its own isolated config, published Available and unpublished while preserving the application.
- Invalid SIGHUP reload kept the running config; valid SIGHUP reload and automatic ten-second mtime reload applied validated changes.
- list_operations returned durable lifecycle/publication history; Serve config matched the exact pre-run snapshot after cleanup.

Evidence: `.impeccable/review/host-acceptance-results.json`. Synthetic proc tests cover npm-installed agent entrypoints, wrapper collapse, start time and same-user restrictions. Real-host service acceptance verifies Vite; uvicorn naming is covered by the derived-name tests. No real coding agent was launched to manufacture detection evidence.

Chromium checks pass at 1440, 1000 and 390 pixels: collapsed summaries, expanded tabs, services/HTTP, proposals and Copy recovery, configured and absent editor templates, Stop confirmation, UUID-preserving retries and verbatim backend codes, coalesced refresh, stale observations, keyboard focus, Settings/MCP, Unlock, reduced motion and CSP. Readiness probes do not run for collapsed projects. Refreshed screenshots and fixture request evidence are under `.impeccable/review`; mock data is explicitly fixture evidence. Impeccable finish review returned ship after disclosure, selection isolation, proposal capture and clipboard-recovery fixes.

Owner-only acceptance remains open and unclaimed for this update: second-device preview and HMR, reboot, and SSH disconnect. Historical entries above are historical evidence; this phase does not claim those checks were repeated. After explicit owner approval, the checked 0.3.0 image was deployed to the existing `/opt/stacks/rootlane` stack at https://root.avlis.dev. Container health, authenticated capabilities/catalog/locate, and live HTTPS login passed. Refreshed live screenshots at 1440/1000/390 show five real project cards, three summary panels each, no horizontal overflow, local fonts and no browser exceptions. The Docker preflight now exempts the already-running operator ports while continuing to check profile ports; a regression test covers both startup and installed modes. Config and both credential hashes and the complete Serve configuration remained identical across deployment. Pre-upgrade SQLite backup: `/home/kyle/.local/state/rootlane/pre-030-2026-10-10T02-41-36-365Z.sqlite`; installed release backup: `/opt/stacks/rootlane/pre-030-2026-10-10T02-41-36-365Z.tar.gz`. The previous `rootlane:0.2.0-signal-20261010` image remains available for rollback. No installed application was started or stopped during deployment.
