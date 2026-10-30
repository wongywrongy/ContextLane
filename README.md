# ContextLanes

Run several coding agents in parallel **lanes** on an always-on machine, steer them from your browser, phone or terminal, and review their work with evidence.

Each lane is a branch and worktree, a persistent terminal, a running copy of your app with its own private link, and an agent session (Claude Code, Codex, OpenCode and other ACP agents) that keeps going when you close your laptop. Everything waiting on you lands in one inbox you can answer from your phone.

> Phase 1 implementation is complete. Independent ACP hosts, human permissions, phone notifications, persistent terminals, Work and first-run setup are implemented. Real agent logins, provider delivery, fresh-machine and physical-phone acceptance still need Kyle; the week-long usage gate has not been claimed. See [Needs Kyle](docs/IMPLEMENTATION.md#needs-kyle). Phase 2 has not started.

## Install

On Linux with a running systemd user manager, Node ≥22.13 (24 recommended), npm, Git and tmux:

```sh
curl -fsSL https://raw.githubusercontent.com/wongywrongy/rootlane/contextlanes/install.sh | sh
~/.local/bin/contextlanes setup
```

Open the printed `http://localhost:4600/setup` URL and enter the claim code. The wizard handles ownership, remote access, agent adapter installs, projects, notifications and your first lane without editing a file. Agent logins remain interactive terminal commands displayed in the wizard. Use localhost for a local passkey; passkeys cannot be registered at an IP address. Remote access uses the owner’s Tailscale identity and HTTPS.

The installer refuses existing destinations and unrelated service/bin files. Configuration lives in `~/.config/contextlanes/config.toml`, data in `~/.local/share/contextlanes`, and lane worktrees in `~/lanes`. Both daemon and development UI bind 127.0.0.1. To keep services running after logout: `sudo loginctl enable-linger "$USER"`.

## From source

```sh
pnpm install
pnpm check
pnpm build
node apps/daemon/dist/main.js
# In another terminal:
node apps/cli/dist/main.js setup
# Open http://localhost:4600/setup
```

To install this built checkout as a service, run `node apps/daemon/dist/install-main.js`. Add `~/.local/bin` to your PATH for the `contextlanes` commands. `pnpm dev` runs the daemon and Vite for development; build host/toolbox entry points first.

```sh
~/.local/bin/contextlanes status
~/.local/bin/contextlanes lanes
~/.local/bin/contextlanes lane start <project> "Add a health check" --agent codex
~/.local/bin/contextlanes term <project>/01
systemctl --user restart contextlanes
journalctl --user -u contextlanes -n 50
```

Closing a terminal tab keeps its tmux shell running. Reattach in **Work → Terminal** or with the CLI. Older history is in tmux copy mode: **Ctrl+B**, then **[**; **q** to leave. The native terminal module loads only on attachment. On Debian/Ubuntu, `sudo apt install python3 build-essential` supplies the native build tools; after installing them, run `pnpm --filter @contextlanes/daemon rebuild node-pty` in the installed checkout if needed.

## Validate

```sh
pnpm check
# This machine has tmux and systemd --user, so also run:
CONTEXTLANES_REAL_HOSTS=1 CONTEXTLANES_REAL_TERMINAL=1 pnpm check
# With an existing Playwright installation and Chromium:
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs CHROMIUM_BIN=/absolute/path/to/chrome node scripts/check-setup.mjs
```

Real checks use disposable repositories, tmux sessions and systemd units. The setup browser check uses the SDK fake agent and Chromium’s virtual authenticator; no model or user credentials are needed. It exercises claim, config, first lane, permission and restart end to end. It does not provision a fresh OS or replace physical-phone/provider acceptance.

## Docs

- [Brief](docs/BRIEF.md): what it is, for whom, and how we will know it works
- [Architecture](docs/ARCHITECTURE.md): processes, data, interfaces, security
- [Implementation plan](docs/IMPLEMENTATION.md): phases, milestones and gates
- [Design](docs/DESIGN.md): visual system, page jobs and legend
