# ContextLanes

Run several coding agents in parallel **lanes** on an always-on machine, steer them from your browser, phone or terminal, and review their work with evidence.

Each lane is a branch and worktree, a persistent terminal, a running copy of your app with its own private link, and an agent session (Claude Code, Codex, OpenCode and other ACP agents) that keeps going when you close your laptop. Everything waiting on you lands in one inbox you can answer from your phone.

> Phases 1 and 2 are built: lanes you steer from the browser, phone or terminal, a running copy of your app per lane, review packets and merge. Real agent logins, a real merge with `gh`, providers and a physical phone still need checking on a real machine; see [Needs Kyle](docs/IMPLEMENTATION.md#needs-kyle).

## Install

On Linux with a running systemd user manager, Node ≥22.13 (24 recommended), npm, Git, tmux and bubblewrap:

```sh
curl -fsSL https://raw.githubusercontent.com/wongywrongy/contextlane/main/install.sh | sh
~/.local/bin/contextlanes setup
```

Open the printed sign-in link or scan its QR code. Shell access claims ownership; there is no setup code to type. The link works once and expires after ten minutes. Setup checks linger and turns on Tailscale Serve when signed in; otherwise it prints an install link and SSH tunnel fallback. Then connect an agent, add repositories (the ones your agents already use are listed) and start your first lane.

Configuration lives in `~/.config/contextlanes/config.toml` and everything else in `~/.local/share/contextlanes`. The daemon binds 127.0.0.1. To keep services running after logout: `sudo loginctl enable-linger "$USER"`.

## Update

```sh
contextlanes update            # install the newest version and restart; lanes keep running
contextlanes update --check    # list what is new, change nothing
contextlanes update --rollback # go back one version
```

Each version is built in its own folder (`releases/<commit>`) next to the running one, so a failed build changes nothing. The database is copied first. If the new version does not come up healthy within 30 seconds, it switches back by itself. Lanes run as their own services and keep going through the restart. Running the install line again on an installed machine does the same update, which is how an install from before `contextlanes update` existed gets it. Updates follow the repository's default branch; to follow another, install with `curl -fsSL … | CONTEXTLANES_BRANCH=<branch> sh` or run `contextlanes update --branch <branch>` once.

## From source

```sh
pnpm install
pnpm check
pnpm build
node apps/daemon/dist/main.js
# In another terminal:
node apps/cli/dist/main.js setup
# Open the sign-in link printed above.
```

To install this built checkout as a service, run `node apps/daemon/dist/install-main.js`. A source checkout updates with `git pull`, `pnpm install`, `pnpm build` and a restart; `contextlanes update` manages only copies made by the install line. Add `~/.local/bin` to your PATH for the `contextlanes` commands. `pnpm dev` runs the daemon and Vite for development; build host/toolbox entry points first.

```sh
~/.local/bin/contextlanes status
~/.local/bin/contextlanes add                   # current repository
~/.local/bin/contextlanes add ~/code/project
~/.local/bin/contextlanes lanes
~/.local/bin/contextlanes lane start <project> "Add a health check" --agent codex
~/.local/bin/contextlanes term <project>/01
systemctl --user restart contextlanes
journalctl --user -u contextlanes -n 50
```

Closing a terminal tab keeps its tmux shell running. Reattach in **Work → Terminal** or with the CLI. Older history is in tmux copy mode: **Ctrl+B**, then **[**; **q** to leave. Each terminal runs in its own small process (`apps/daemon/bin/pty-host.py`, Python's standard library), so no native module needs building and a crashed terminal never takes the app down.

## Validate

```sh
pnpm check
# This machine has tmux and systemd --user, so also run:
CONTEXTLANES_REAL_HOSTS=1 CONTEXTLANES_REAL_TERMINAL=1 pnpm check
# With an existing Playwright installation and Chromium:
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs CHROMIUM_BIN=/absolute/path/to/chrome node scripts/check-setup.mjs
```

Real checks use disposable repositories, tmux sessions and systemd units. The setup browser check uses the SDK fake agent, a fake login terminal, Runner-faked Tailscale and Chromium’s virtual authenticator; no model or user credentials are needed. It follows actual CLI output to a running lane at 1440px and 390px, without typing a path or setup code, and checks passkey creation and link replay. It does not provision a fresh OS or replace physical-phone/provider acceptance.

## Docs

- [Brief](docs/BRIEF.md): what it is, for whom, and how we will know it works
- [Architecture](docs/ARCHITECTURE.md): processes, data, interfaces, security
- [Implementation plan](docs/IMPLEMENTATION.md): phases, milestones and gates
- [Design](docs/DESIGN.md): visual system, page jobs and legend
