# Developing ContextLanes

Use Node >= 22.13 (24 recommended) and the pnpm version pinned in `package.json`. Read [AGENTS.md](../AGENTS.md) for the repository invariants; follow links only when they concern the change.

## Build and run

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm dev
```

`pnpm check` is the clean-checkout verification entry point. It covers TypeScript, the production build and the ordinary test suite. The suite uses fake runners and agent fixtures where host services or credentials are not required. A passing unit suite does not establish a real provider, device, or production deployment result. The installer tests execute the shell and Git against temporary repositories, with package builds and systemd substituted; one test also executes the built installation entry point.

To run the built app instead of development servers:

```sh
node apps/daemon/dist/main.js
# In another terminal:
node apps/cli/dist/main.js setup
```

To install the built checkout as a user service, run `node apps/daemon/dist/install-main.js`. Source checkouts update with `git pull`, install, build and a restart; `contextlanes update` manages installations created by `install.sh`.

## Targeted checks

After a build, run an individual test file with `corepack pnpm exec vitest run <path>`. Relevant suites include:

| Change | Start here |
|---|---|
| State, protocol or persisted data | `packages/protocol/test`, `apps/daemon/test/store.test.ts` |
| Review, integration or evidence | `apps/daemon/test/review.test.ts`, `apps/daemon/test/checker.test.ts` |
| Native CLI hooks and input | `apps/daemon/test/hooks.test.ts`, `apps/daemon/test/cli-input.test.ts` |
| Repair budgets and owner authority | `apps/daemon/test/repair-loop.test.ts`, `apps/daemon/test/host-repair.test.ts` |
| Filesystem and credentials | `apps/daemon/test/safefs.test.ts`, `apps/daemon/test/auth.test.ts`, `apps/daemon/test/sandbox.real.test.ts` |
| Shared worktree retention | `apps/daemon/test/worktree-retention.test.ts`, `apps/daemon/test/confine-git.test.ts` |
| Setup and updates | `apps/daemon/test/installer.test.ts`, `apps/daemon/test/setup.test.ts`, `apps/daemon/test/update.test.ts` |

Check the actual test filenames when adding coverage. Test observable behavior and meaningful failure cases, including interrupted delivery, stale evidence and rejected permissions.

## Host integration checks

Enable only the checks whose dependencies are available. They use disposable fixtures, but some launch tmux sessions, systemd user units, browsers or databases.

```sh
# Requires a functioning systemd user session, tmux and bubblewrap:
CONTEXTLANES_REAL_HOSTS=1 CONTEXTLANES_REAL_TERMINAL=1 CONTEXTLANES_REAL_SANDBOX=1 corepack pnpm check

# Requires Playwright and a Chromium binary:
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs CHROMIUM_BIN=/absolute/path/to/chrome node scripts/check-setup.mjs
```

`CONTEXTLANES_REAL_BROWSER=1` enables the real preview-browser test. The Postgres test uses `CONTEXTLANES_REAL_POSTGRES`; read `apps/daemon/test/databases.real.test.ts` before supplying disposable admin/app URLs. Do not point fixtures at production databases.

`CHROMIUM_BIN=/absolute/path/to/chrome node scripts/check-v2.mjs /tmp/contextlanes-ui` checks the main pages at desktop and phone widths, including keyboard access to the secondary lane controls. `node scripts/check-contrast.mjs` checks both themes.

Browser smoke scripts use seeded data or fake agents. Phone-sized Chromium verifies layout and browser behavior, not physical-phone notifications or provider account integration. Record skipped checks and environment failures separately from application failures.

## Native repair and worktree acceptance

Use disposable projects and retain evidence of these two regression checks:

- Give a real native lane a deterministic failing check. After the initial failure, exactly two repair prompts may be queued; continued failure must produce an owner Inbox question. Repeated or altered prompt-hook echoes and daemon restarts must not reset that budget. Authenticated owner guidance or a valid Inbox acknowledgement must resume a new bounded cycle.
- Create several registered worktrees, including paths hidden by the sandbox, plus a stale registration. Startup, discard and sandboxed Git operations must preserve the surviving registrations. Test the Git/bubblewrap boundary itself, not only a mocked command list. Explicit worktree removal may remove only its intended registration.

Sandboxed maintenance preserves stale registrations because it cannot establish that every registered directory is visible. Perform intentional repository-wide cleanup from the owner's full host view after verifying the worktrees; do not infer deletion from sandbox visibility.

## Acceptance reporting

Report the commit, exact commands, passed/failed/skipped counts and which external systems were real or faked. Use [IMPLEMENTATION.md](IMPLEMENTATION.md) for current limitations and [the benchmark guide](bench/README.md) for optional-assistance comparisons. Do not turn fixture token totals or model estimates into measured savings claims.

The initial candidate failed follow-up native acceptance despite passing service health probes. Re-run the two regression scenarios above on the corrected candidate before claiming deployment readiness. Historical native-agent acceptance is retained in [V2.md](V2.md); it does not certify newer code or provider versions. Physical-phone acceptance and real account benchmarks require separate evidence.
