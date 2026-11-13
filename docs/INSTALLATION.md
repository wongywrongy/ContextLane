# Installation and recovery

## Decision

Docker is where ContextLanes is going: a control service and one container per lane ([V4.md](V4.md); decided 2026-11-10, confirmed 2026-11-12). The native install below (systemd, tmux, bubblewrap) is the host runtime, kept working until V4 phase 5 removes it. Use it for the review workflow ([WORKFLOW.md](WORKFLOW.md)), which does not run in the Docker runtime yet.

| Installation | Role |
|---|---|
| Docker stack (`compose.yaml`, [README](../README.md)) | The direction. Lanes, terminals and agents work; apps and links are written and not yet run on a real host; review is not built |
| Managed native service (this page) | Host runtime until V4 phase 5; supported update and rollback |
| Source checkout | Development; install/build/restart explicitly |

The two do not share lane sessions or a database. Never point both at one live database, and do not prune Docker volumes as housekeeping.

## Install once

Run as the account that owns the projects, in a normal systemd user session. Prerequisites: Linux, Node >=22.13 (24 recommended), npm, Git, tmux, bubblewrap and Python 3. GitHub PRs need authenticated `gh`. Provider CLIs are installed and signed in separately; ContextLanes does not change their update policy.

```sh
curl -fsSL https://raw.githubusercontent.com/wongywrongy/ContextLane/main/install.sh -o /tmp/contextlanes-install.sh
sh /tmp/contextlanes-install.sh
```

The installer uses pinned pnpm and the frozen lockfile, installs the service and nightly database-backup timer, waits for the CLI health check, then runs `setup` once. `setup` prints a single-use sign-in link. Add `~/.local/bin` to PATH if the installer reports it missing.

To keep the user manager available after logout and start it at boot:

```sh
sudo loginctl enable-linger "$(id -un)"
systemctl --user is-enabled contextlanes.service contextlanes-backup.timer
systemctl --user is-active contextlanes.service contextlanes-backup.timer
loginctl show-user "$(id -un)" -p Linger --value
```

Linger and enabled units establish daemon startup configuration. They do not make an in-memory tmux agent conversation resumable after a host reboot. Browser disconnect, daemon restart, logout and reboot are separate acceptance cases.

## Where things live

| Item | Default path |
|---|---|
| Source clone | `~/.local/share/contextlanes/app` |
| Built updates | `~/.local/share/contextlanes/releases/<commit>` |
| Selected and previous release | `~/.local/share/contextlanes/current`, `previous` |
| Update channel and history | `~/.local/share/contextlanes/update.json` |
| Configuration | `~/.config/contextlanes/config.toml` |
| Persistent state | `~/.local/share/contextlanes` (outside release directories) |
| Commands | `~/.local/bin/contextlanes`, `contextlanes-lanehost`, `contextlanes-toolbox` |
| User units | `~/.config/systemd/user/contextlanes*.service`, `contextlanes-backup.timer` |

`CONTEXTLANES_INSTALL_DIR` may select a different absolute `…/app` path. Persistent data remains governed by the configuration; moving the code does not migrate data. Systemd drop-ins are preserved when managed unit files are refreshed. A conflicting command or unit without the installer ownership marker is refused before managed files are changed.

## Rerun and update

An interrupted first build can be retried with the same installer. It resumes only its marked checkout and refuses tracked local edits. An existing installation delegates to its own updater, preserving its saved branch unless `CONTEXTLANES_BRANCH` is explicitly set. For routine use:

```sh
contextlanes update --check
contextlanes update
contextlanes status
journalctl --user -u contextlanes -n 50
```

The updater builds beside the running release, records the build commit, backs up SQLite and switches `current` atomically. Release cleanup keeps the newest three builds plus releases required by retained update history or running processes. A reused or explicitly adopted build must match its commit metadata and have no tracked source edits. Release metadata is a provenance check, not a signed attestation of generated artifacts.

A failed build leaves the current release alone. Failed startup returns to the old release only when the database schema is known to match the preupdate snapshot. A schema change or uncertain compatibility stops the daemon and preserves the candidate, newer database and recovery history for an owner decision. A failed candidate does not become the saved update channel. Rollback restores the prior channel and rollback chain recorded by the new updater, so a rejected candidate is not offered as the next rollback target. Older history entries do not contain a prior-channel field; inspect and restore that channel explicitly when recovering a legacy update. Missing transition history blocks a database rollback rather than guessing compatibility.

```sh
contextlanes update --rollback
```

If rollback requires restoring an older database, the command refuses without `--yes`. First preserve the current database and assess newer work; use that flag only after the owner explicitly chooses the restore. Never put it in an unattended verification or recovery script. Schema equality is necessary for automatic recovery, but does not prove semantic compatibility between arbitrary releases; acceptance must exercise actual lane states.

The nightly timer runs at 03:10 in the host's timezone and catches up after downtime. It backs up SQLite, not repository files or provider credentials. Keep a separate verified backup of configuration, credentials, repositories and any retained Docker volumes. Existing monitoring should check authenticated availability, the expected commit, session presence, restarts and backup results. A healthy process is only one acceptance signal.

## Research basis

Reviewed 2026-11-12:

- [systemd loginctl](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html): linger starts the user manager at boot and retains it after logout.
- [Anthropic installation guidance](https://code.claude.com/docs/en/setup): native Claude Code installation and provider-owned updates.
- [Anthropic agent practices](https://code.claude.com/docs/en/best-practices): focused task context, executable checks and enforced boundaries; no mandatory planning or context-management ceremony.
- [Docker volume lifecycle](https://docs.docker.com/engine/storage/volumes/): persistent volumes have their own lifecycle and must be preserved deliberately during retirement.
