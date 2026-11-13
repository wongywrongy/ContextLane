# Installation and interface review — 2026-11-12

Scope: the installation, recovery and UI follow-up to `b81e11b5e24b69e91688339816868017571607d5`. This records source review and local verification; it is not live release acceptance.

## Findings resolved

| Finding | Result | Evidence |
|---|---|---|
| Installer rerun duplicated the updater and could replace a chosen channel with main | Delegate to the installed updater; forward a channel only when explicitly selected | Shell/Git installer fixtures, updater channel tests |
| Interrupted first build left a checkout that could not be retried | Resume the installer-marked checkout; preserve edits and its original branch | Interrupted-build and edited-checkout fixtures |
| Installation could change some managed files before discovering a conflicting file | Preflight every managed wrapper/unit; preserve update history and reject a different selected release | Setup preflight test and actual compiled installer-entry test |
| Build metadata alone allowed dirty or mismatched source to be adopted | Require matching HEAD, commit metadata, daemon output and clean tracked source; verify fresh builds too | Dirty/mismatched adoption and source-mutating build tests |
| Failed candidate startup could restore an older database automatically | Stop and retain the newer database when schema compatibility is uncertain; persist recovery history | Migration/startup fixture retains a newer work row until explicit restore |
| Recovery could leave the rejected candidate in the rollback chain or update channel | Restore the prior chain/channel; refuse a database rollback without matching history | Repeated rollback and missing-history regressions |
| Lane inspector mixed routine access, copy helpers and destructive/recovery actions | Keep terminal/editor visible; group the other controls in native disclosures; expand recovery for failed lanes | Typecheck/build, source review; browser interaction assertions prepared |
| Empty optional model/routing sections occupied the main page | Collapse unconfigured sections; configured model status remains visible | Source review; browser assertions prepared |

Review covered failure ordering, ownership checks, retained data/history, branch selection, source identity, action availability, native keyboard controls, responsive CSS and documentation consistency. Existing authorization, bounded-repair and worktree-retention tests remained in the full suite. No new dependencies or schema migration were introduced. The repository's existing CI configuration was inspected; a workflow file does not establish that checks ran on the published commit.

## Verification

- `corepack pnpm check`: TypeScript and production build passed. Tests: **453 passed, 6 failed, 10 skipped** across 91 test files. The six failures are `listen EPERM` from prohibited Unix sockets: three daemon host tests, one setup socket test, one lanehost replay test and one usage transport test. This is not an all-green check result.
- All added installer/update regressions passed, including real shell/Git fixtures and the compiled installation entry. Systemd/package-build stand-ins do not establish a successful production installation.
- `node scripts/check-contrast.mjs`: all 80 dark/light text-token pairs meet the checker’s 4.5:1 threshold.
- `sh -n install.sh`, `node --check scripts/check-v2.mjs`, and `git diff --check`: passed.
- `CHROMIUM_BIN=/usr/bin/chromium node scripts/check-v2.mjs`: blocked before UI assertions because Chromium could not create its process-singleton Unix socket. A separate browser could not reach the local fixture. Existing committed captures were inspected, but no fresh desktop/mobile screenshots or interaction pass are claimed.

## Release gate

Keep the PR draft until an unrestricted host passes the complete suite, the prepared browser checks, native Claude/Codex repair-limit recovery, shared-worktree retention, and real PR merge/cleanup acceptance. Verify the exact published commit and record provider versions. A healthy daemon or a fake-agent infrastructure test does not substitute for these checks.

Follow [Installation and recovery](INSTALLATION.md) for the native/Docker boundary and backup policy. No production deployment, Docker retirement, credential migration or database restore was performed during this follow-up.
