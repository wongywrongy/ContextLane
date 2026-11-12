# Compare optional assistance

Use the benchmark to decide whether ContextLanes notes, briefs and helpers improve your work. There is no target savings percentage. Compare correctness first, then elapsed time, owner interventions and reported cloud tokens.

Copy [tasks.example.json](tasks.example.json), replace the placeholders and choose representative tasks with objective checks. Set an explicit model and the same agent for both runs. Register the project first. Each pair starts from one pinned commit in separate worktrees; the baseline has no ContextLanes MCP tools, notes or briefs. Repository instructions apply to both.

```sh
contextlanes bench /path/to/tasks.json
```

Answer permissions normally. For Codex, review each lane's hooks in `/hooks` before relying on observation. Keep the task, model and additional owner input comparable. The harness finishes after the first completed native task/turn with no queued prompt, then runs the task's check in the lane sandbox. An idle turn is not by itself a successful result. Checks must exit nonzero when acceptance fails; no agent checkpoint or commit is required.

The table counts reported cloud input, output and cache tokens. `<data>/bench/<id>.json` records the pinned commit, agent, model, duration and check result. Missing usage stays unknown. `model: null` means the native default was used, which weakens reproducibility. Provider-reported helper usage is separate from cloud usage. Historical helper compression estimates are not measured cloud savings and should not be substituted for native usage.

Inspect the actual changes and repeat the comparison before drawing conclusions from a small sample. Record any manual corrections or approvals outside the table. A lower token count is not an improvement if completion quality falls or the owner must redo the work.

The benchmark coordinator does not resume after a daemon restart, although its lanes survive. Keep the daemon running during a comparison. Fake-agent results test the harness only; they establish no real savings. Real account benchmarks and production rollout have not been performed as part of this revision.
