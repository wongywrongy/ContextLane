# Installation

This release contains compiled JavaScript/static UI, a prebuilt Linux amd64 Docker image, its Dockerfile, Compose configuration and owner setup. It runs one backend container and uses the existing host's user systemd and Tailscale. It does not move projects into Docker or launch another host daemon.

Use Linux with Docker Compose 2.15+, Node 24 for the one-time setup, a running user-systemd manager, and the existing Tailscale installation at `/usr/bin/tailscale`. The included image is tested on one Linux amd64 host. Other hosts must review socket, journal and project mount paths before running it. Run these commands as the installation owner, not root:

For the checked-out 0.7.0 source:

```sh
npm ci
npm run check
node deploy/setup.mjs "$HOME/code"
docker compose up -d --build --wait
deploy/preflight-docker
docker compose exec -T rootlane node deploy/serve.mjs
```

When using a packaged release, its archive includes `rootlane-image.tar.gz`. Load it with `docker load -i rootlane-image.tar.gz`, run owner setup, then use `docker compose up -d --no-build --wait` instead of building the source.

Setup creates distinct random mode-0600 credentials and a private configuration under `~/.config/rootlane`, plus private state under `~/.local/state/rootlane`. It preserves existing files and refuses incompatible existing roots/state. `.env` contains paths/UIDs only. Keep configuration outside observed checkout roots. The initial configuration has no launch profiles: projects appear as observe-only. Existing owner-reviewed profiles remain owner configuration, not executable authority supplied by a download.

The final command checks the authenticated backend and adds HTTPS 19483 only if the exact route is absent. A conflicting existing mapping is preserved and reported. It is safe to repeat for the same matching mapping. No global Serve reset is used. Open the printed URL and unlock with the contents of `~/.config/rootlane/owner.credential`; keep this credential private.

For managed profiles, review the [configuration example](config.example.json) and [administration guide](../docs/ADMINISTRATION.md). Native services execute on the host. Setup generates read-only binds for every observation root and reviewed executable directory in compose.override.yaml, refusing sensitive system roots; rerun setup and recreate the container when these paths change. Replace sample paths and explicitly approve profiles only after review.

The project-root mount already includes its existing checkout and installed Vite. Downloading this release does not install dependencies in any observed project or authorize another launch profile. Reload owner configuration with `deploy/rootlane-reload` (SIGHUP), or allow the ten-second mtime check. Invalid config keeps the running config. Changes to state, backend port, tailnet hostname or operator origins require restart. New mount paths require rerunning setup and recreating only Rootlane.

For local coding clients, use the absolute path to `deploy/rootlane-mcp-docker` as the stdio command and allow only the fifteen Rootlane tools. This wrapper executes the thin adapter inside the already-running container, reading its private credential there. It never starts a container/backend; an unavailable deployment fails clearly. Keep the effective client approval policy separate from backend ownership checks.

Check `docker compose ps`, `docker compose logs --tail=100`, and the authenticated UI status. Container health establishes that HTTP serves requests; managed readiness is a separate systemd/listener/application check. `docker compose restart` preserves managed host services, which Rootlane reconciles. `docker compose down` removes the backend container, not its SQLite state or managed host services. Stop managed environments through Rootlane before decommissioning; inspect and remove only the matching dedicated Rootlane Serve route separately.

This is a trusted single-owner host controller. The included Compose file uses `apparmor:unconfined` for Rootlane because Docker's default AppArmor policy can prevent attributing host listeners to owned control groups. Review this setting for your host before installation. Host network/PID/cgroup namespaces and user-systemd/Tailscale sockets expose host integration. The container runs as your UID with all capabilities dropped, no privileged mode, no Docker socket and read-only project mounts. It is not a sandbox against code running as that owner. Managed host units are outside the container's resource limits.

## Upgrades

Back up SQLite through its backup API; stop Rootlane before restoring; preserve `~/.config/rootlane` and `~/.local/state/rootlane`. Load the new versioned image and use that release's Compose file. Do not run native-systemd and Compose backend installations simultaneously against the same state/port.

Owner-reviewed secondary operator addresses can be added with `additionalOrigins`, for example `["https://rootlane.example.com"]`. They must be canonical HTTPS origins. Rootlane validates both the allowed Host and its matching supplied Origin; original Tailscale access remains available. Configure the corresponding route in the existing proxy manager separately, without exposing the loopback backend directly.

Login adds persisted exponential failure backoff (1 second, doubling to 60 seconds) and exempts reauthentication from valid sessions. It accepts at most ten anonymous attempts in any sliding minute across all operator origins and clients. The bounded attempt timestamps persist in SQLite across Rootlane restarts; no submitted credential is recorded. `429` responses provide `Retry-After`. Malformed/oversized bodies consume the same budget before parsing. A sustained attempt flood can temporarily deny new logins; already authenticated sessions remain usable. Setup generates owner credentials with 256 bits of randomness. An owner may intentionally replace theirs with a nonempty credential up to 256 characters; agent credentials must remain distinct and at least 32 characters. Short or predictable credentials have less resistance to guessing. Keep credentials private. This does not protect against credential theft, an owner-user compromise or network-level denial of service.

0.4.0 adds SQLite migration 003 for recipe approvals and per-checkout instances. Back up state before upgrade. An older image cannot open this migrated database; rollback requires restoring the matching pre-upgrade SQLite backup. Setup preserves owner files and adds read-only toolchain, venv and owner-home mounts for recipe execution and private envFile access. See [recipes](../docs/RECIPES.md).

0.5.0 shows all project links with independent states and a responsive Links table. It retains Tailscale Serve URLs. Private env files are passed to systemd as `EnvironmentFile=` rather than secret-bearing argv; stop and start an existing environment to recreate its units with this protection. Existing units retain their previous environment properties until recreated. No database migration is added in 0.5.0.


0.5.1 completes the observation table, mobile rows and accessible project menus/details, and separates MCP observation, independent publication and managed startup guidance. Adapter timeout and invalid-response errors are distinguished from connection failures. The same thirteen tools, permissions and ownership checks remain; no database migration is added. See the [MCP workflows](../README.md#mcp-workflows).

0.6.0 uses the unified v3 table, inline details, remembered density and explicit verified/unverified pills. Agent-owned listeners are excluded from services; descendants remain attributed services. No database migration or dependency is added.

0.7.0 replaces inline expansion with a desktop detail panel and mobile full-screen detail, and adds bind/exposure evidence, retained checks and observed events. Migration 004 adds checks (30 per subject) and events (500 total). list_checks reads grouped histories without probes; list_events reads up to 50 scoped observations. The UI merges these events with list_operations. Back up SQLite before upgrading: older releases cannot open migration 004, so rollback requires the matching pre-upgrade database. No new runtime dependency or host process control is added.
