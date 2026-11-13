# Workflow: verified checkpoints and integration

Ported 2026-11-12 from `codex/reliable-agent-workflows` onto the v4 line. This is the contract for review: task → verified checkpoint → approval → confirmed integration. [ARCHITECTURE.md](ARCHITECTURE.md) describes processes and the runtime; [V4.md](V4.md) is where the runtime is going.

**Where it runs today.** On the host runtime (`[runtime] mode = "host"`, with `[features] review`). In the Docker runtime, checkpoint, review, approve and clean up still answer `501 not_yet` (V4.md 8f). Phase 5 builds them inside the lane container to this contract: the disposable snapshot becomes a second checkout in a helper or lane container, and nothing else below changes.

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

## Current contract

| Capability | Contract |
|---|---|
| Native and ACP lanes | Native Claude/Codex in tmux, or a separate ACP host; browser disconnect does not stop work |
| Inbox and controls | Durable questions, owner decisions and input; native behavior remains available in the terminal |
| Workspaces | Branch/worktree per ordinary lane; approved recipe for setup, app services, previews and checks |
| Checkpoints | Integrate the target, test a disposable snapshot with its own database, and bind passing evidence to that commit and approved recipe |
| Check failures | Persist up to two repair turns with their queued commands; continued failure creates an Inbox question, and authenticated owner guidance resets the budget |
| Pull requests | Approval opens a PR; `pr_open` remains until actual merge and target-branch ancestry are confirmed |
| Child integration | Approval enters `integration_pending`; the parent receives the approved SHA, and ancestry confirms integration |
| Cleanup | Requires verified integration and refuses unsaved or unpushed work |
| Optional assistance | Code maps, helpers and fresh-session reviews pinned to the checkpoint; no assumed quality or token-saving benefit |
| Usage | Reported cloud/helper usage stays separate; missing values are not zero and hypothetical savings are not shown |

Checks run when a checkpoint is requested; native turn completion alone does not trigger them. Setup and checks run against the pinned snapshot, with copied dependencies and a separate database. They must not modify tracked source: commit generated source before requesting checks. A changed live commit or recipe also needs fresh evidence. The repair budget survives daemon restarts, and the owner retains final approval.

Native `UserPromptSubmit` events do not prove who supplied a prompt: queued system input passes through the same hook. Reset an exhausted repair cycle through the authenticated owner interface or its Inbox acknowledgement. An ordinary terminal prompt alone does not grant a new automatic repair budget.

A recipe with no checks can still be reviewed and approved, but is explicitly unverified by tests. Passing checks establish only the behavior those checks cover. Model verdicts and screenshots do not replace the required checks.

## Provider and operational limits

- The recorded November 1 native checks used Claude Code 2.1.316 and Codex 0.166.0. They establish those tested behaviors, not compatibility with every later version.
- New Codex lane-local hooks require native review/trust in `/hooks`, then an agent restart so SessionStart is observed. In the tested Codex version, a synchronous permission hook waiting for the Inbox prevents simultaneous native-terminal approval. Inbox approval, interruption and daemon-loss fallback were tested.
- The tested Claude interruption path emits no Stop hook. Remote input can remain queued until another reported turn end; the terminal remains usable. ContextLanes does not invent idleness after Escape.
- Native lane-local configuration and login copies do not follow later global edits or refreshed credentials automatically.
- Notification transports, official Claude Remote Control, physical-phone behavior and account eligibility need checks on the intended deployment. Phone-sized browser fixtures are not device acceptance.
- Bubblewrap constrains files, but lanes share the host network. Access to local services and external hosts is not restricted by a network allowlist. See [trust boundaries](#trust-boundaries).
- Local-model endpoints and optional preview modes require their actual services and credentials. Fake transports establish API behavior only.
- A checkpoint based on a commit SHA or tag cannot open a PR without a named target branch. Create publication work against a branch; there is no retarget control. Child approval also invalidates a pending parent checkpoint until integration is checked again.
- The benchmark coordinator does not resume after daemon restart. Its native lanes survive; keep the daemon running during measurement.

[RELEASE-REVIEW.md](RELEASE-REVIEW.md) records Codex's own checks on the branch this came from.

## Trust boundaries

These describe the host runtime. In the Docker runtime the lane's container replaces bubblewrap and the shared host network (V4.md 3.5); the owner API, native hook, command permission and daemon git rules hold on both.

- **Owner API:** loopback is a network location, not an identity. Protected routes require a valid owner session, local CLI credential, scoped ticket or lane capability. Lane tokens grant only their lane's observation/tool operations, not owner decisions.
- **Native hooks:** hooks transport native observations; a prompt observation does not authenticate its author. Queued repair input uses the same native hook as terminal input, so it cannot reset a repair budget or acknowledge an owner-only repair question. Authenticated owner guidance is a separate daemon event. Hooks return no decision on daemon connection failure, allowing the native CLI to fall back to its own prompts. Provider hook support and native trust remain prerequisites; see [current limits](#provider-and-operational-limits).
- **Command permissions:** Auto is an explicit owner choice. Its fixed guard can hold commands for review; it is not a proof that an arbitrary script or dependency is safe. Model instructions cannot replace enforced restrictions.
- **Filesystem:** lane execution uses bubblewrap with read-only host mounts, a writable lane checkout and explicit Git metadata/agent-state grants. Temporary files and package caches are private to the sandbox, and process visibility uses a private PID namespace. Known SSH/cloud credential paths are masked; selected native-agent credentials are deliberately copied into lane state. Other host files can remain readable. Common Git metadata remains shared between a repository's worktrees. The daemon runs outside that boundary, so every read/write of an agent-controlled path must use safe filesystem helpers. Those helpers pin directories, reject unsupported file types and prevent following paths outside the permitted root.
- **Host network:** lanes retain the host network, including access to local services. This is not an isolated cloud VM and there is no egress allowlist. Local services must authenticate requests; credentials intentionally supplied to a lane remain usable by that lane.
- **Daemon git/gh:** commands use confined runners with executable git hooks/fsmonitor disabled. A restricted filesystem view cannot safely prune shared worktree registrations: hidden directories are not evidence of deleted worktrees. Automatic maintenance is disabled and registrations are preserved for owner-directed cleanup from a full host view. The daemon is the privileged side of this relationship; do not execute agent-provided commands there.
- **Installation and updates:** CLI credential delivery requires a fresh nonce/HMAC proof from the listener and rejects redirects. Releases are built beside the running one; database backup and health checks protect the switch. Lane sessions are not restarted as part of a normal daemon update. Failed startup never silently restores an older database: uncertain schema compatibility stops the daemon for an owner decision. [Installation and recovery](INSTALLATION.md) defines the managed layout and retained Docker boundary.

The [sandbox implementation](../apps/daemon/src/sandbox.ts), [filesystem helpers](../apps/daemon/src/safefs.ts), [HTTP auth](../apps/daemon/src/http/auth.ts) and [permission rules](../apps/daemon/src/permissions.ts) are the source of truth for these boundaries. Host-level isolation and real external effects require separate verification; a passing fake-runner test cannot establish them.

## Acceptance still required

Nothing here has run against a real agent, a real pull request or neo. Unit and fixture tests pass.

Run acceptance against a disposable project before trusting a deployment for unattended work:

1. Start native Claude and Codex tasks with configured checks. Confirm that failing or stale checks cannot be approved, and that fixing the task produces fresh evidence.
2. Open a real PR, verify it remains pending, merge through the repository's policy, and confirm ContextLanes records the merge before cleanup. Also exercise an unmerged closed PR and a child awaiting integration.
3. Keep concurrent lanes working through browser disconnect and daemon restart. Confirm pending permissions, input and failures remain visible.
4. Verify the intended phone notification transport and its single-use answer on the real device.
5. Run representative tasks with optional assistance enabled and disabled. Compare passing outcomes, owner effort, time and reported usage; do not substitute estimated helper compression for measured savings.

No fixed token-reduction target is a release gate. Keep optional features when representative results justify their cost and complexity.
