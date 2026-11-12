# Current implementation status

The current workflow is task → verified checkpoint → approval → confirmed integration. The surrounding system should make completion and permissions trustworthy while leaving coding and routine context management to native agents.

This document describes the active contract. Dated build history is retained in [IMPLEMENTATION-HISTORY.md](IMPLEMENTATION-HISTORY.md) and [V2.md](V2.md); older status tables and savings targets there are historical.

Follow-up acceptance exposed two release blockers in the initial candidate: queued native repair prompts reset the retry budget, and Git pruning inside the sandbox could delete valid worktree registrations. The corrections require fresh native acceptance; healthy service probes and passing unit tests alone are insufficient.

## Current capabilities

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
- Bubblewrap constrains files, but lanes share the host network. Access to local services and external hosts is not restricted by a network allowlist. See [trust boundaries](ARCHITECTURE.md#trust-boundaries).
- Local-model endpoints and optional preview modes require their actual services and credentials. Fake transports establish API behavior only.
- A checkpoint based on a commit SHA or tag cannot open a PR without a named target branch. Create publication work against a branch; there is no retarget control. Child approval also invalidates a pending parent checkpoint until integration is checked again.
- The benchmark coordinator does not resume after daemon restart. Its native lanes survive; keep the daemon running during measurement.

## Acceptance still required

Run acceptance against a disposable project before trusting a deployment for unattended work:

1. Start native Claude and Codex tasks with configured checks. Confirm that failing or stale checks cannot be approved, and that fixing the task produces fresh evidence.
2. Open a real PR, verify it remains pending, merge through the repository's policy, and confirm ContextLanes records the merge before cleanup. Also exercise an unmerged closed PR and a child awaiting integration.
3. Keep concurrent lanes working through browser disconnect and daemon restart. Confirm pending permissions, input and failures remain visible.
4. Verify the intended phone notification transport and its single-use answer on the real device.
5. Run representative tasks with optional assistance enabled and disabled. Compare passing outcomes, owner effort, time and reported usage; do not substitute estimated helper compression for measured savings.

No fixed token-reduction target is a release gate. Keep optional features when representative results justify their cost and complexity.

## Validation records

Use [DEVELOPING.md](DEVELOPING.md) for repeatable checks. Record the commit, command, results, skipped tests and real/faked dependencies when reporting validation. The historical V2 fixtures contain real native-agent observations and fake benchmark totals; the totals verify harness accounting only.

The initial candidate failed follow-up acceptance. Corrected code must pass a fresh target-host acceptance run before deployment readiness is claimed. A real account benchmark and physical-phone acceptance remain separate checks.
