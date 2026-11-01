# CLI benchmark

Copy tasks.example.json to a local file, replace every placeholder, and use 3–5 real tasks with objective checks. Set an explicit model and the same agent for the comparison. Register the project first. Each task starts two fresh CLI worktrees from one pinned commit; the baseline gets no ContextLanes MCP tools, notes or briefs. Your repository's own agent instructions still apply to both.

Run `contextlanes bench /path/to/tasks.json`. Answer permissions in the Inbox or terminal as usual; the benchmark never approves them. Codex requires reviewing each lane's hooks in `/hooks` before starting its task. Do not change the task, model or input in one lane without doing the same in the other. The run finishes on the native Stop hook, then executes the argument-array check inside the lane sandbox. Checks must exit nonzero on failure. No checkpoint or commit is required. Lanes remain available for inspection and normal cleanup afterward.

The printed table counts reported cloud input, output and cache tokens. The saved `<data>/bench/<id>.json` also records the pinned commit, agent/model selection, duration and check result. A missing metric stays unknown; do not interpret it as zero. `model: null` in a saved result means the native CLI's default was used; use an explicit model for the real gate.

The real gate is at least 30% fewer cloud tokens in aggregate with checks passing at the same rate. Fake-agent savings verify plumbing only. Kyle should write the Yunavero tasks, run them, and paste the real table into docs/V2.md. No benchmark on a personal repository is run automatically.
