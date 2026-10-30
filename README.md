# ContextLanes

Run several coding agents in parallel **lanes** on an always-on machine, steer them from your browser, phone or terminal, and review their work with evidence.

Each lane is a branch and worktree, a persistent terminal, a running copy of your app with its own private link, and an agent session (Claude Code, Codex, OpenCode and other ACP agents) that keeps going when you close your laptop. Everything waiting on you lands in one inbox you can answer from your phone.

> Status: phase 1 in progress. Lanes have persistent browser terminals and independent systemd ACP hosts with reconnect, human permissions and prompt controls. Real adapter installs/logins still need acceptance; notifications and setup are next. See [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) for status and what needs Kyle.

## Try the scaffold

```sh
pnpm install
pnpm check
pnpm build               # host and toolbox entry points used by systemd
pnpm dev                 # daemon on 127.0.0.1:4600, web app on Vite's port

# in another terminal
node apps/cli/dist/main.js status
curl -X POST localhost:4600/api/projects -H 'content-type: application/json' -d '{"path":"/path/to/a/git/repo"}'
node apps/cli/dist/main.js lane start <project> "Add a health check"
node apps/cli/dist/main.js lanes
node apps/cli/dist/main.js term <project>/01      # your shell in the lane (tmux)
```

Open the web app at `http://127.0.0.1:5173`, choose the project, then **Work → Terminal**. Closing the tab keeps the shell running. Reattach with the CLI command above; older history is in tmux copy mode (**Ctrl+B**, then **[**; **q** to leave).

Requires Node ≥ 22.13 (24 recommended), pnpm 10, git and tmux. On Linux, node-pty builds a native module: install Python 3 and a C/C++ toolchain (Debian/Ubuntu: `sudo apt install python3 build-essential`) before `pnpm install`. Its build is allowlisted in `pnpm-workspace.yaml`. Configuration lives in `~/.config/contextlanes/config.toml`; the daemon and Vite bind `127.0.0.1`.

To check real terminal persistence using a disposable repository and tmux session:

```sh
CONTEXTLANES_REAL_TERMINAL=1 pnpm exec vitest run apps/daemon/test/terminal.real.test.ts
```

## Docs

- [Brief](docs/BRIEF.md): what it is, for whom, and how we will know it works
- [Architecture](docs/ARCHITECTURE.md): processes, data, interfaces, security
- [Implementation plan](docs/IMPLEMENTATION.md): phases, milestones and gates
- [Design](docs/DESIGN.md): visual system, page jobs and legend
