# ContextLanes — product brief

## The five W's

- **Who:** one developer running Claude Code, Codex and local models in parallel across a handful of their own repos, often away from the desk.
- **What:** an open-source, self-hosted workspace for agent **lanes**. Start a lane (agent, model, worktree, terminal, running app), talk to it, approve and interrupt it, and see its steps and thinking, where in the code it is working and what it costs. Then review and merge with evidence.
- **When:** starting work (brief lanes for a goal), while it runs (glance, answer, approve), at review (merge or send back), overnight (scheduled lanes), end of week (insights: what happened, what to change).
- **Where:** an always-on machine on your Tailscale network, opened from any browser, your phone, Telegram or the CLI. Local models run on that machine's GPUs.
- **Why:** parallel agents get lost across terminals; review is the bottleneck, not writing; context fills with tool definitions and re-reads; ports, previews and approvals are still manual.

## Where it wins

1. A running app per lane with its own private link.
2. Review packets: checks, before and after screenshots, plan vs done, process signal, diff.
3. One inbox across Claude, Codex and local agents, with enough context to answer from a phone.
4. Collision warnings on a real architecture view when two lanes touch the same module, with a merge order.
5. Measured token savings and evidence-based insights per project.

Chat, terminals and phone remotes are table stakes; we borrow them.

## Boundary

All-in-one for agent-driven work on your own repos: work starts, gets steered, checked and merged here. Not an IDE (open in your editor), not the agents themselves, not GitHub (PRs and CI stay there), not deploys or production monitoring, not a team SaaS, not a model gateway. The test for a new feature: does it shorten the start → answer → check → merge loop?

## How we will know it works

- Under 5 minutes from an agent getting stuck to your answer, when you are around
- Under 5 minutes to review a checkpoint
- 30% fewer cloud tokens per lane on the same tasks
- 3 to 5 lanes in parallel without conflicts
- No ports, previews or env files set up by hand

## Local models

- **Helper:** Claude or Codex stays the lead on every lane and hands reading, small edits and test runs to a local model through the `delegate` tool. Each kind stays on only while it pays: tokens saved and how often the lead redid the work are tracked.
- **Insights:** a scheduled local-model job (nightly and after each merge) reads the event log, git, CodeGraph and test results and writes a weekly summary and suggestions. Each suggestion cites its evidence and offers one action; nothing is applied without a click.

## Scope

- **Phase 1:** lanes and lane hosts, Claude and Codex over ACP, Work, Inbox and terminals, phone and Telegram, setup.
- **Phase 2:** recipes and lane setup, a private link per lane, review packets, merge and cleanup.
- **Phase 3:** code map and briefs, Architecture and collision warnings, local helper, Insights.
- **Phase 4:** overview graph polish, schedules, more agents, routing.

See [IMPLEMENTATION.md](IMPLEMENTATION.md) for the build plan and gates.
