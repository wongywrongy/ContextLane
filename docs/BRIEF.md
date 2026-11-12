# Product brief

ContextLanes helps one developer run parallel coding tasks on an always-on Linux machine and decide what is ready to integrate. Agents handle implementation; the surrounding workflow supplies isolated workspaces, bounded permissions, reproducible checks, review evidence and truthful integration status.

## Core workflow

1. Define the desired behavior and how to verify it.
2. Start a lane with a branch, checkout, agent and approved environment recipe.
3. Let the agent work; answer genuine questions and permission requests through one inbox.
4. Verify the final commit with the configured checks. Inspect the diff, output and optional screenshots or independent review.
5. Request fixes or approve the result. Track the pull request or parent integration until it is actually merged; then clean up.

Parallel work should reduce the owner's coordination burden. Parent lanes can propose bounded child tasks and inspect their results. A child finishing a turn is not proof that it satisfied its task.

## Product boundaries

Keep the native agents' capabilities and session behavior. Add workflow enforcement where a prompt is insufficient: permission boundaries, check execution, evidence freshness and integration tracking. GitHub owns PR policy and CI. The user's editor remains available for direct work.

Code maps, briefs, local helpers, judges and usage views are optional. Keep them only when they improve verified results or reduce effort on representative work. Do not fill context with information agents can discover, impose a plan on every task, or treat model opinion as passing evidence.

## Success criteria

| Outcome | Evidence to collect |
|---|---|
| Work continues without the browser | Native sessions survive disconnects and daemon restarts; failures become visible |
| Reviews are trustworthy | Required checks pass on the exact reviewed commit; changed code or recipes invalidate old evidence |
| Completion means integration | PR creation, pending parent integration, confirmed merge and cleanup remain distinct |
| Parallelism is useful | Representative concurrent tasks reach verified integration, with conflicts and owner interventions recorded |
| Setup is repeatable | An approved recipe recreates services, ports, environment and checks for another lane |
| Assistance pays for itself | Compare completion quality, wall time, owner effort and reported cloud usage with assistance enabled and disabled |

There is no promised token-reduction percentage. Short fixtures establish implementation behavior; real tasks, real device delivery and sustained daily use establish product outcomes. [Current status](IMPLEMENTATION.md) keeps those forms of evidence separate.
