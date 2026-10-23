# Installation

This release contains compiled JavaScript/static UI, a prebuilt Linux amd64 Docker image, its Dockerfile, Compose configuration and owner setup. It runs one backend container and uses the existing host's user systemd and Tailscale. It does not move projects into Docker or launch another host daemon.

Use Linux with Docker Compose 2.15+, Node 24 for the one-time setup, a running user-systemd manager, and the existing Tailscale installation at `/usr/bin/tailscale`. The included image is tested on one Linux amd64 host. Other hosts must review socket, journal and project mount paths before running it. Run these commands as the installation owner, not root:

For the checked-out 0.8.0 source:

```sh
npm ci
npm run check
node deploy/setup.mjs "$HOME/code"
docker compose up -d --build --wait
deploy/preflight-docker
docker compose exec -T rootlane node deploy/serve.mjs
```

When using a packaged release, its archive includes `rootlane-image.tar.gz`. Load it with `docker load -i rootlane-image.tar.gz`, run owner setup, then use `docker compose up -d --no-build --wait` instead of building the source.

Setup creates distinct random mode-0600 owner, agent and ingest credentials and a private configuration under `~/.config/rootlane`, plus private state under `~/.local/state/rootlane`. It preserves existing credentials and refuses incompatible existing roots/state. `.env` contains paths/UIDs and the detected Codex version only. Keep configuration outside observed checkout roots. The initial configuration has no launch profiles and agent telemetry is off: projects appear as observe-only. Existing owner-reviewed profiles remain owner configuration, not executable authority supplied by a download.

The final command checks the authenticated backend and adds HTTPS 19483 only if the exact route is absent. A conflicting existing mapping is preserved and reported. It is safe to repeat for the same matching mapping. No global Serve reset is used. Open the printed URL and unlock with the contents of `~/.config/rootlane/owner.credential`; keep this credential private.

For managed profiles, review the [configuration example](config.example.json) and [administration guide](../docs/ADMINISTRATION.md). Native services execute on the host. Setup generates read-only binds for every observation root and reviewed executable directory in compose.override.yaml, refusing sensitive system roots; rerun setup and recreate the container when these paths change. Replace sample paths and explicitly approve profiles only after review.

The project-root mount already includes its existing checkout and installed Vite. Downloading this release does not install dependencies in any observed project or authorize another launch profile. Reload owner configuration with `deploy/rootlane-reload` (SIGHUP), or allow the ten-second mtime check. Invalid config keeps the running config. Changes to state, backend port, tailnet hostname or operator origins require restart. New mount paths require rerunning setup and recreating only Rootlane.

For local coding clients, use the absolute path to `deploy/rootlane-mcp-docker` as the stdio command and allow all nineteen current Rootlane tools. With host Node 24, the bundled adapter runs independently of the controller, reads the private agent credential on the host, and keeps its stdio connection through controller recreation. Calls during an outage return a backend error; later calls recover on the same connection. Install the rebuilt bundle and wrappers together. Older installations without the bundle or host Node use the already-running container and require reconnecting after recreation. The wrapper never starts a container/backend. Keep the effective client approval policy separate from backend ownership checks.

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

0.7.1 corrects process ownership, failed-refresh state, mobile exposure counts and route-check sampling. The first catalog scan after a controller restart establishes an observation baseline. Removed checkouts emit disappearance observations, and their project associations remain available while their events are retained. Historical associations use the existing metadata store; the SQLite schema stays at migration 004. Existing 0.7.0 observations are preserved, including any earlier duplicate entries.

0.8.0 adds opt-in, agent-reported session telemetry: counts and names only, never content. A separate loopback-only JSON OTLP/hook receiver uses a new ingest-only credential; Settings provides guarded setup copies for Claude Code and Codex. Claude hooks establish process matches, while Codex matches remain probable. Context/usage limits require the optional Claude status-line wrapper. Rootlane MCP call counts remain available even while telemetry is off. The Agents tab adds list/detail views, and all panel tabs share flat divided sections with responsive detail rows. Two new read tools, get_agent_sessions and get_telemetry_status, bring the total to seventeen. Migration 005 adds bounded session aggregates, latest context and per-PID Rootlane tool counts, with hourly retention and backup coverage. Set telemetry.enabled=false and run rootlane-reload to close the receiver and purge retained rows. Back up before upgrading: rollback needs the matching pre-migration-005 backup. See [telemetry setup and privacy](../docs/TELEMETRY.md).

## 0.9.0 environment workflow upgrade (schema 006)

Preparation cleanup failures block configuration, approval and Start until the owner verifies recorded-unit cleanup. Installation retains the reviewed fingerprint: changed or newly created lockfiles require a second preparation review. Integration inspection checks registration arguments and effective Codex allow/deny lists; reviewed repairs change only Rootlane settings and preserve approval policies.

The container uses Node 24.22.1, Fastify 5.12.7 and Vite 7.3.7. For host jobs and stdio, place the checksum-verified official Node 24.22.1 Linux distribution under `runtime/node` in the installation before running setup. Setup records `ROOTLANE_HOST_NODE` and mounts that directory read-only. Existing application toolchain overrides and profile executables are preserved. The adapter prefers that installation runtime. The official image index digests are pinned in Dockerfile; application dependencies remain the application's responsibility.

Native client acceptance can be repeated with `ROOTLANE_CLIENT_ACCEPTANCE=1 ROOTLANE_CLIENT_AUTHENTICATED=1 ROOTLANE_CLIENT_TELEMETRY=1 npm run client:acceptance`. This uses an isolated backend, private temporary client settings, a temporary copy of Claude's existing sign-in and only fixture catalog data. It verifies an actual read-only result and fresh exporter events; it does not send the production catalog to a model or modify global client settings.

This change adds private host-local recipes, owner-approved preparation, retirement and recovery state. Project mounts remain read-only. Run setup again to record `ROOTLANE_MCP_ADAPTER` and the host paths required by the integration jobs. Existing recipes keep their restart policy; only generated recipes select crash recovery. Reboot restoration stays off until selected per checkout. Old builds cannot open schema 006.

For the detected Docker installation at `/opt/stacks/rootlane`, finish active preparation/lifecycle operations before upgrading. The following preserves the previous image, installation files, private configuration, state files and a SQLite backup made through the old image. It stops only the controller; existing managed host applications remain running.

```sh
cd /opt/stacks/rootlane
umask 077
rootlane_backup="$HOME/rootlane-backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$rootlane_backup"
rootlane_container=$(docker compose ps -q rootlane)
rootlane_image=$(docker inspect "$rootlane_container" --format '{{.Image}}')
rootlane_image_tag=$(docker inspect "$rootlane_container" --format '{{.Config.Image}}')
rootlane_config_dir=$(docker inspect "$rootlane_container" --format '{{range .Mounts}}{{if eq .Destination "/config"}}{{.Source}}{{end}}{{end}}')
rootlane_state=$(docker compose exec -T rootlane node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.ROOTLANE_CONFIG,"utf8")).stateDirectory)')
rootlane_rollback_tag="rootlane:rollback-$(basename "$rootlane_backup" | tr '[:upper:]' '[:lower:]')"
node --input-type=module - "$rootlane_backup" "$rootlane_image_tag" "$rootlane_rollback_tag" "$rootlane_config_dir" "$rootlane_state" "$rootlane_image" <<'JS'
import { writeFileSync } from 'node:fs';
const [backup, previousTag, rollbackTag, configDirectory, stateDirectory, previousImage] = process.argv.slice(2);
writeFileSync(backup + '/metadata.json', JSON.stringify({backup, installation:process.cwd(), previousTag, rollbackTag, configDirectory, stateDirectory, previousImage}, null, 2), {mode:0o600,flag:'wx'});
JS
docker image tag "$rootlane_image" "$rootlane_rollback_tag"
docker image save "$rootlane_rollback_tag" | gzip > "$rootlane_backup/image.tar.gz"
docker compose stop rootlane
docker compose run --rm --no-deps --entrypoint node rootlane dist/state/backup.js \
  "$rootlane_state/rootlane.sqlite" "$rootlane_state/pre-environment-upgrade.sqlite"
cp "$rootlane_state/pre-environment-upgrade.sqlite" "$rootlane_backup/rootlane.sqlite"
tar -C /opt/stacks/rootlane -czf "$rootlane_backup/installation.tar.gz" .
tar -C "$rootlane_config_dir" -czf "$rootlane_backup/config.tar.gz" .
tar -C "$rootlane_state" -czf "$rootlane_backup/state.tar.gz" .
printf 'Backup: %s\n' "$rootlane_backup"
```

Use a fresh backup destination and ensure `pre-environment-upgrade.sqlite` does not already exist. These are controller backups; application databases or external application files need their own reviewed backup procedure.

With the reviewed new release archive available at `/tmp/rootlane-release.tar.gz`:

```sh
cd /opt/stacks/rootlane
tar -xzf /tmp/rootlane-release.tar.gz -C /opt/stacks/rootlane
node deploy/setup.mjs "$HOME/code"
docker load -i rootlane-image.tar.gz
docker compose up -d --no-deps --no-build --force-recreate --wait rootlane
deploy/preflight-docker
docker compose ps rootlane
docker compose logs --tail=100 rootlane
```

For a source installation, replace `docker load` with `npm ci`, `npm run check` and `docker compose build rootlane`; keep the same `up --no-deps ... rootlane` command. Do not recreate unrelated stacks, reset Serve or change global coding-client settings. Check owner login, catalog rescan evidence, existing environment state, verified links and the client adapter. A healthy container alone does not verify applications or previews. Client repairs require a separate owner review in Settings.

Rollback requires the matching old image and state. First stop any environments created or changed after the upgrade through Rootlane, verifying cleanup; an old ownership snapshot cannot safely identify later resources. Set `rootlane_backup` to the saved directory above:

```sh
cd /opt/stacks/rootlane
rootlane_config_dir=$(node -p 'require(process.argv[1]).configDirectory' "$rootlane_backup/metadata.json")
rootlane_state=$(node -p 'require(process.argv[1]).stateDirectory' "$rootlane_backup/metadata.json")
rootlane_image_tag=$(node -p 'require(process.argv[1]).previousTag' "$rootlane_backup/metadata.json")
rootlane_rollback_tag=$(node -p 'require(process.argv[1]).rollbackTag' "$rootlane_backup/metadata.json")
docker compose stop rootlane
tar -xzf "$rootlane_backup/installation.tar.gz" -C /opt/stacks/rootlane
tar -xzf "$rootlane_backup/config.tar.gz" -C "$rootlane_config_dir"
tar -xzf "$rootlane_backup/state.tar.gz" -C "$rootlane_state"
rm -f "$rootlane_state/rootlane.sqlite-wal" "$rootlane_state/rootlane.sqlite-shm"
cp "$rootlane_backup/rootlane.sqlite" "$rootlane_state/rootlane.sqlite"
chmod 600 "$rootlane_state/rootlane.sqlite"
docker load -i "$rootlane_backup/image.tar.gz"
docker image tag "$rootlane_rollback_tag" "$rootlane_image_tag"
docker compose up -d --no-deps --no-build --force-recreate --wait rootlane
deploy/preflight-docker
docker compose ps rootlane
docker compose logs --tail=100 rootlane
```

Restoring the database also restores approval/reservation/ownership history to its backup time. Keep the full backup until the new workflow has passed owner acceptance. The backup format is `metadata.json`, including `previousTag`, `rollbackTag`, `configDirectory` and `stateDirectory`; older production backups already use this format. Rehearse with `node tests/backup-acceptance.mjs /absolute/backup` before release. That command restores only beneath a private temporary directory and never starts a controller or touches live resources.
