# ContextLanes

Run several coding agents in parallel **lanes** on an always-on machine, steer them from your browser, phone or terminal, and review their work with evidence.

Each lane is a branch and worktree, a persistent terminal, a running copy of your app with its own private link, and an agent session (Claude Code, Codex, OpenCode and other ACP agents) that keeps going when you close your laptop. Everything waiting on you lands in one inbox you can answer from your phone.

> Status: early. This branch is a fresh start; the scaffold builds and runs a lane end to end (worktree, terminal, events, live stream). See [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) for what is next.

## Try the scaffold

```sh
pnpm install
pnpm check
pnpm dev                 # daemon on 127.0.0.1:4600, web app on Vite's port

# in another terminal
node apps/cli/dist/main.js status
curl -X POST localhost:4600/api/projects -H 'content-type: application/json' -d '{"path":"/path/to/a/git/repo"}'
node apps/cli/dist/main.js lane start <project> "Add a health check"
node apps/cli/dist/main.js lanes
node apps/cli/dist/main.js term <project>/01      # your shell in the lane (tmux)
```

Requires Node ≥ 22.13 (24 recommended), pnpm 10, git and tmux. Configuration lives in `~/.config/contextlanes/config.toml`.

## Docs

- [Brief](docs/BRIEF.md): what it is, for whom, and how we will know it works
- [Architecture](docs/ARCHITECTURE.md): processes, data, interfaces, security
- [Implementation plan](docs/IMPLEMENTATION.md): phases, milestones and gates
- [Design](docs/DESIGN.md): visual system, page jobs and legend
