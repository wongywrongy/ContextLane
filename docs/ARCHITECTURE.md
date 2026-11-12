# Architecture

ContextLanes coordinates coding work on one Linux host. A lane owns a task, branch/worktree, agent session and optional app environment. The daemon records observations and owner decisions, executes checks, and tracks integration. Native agents remain responsible for coding and their own conversational context.

## Processes and code

| Component | Lifetime and responsibility | Source |
|---|---|---|
| Daemon | systemd user service; authenticated HTTP, SQLite, event streams, environments, review | `apps/daemon` |
| Native CLI lane | Claude Code or Codex in tmux; native hooks report turns, tools and permissions | `apps/daemon/src/lanes/cli.ts`, `hooks.ts`, `lanes/input.ts` |
| ACP lane host | Separate systemd process holding an agent session; survives daemon restart | `apps/lanehost` |
| Toolbox | Lane-scoped MCP tools for environments, checkpoints, optional context and child tasks | `packages/toolbox` |
| App services | systemd units with recipe-provided commands, lane ports and database configuration | `apps/daemon/src/runtime.ts` |
| Browser and CLI | Observe events, send input and perform authenticated owner actions | `apps/web`, `apps/cli` |

Claude Code and Codex default to native CLI lanes. ACP remains available for supported agents. Native terminal attachments share the lane's tmux session; detaching a browser or CLI client does not kill it. CLI input waits for observed turn completion. ACP hosts retain their session while reconnecting to the daemon.

## State and evidence

SQLite uses WAL. Events have gap-free per-lane sequence numbers; replayed host observations are deduplicated by source ID. Commands are durable until acknowledged. Owner permission answers are recorded once. Lane state changes go through the store alongside their events.

| State | Meaning |
|---|---|
| `setting_up` | Checkout, agent or environment is being prepared |
| `working` | Work may continue; an idle agent is still not a verified result |
| `needs_you` | A question or permission is waiting |
| `in_review` | A checkpoint is ready for an owner decision |
| `pr_open` | The approved commit has a pull request; it is not confirmed merged |
| `integration_pending` | A child commit was approved for its parent; integration is not yet confirmed |
| `merged` | The approved change's actual integration has been verified |
| `cleaned` | Lane processes and disposable checkout resources have been removed |

`draft`, `paused`, `failed` and `archived` cover preparation and interrupted work. See `packages/protocol/src/states.ts` for permitted transitions.

A requested checkpoint resolves and integrates its target base, then runs configured checks in a disposable worktree pinned to the resulting commit. The snapshot gets its own prepared database, copied dependencies and recipe setup. Checks cannot borrow uncommitted source from the live lane. If setup or checks modify tracked source, generated source must be committed before requesting another checkpoint. Live commit or recipe drift also invalidates the result.

Failed checks return their output to the agent for at most two repair turns per review cycle. The repair request and queued command are persisted atomically; continued failure creates a durable Inbox question. Owner guidance resets the repair budget. Native Stop events alone do not request checkpoints.

A successful checkpoint binds the diff, checks and screenshots to a commit, its integrated base and the approved recipe hash. Approval rejects changed commits, changed recipes, stale bases and missing/failed configured checks. It pushes the reviewed SHA without a post-review rebase. A recipe without checks is displayed as having no checks; owner approval does not manufacture test coverage.

Approval opens a PR and enters `pr_open`. GitHub remains responsible for CI and the merge action. Reconciliation confirms the PR's approved head/base and verifies its merge commit against the fetched target branch before setting `merged`. A child enters `integration_pending` until its approved commit is an ancestor of the parent's head. Approving a child invalidates any pending parent checkpoint; the parent must integrate and produce fresh evidence. Cleanup rechecks integration and unsaved work. Code: `checker.ts`, `review.ts`, `sublanes.ts`.

## Environments and optional assistance

An owner approves the exact recipe bytes. The recipe supplies setup commands, services, ports, health checks, checks and optional database copies. Services bind to loopback; previews use configured local or tailnet routing. A `.localhost` preview works only on the browser's own machine, so remote phones need a tailnet preview mode. See [RECIPES.md](RECIPES.md).

Code maps and collision warnings observe overlapping work; they do not guarantee merge compatibility. Briefs, helpers, judges, independent reviewers and insights are optional consumers of project data and events. Independent review uses a fresh read-only session pinned to the checkpoint head, including when the same provider performs both implementation and review. Model findings remain advisory. Native cloud usage, provider-reported helper usage and paired benchmark results are separate measurements; none is replaced with a hypothetical savings estimate.

Automatic plan and context-management prompts are absent. Optional long-turn check-ins are passive observations, off by default; they do not inject messages into the agent session.

Parent lanes can propose child tasks, inspect their status and send them messages. The owner authorizes the proposal and integration decisions. Child tasks are bounded to one level; they do not acquire owner permissions or silently expand the allowed work.

## Trust boundaries

- **Owner API:** loopback is a network location, not an identity. Protected routes require a valid owner session, local CLI credential, scoped ticket or lane capability. Lane tokens grant only their lane's observation/tool operations, not owner decisions.
- **Native hooks:** hooks transport native observations; a prompt observation does not authenticate its author. Queued repair input uses the same native hook as terminal input, so it cannot reset a repair budget or acknowledge an owner-only repair question. Authenticated owner guidance is a separate daemon event. Hooks return no decision on daemon connection failure, allowing the native CLI to fall back to its own prompts. Provider hook support and native trust remain prerequisites; see [current limits](IMPLEMENTATION.md#provider-and-operational-limits).
- **Command permissions:** Auto is an explicit owner choice. Its fixed guard can hold commands for review; it is not a proof that an arbitrary script or dependency is safe. Model instructions cannot replace enforced restrictions.
- **Filesystem:** lane execution uses bubblewrap with read-only host mounts, a writable lane checkout and explicit Git metadata/agent-state grants. Temporary files and package caches are private to the sandbox, and process visibility uses a private PID namespace. Known SSH/cloud credential paths are masked; selected native-agent credentials are deliberately copied into lane state. Other host files can remain readable. Common Git metadata remains shared between a repository's worktrees. The daemon runs outside that boundary, so every read/write of an agent-controlled path must use safe filesystem helpers. Those helpers pin directories, reject unsupported file types and prevent following paths outside the permitted root.
- **Host network:** lanes retain the host network, including access to local services. This is not an isolated cloud VM and there is no egress allowlist. Local services must authenticate requests; credentials intentionally supplied to a lane remain usable by that lane.
- **Daemon git/gh:** commands use confined runners with executable git hooks/fsmonitor disabled. A restricted filesystem view cannot safely prune shared worktree registrations: hidden directories are not evidence of deleted worktrees. Automatic maintenance is disabled and registrations are preserved for owner-directed cleanup from a full host view. The daemon is the privileged side of this relationship; do not execute agent-provided commands there.
- **Installation and updates:** CLI credential delivery requires a fresh nonce/HMAC proof from the listener and rejects redirects. Releases are built beside the running one; database backup and health checks protect the switch. Lane sessions are not restarted as part of a normal daemon update.

The [sandbox implementation](../apps/daemon/src/sandbox.ts), [filesystem helpers](../apps/daemon/src/safefs.ts), [HTTP auth](../apps/daemon/src/http/auth.ts) and [permission rules](../apps/daemon/src/permissions.ts) are the source of truth for these boundaries. Host-level isolation and real external effects require separate verification; a passing fake-runner test cannot establish them.

## Verification and history

[DEVELOPING.md](DEVELOPING.md) lists repeatable checks and their prerequisites. [IMPLEMENTATION.md](IMPLEMENTATION.md) separates current behavior from acceptance still outstanding. The [original implementation record](IMPLEMENTATION-HISTORY.md) and [V2 record](V2.md) preserve dated results; neither is required startup context for an agent.
