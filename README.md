# Rootlane

A private, self-hosted workspace for your projects, worktrees, development environments, coding agents and useful links.

- Discover projects and Git worktrees without recursively indexing internal folders.
- See observed services, detected Codex/Claude processes, registered agents and known preview links in one place.
- Start and stop owner-reviewed environments through the browser, Codex or Claude Code.

Existing projects are **observe-only**. Rootlane controls only resources it owns.

## Install

Requires Linux amd64, Docker Compose 2.15+, Node 24 for setup, a running user-systemd manager and connected Tailscale. Review the host mounts and permissions in the [installation guide](deploy/RELEASE.md) first.

Download the compiled release and prebuilt Docker image. This repository is private, so `gh` must be authenticated with access.

```sh
mkdir -p ~/stacks/rootlane
cd ~/stacks/rootlane
gh release download v0.1.9 --repo wongywrongy/rootlane \
  --pattern 'rootlane-0.1.9-linux-amd64.tar.gz' --pattern SHA256SUMS
sha256sum -c SHA256SUMS
tar -xzf rootlane-0.1.9-linux-amd64.tar.gz --strip-components=1
docker load -i rootlane-image.tar
node deploy/setup.mjs "$HOME/code"
docker compose up -d --no-build --wait
docker compose exec -T rootlane node deploy/serve.mjs
```

Replace `$HOME/code` with your project root. Setup derives your user, home directory and Tailscale hostname; it creates private configuration and separate owner/agent credentials. No launch profiles are enabled automatically.

Open the HTTPS URL printed by the final command. Unlock with your private `~/.config/rootlane/owner.credential` file. For an existing installation, follow the [upgrade instructions](deploy/RELEASE.md#upgrades).

## Connect Codex or Claude Code

Run on the same host as Rootlane, as the installation owner. These commands use the installation above:

```sh
codex mcp add rootlane -- "$HOME/stacks/rootlane/deploy/rootlane-mcp-docker"
```

```sh
claude mcp add --transport stdio --scope user rootlane -- "$HOME/stacks/rootlane/deploy/rootlane-mcp-docker"
```

For another directory, such as `/opt/stacks/rootlane`, substitute its absolute adapter path. Restart your coding session and ask:

> Use Rootlane's list_projects tool to list my projects. Do not start or stop anything.

The adapter reads its private agent credential inside the running container. Keep normal tool approvals; never put credential values in client configuration. **Settings → MCP setup** covers tool permissions, troubleshooting and an optional agent setup prompt. Rootlane currently supports local stdio, not a remote `/mcp` endpoint.

Agent detection uses same-user native process metadata and project working directories. “Detected process” does not establish a task or active session. Node wrappers and remote agents are not detected; unassigned processes appear in discovery notices.

## Development

For source development, use Node 24.11+ within the 24 LTS series:

```sh
npm ci
npm run check
```

The gate runs TypeScript checks, builds the UI/backend and tests lifecycle, discovery, authentication and MCP behavior. SQLite uses `better-sqlite3`; source builds may require Python, make and a C++ compiler.

## Documentation

- [Installation and upgrades](deploy/RELEASE.md)
- [Configuration, native installation, backups and ownership](docs/ADMINISTRATION.md)
- [Actual verification results and remaining acceptance checks](VERIFICATION.md)

Rootlane is a trusted, single-owner Linux host controller. The current release has been tested on one Linux amd64 host; other installations require their own acceptance checks.
