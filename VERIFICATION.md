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
- Real SDK stdio tests pass for both modern 2026-07-28 and legacy initialize traffic, including tools/list, calls, strict schemas, duplicate requests and harmless adapter disconnect. These are SDK clients, not installed Codex/Claude acceptance.
- Rootlane's read-only host preflight passes. Tailscale identity is `neo.taile1abc7.ts.net`; ports 9480, 19483, 19481, 19482 and 19484 were unused at the time of the check.
- Real discovery returned **16 project/worktree entries**, including **11 with Git metadata** and **4 with associated listeners**. Every observed runtime remains observe-only. Eight out-of-root/unavailable worktree warnings were returned rather than accessing those paths.
- No service was installed/enabled, no fixture was launched, and no existing application or Serve route was changed.

The build emitted two non-fatal Rollup warnings about Zod pure-comment annotations; it completed successfully.

## Test coverage passed

Focused tests cover real Git/non-Git discovery with detached and out-of-root worktrees; configuration boundaries; strict HTTP schemas, sessions, Origin/Host, CSRF and credentials; duplicate/concurrent starts and cross-environment reservations; readiness failures; partial startup rollback; preview-only failure; changed unit/route ownership; failed stops and retained reservations; interrupted start/stop/reboot reconciliation; bounded response/log contracts; lifetime backend locking; SQLite backup restore; real SDK stdio discovery/calls and disconnect for modern and legacy eras.

Lifecycle effects use fake host adapters. They do not establish real Linux/Tailscale lifecycle acceptance.

## Client/protocol matrix

| Client/path | Version or protocol | Discovery | Actual tool calls |
| --- | --- | --- | --- |
| Installed Codex | 0.162.0 | Not yet exercised | Not yet exercised |
| Installed Claude Code | 2.1.295 | Not yet exercised | Not yet exercised |
| SDK test client, legacy | v2.3.1; legacy initialize | Passed | Passed |
| SDK test client, modern | v2.3.1; 2026-07-28 pin | Passed | Passed |

Neither installed client was upgraded or reconfigured. SDK package installation, compilation and both protocol tests are verified. See the [SDK stdio documentation](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio) and [protocol-version documentation](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions).

## Remaining host acceptance procedure

1. Completed: dependency installation, lockfile generation, required gate and native binding/backup tests. Re-run the gate after any subsequent code change.
2. Install the reviewed private owner configuration and distinct credential files. Run the read-only host preflight. Verify the candidate ports and shared Serve configuration again immediately before setup. Existing mappings are untouchable.
3. Resolve test-budget accounting for transient user-systemd fixture units. The user manager starts services outside a caller's `dev-test` scope by default; do not assume those units are budgeted. If the host policy cannot support this integration check, leave it blocked.
4. Start Rootlane and establish its separately checked HTTPS route. Authenticate from a browser and test actual Host/Origin/cookie behavior through Tailscale. Capture real directories, worktree grouping, known links and unavailable/unknown associations. Review desktop/mobile structure once; exact visual matching remains pending the mockup.
5. Start `disposable` twice concurrently and with a repeated request ID. Capture the shared operation ID, exactly two owned units, readiness results, invocation-scoped logs and the expected preview mapping. Reuse that request ID with `stop` and verify rejection. Close the requesting adapter/browser and SSH connection; owned processes must survive.
6. From a second tailnet device, open HTTPS 19484. Verify the fixture text, `/api/message` proxy and a Vite HMR update. A matching Serve entry alone is not proof of working preview access.
7. Restart only Rootlane. Verify healthy fixture units/invocations persist and no duplicates appear. Exercise interrupted startup/stop against the disposable fixture. Confirm a startup failure preserves diagnostics and rolls back only newly created resources. Use controlled failure settings in a temporary reviewed fixture profile; do not occupy or alter existing services to create conflicts.
8. Stop the fixture. Verify process groups are empty, the owned route is removed, and reservations are released. Compare unrelated units/listeners/routes with the pre-test snapshot. Test route-change and failed-stop conflict behavior primarily with fake adapters; never commandeer an existing route to provoke failure.
9. Back up through the SQLite API, stop Rootlane and restore to its private state directory. Restart and verify installation identity, request mappings and observed-state reconciliation. Never run a restored copy alongside the original.
10. Configure each installed coding client with the same absolute local adapter executable and only five tools. Record its effective permission policy. In **each client**, discover the tools, list real projects, start the fixture, observe readiness/links, fetch bounded logs, repeat the start request ID, stop it, and confirm a disconnected adapter does not affect resources. Record outputs and negotiated protocol era where exposed. A successful configuration-list command is insufficient.

Host reboot acceptance is a separate maintenance check: after an authorized reboot, Rootlane should start, development units should remain absent and no application should be relaunched. Do not reboot neo merely to complete this implementation session.

## Known limits

- Shared Tailscale CLI updates cannot be made atomic with unrelated operator changes. Immediate rechecks and postchecks reduce but do not remove that race; avoid simultaneous edits on owned ports.
- Logs are bounded journal tails with forward cursors; oversized journal command output fails rather than returning unbounded data. Failure snapshots are best-effort if journald itself is unavailable.
- Catalog process-to-project association uses cwd metadata, not proof of task identity or application health. Readiness claims apply only to managed services with the reviewed check and listener/control-group match.
- Compilation and focused tests are verified. Real managed-unit lifecycle, second-device preview/HMR, installed coding-client calls and stopped-service restoration still require the host acceptance procedure above.
