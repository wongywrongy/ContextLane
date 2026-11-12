# ContextLanes

Run coding agents in parallel on an always-on Linux machine. Give each task a checkout and running app, answer questions from one inbox, and review the checks and diff before opening a pull request.

![A lane's progress, terminal and review controls](docs/screenshot.webp)

- **Persistent work.** Claude Code and Codex run as native CLIs in tmux. ACP agents run in separate lane-host processes. Closing your laptop does not stop them.
- **Separate lanes.** Each task normally gets its own branch, worktree and terminal. Approved recipes set up app services, previews and checks.
- **Review evidence.** Configured checks must pass on the commit under review; failed checks return to the agent for bounded repair. Pull requests and parent-lane integrations stay pending until their merge is confirmed.
- **One inbox.** Questions and permissions can be answered from the browser or CLI; phone notification transports are configurable.
- **Optional assistance.** Code maps, collision warnings, local-model helpers and independent reviews support the workflow. Their usefulness is measured on your tasks, not assumed.

The daemon binds to `127.0.0.1`; use Tailscale or an SSH tunnel for remote access. Lanes use bubblewrap filesystem restrictions. They share the host network; see [the trust boundaries](docs/ARCHITECTURE.md#trust-boundaries) before using untrusted projects or tools.

## Requirements

Linux with a systemd user session, Node 22.13 or newer (24 recommended), git, tmux, bubblewrap and Python 3. Tailscale is optional. GitHub pull requests require a signed-in `gh` CLI.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/wongywrongy/ContextLane/main/install.sh | sh
contextlanes setup
```

`setup` prints a one-time sign-in link and QR code. Open it, connect an agent, and add a project. To keep user services running after logout, enable linger on the host with `sudo loginctl enable-linger "$USER"`.

## Work

```sh
contextlanes lane start <project> "Add GET /health; return 200 and cover it with a request test"
contextlanes inbox
contextlanes term <project>/01
contextlanes help
```

Define the task's expected behavior and required checks. Use the lane's terminal or browser composer to steer it. Review the evidence, request changes when needed, then open the PR. GitHub remains responsible for repository CI and merge policy.

For a native CLI session from a repository, use `contextlanes claude` or `contextlanes codex`. Detach with Ctrl+B, then D; `contextlanes term` reattaches. Codex hook trust and provider-specific limits are documented in [current status](docs/IMPLEMENTATION.md).

## Update

```sh
contextlanes update
contextlanes update --check
contextlanes update --rollback
```

Updates build beside the running release, back up the database and check daemon health before completing. Settings are in `~/.config/contextlanes/config.toml`; data is in `~/.local/share/contextlanes`. Logs: `journalctl --user -u contextlanes`.

## Documentation

- [Recipes](docs/RECIPES.md): app setup, services, previews and checks
- [Architecture](docs/ARCHITECTURE.md): processes, lifecycle and trust boundaries
- [Developing](docs/DEVELOPING.md): build and verification
- [Product brief](docs/BRIEF.md) and [current status](docs/IMPLEMENTATION.md)
- [Design](docs/DESIGN.md): interface rules
