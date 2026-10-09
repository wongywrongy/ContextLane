# Download and run on neo

This release contains compiled JavaScript/static UI, a prebuilt Linux amd64 Docker image, its Dockerfile, Compose configuration and owner setup. It runs one backend container and uses the existing host's user systemd and Tailscale. It does not move projects into Docker or launch another host daemon.

Use Linux with Docker Compose 2.15+, Node 24 for the one-time setup, a running user-systemd manager, and the existing Tailscale installation at `/usr/bin/tailscale`. The included image is tested on neo as UID 1000. Other hosts must review socket, journal and project mount paths before running it. Run these commands as the installation owner, not root:

```sh
mkdir -p ~/stacks/rootlane
cd ~/stacks/rootlane
gh release download v0.1.2 --repo wongywrongy/rootlane \
  --pattern 'rootlane-0.1.2-linux-amd64.tar.gz' --pattern SHA256SUMS
sha256sum -c SHA256SUMS
tar -xzf rootlane-0.1.2-linux-amd64.tar.gz --strip-components=1
docker load -i rootlane-image.tar
node deploy/setup.mjs "$HOME/code"
docker compose up -d --no-build --wait
docker compose exec -T rootlane node deploy/serve.mjs
```

The repository/release is private: `gh` must be authenticated with repository access. No GHCR credential or source compilation is needed to load the included image. An alternative build is `docker compose build` using the included compiled assets. The pinned Node base and separate SQLite build stage supply the native binding without requiring a compiler on neo.

Setup creates distinct random mode-0600 credentials and a private configuration under `~/.config/rootlane`, plus private state under `~/.local/state/rootlane`. It preserves existing files and refuses incompatible existing roots/state. `.env` contains paths/UIDs only. Keep configuration outside observed checkout roots. The initial configuration has no launch profiles: projects appear as observe-only. Existing owner-reviewed profiles remain owner configuration, not executable authority supplied by a download.

The final command checks the authenticated backend and adds HTTPS 19483 only if the exact route is absent. A conflicting existing mapping is preserved and reported. It is safe to repeat for the same matching mapping. No global Serve reset is used. Open the printed URL and unlock with the contents of `~/.config/rootlane/owner.credential`; keep this credential private.

For managed profiles, review host executable/working-directory paths in `deploy/config.example.json` before copying a profile into the private config. Native services execute on the host, outside the container. Their project paths and executable paths must also be readable inside Rootlane for prerequisite checks. For the previously approved neo fixture, add this read-only mount to Compose's `volumes` if using `/home/kyle/.local/bin/node`:

```yaml
- type: bind
  source: /home/kyle/.local/bin/node
  target: /home/kyle/.local/bin/node
  read_only: true
  bind: {create_host_path: false}
```

The project-root mount already includes its existing checkout and installed Vite. Downloading this release does not install dependencies in any observed project or authorize another launch profile. Restart only Rootlane after an owner configuration change: `docker compose up -d --no-build --force-recreate --wait`.

For local coding clients, use the absolute path to `deploy/rootlane-mcp-docker` as the stdio command and allow only the five Rootlane tools. This wrapper executes the thin adapter inside the already-running container, reading its private credential there. It never starts a container/backend; an unavailable deployment fails clearly. Keep the effective client approval policy separate from backend ownership checks.

Check `docker compose ps`, `docker compose logs --tail=100`, and the authenticated UI status. Container health establishes that HTTP serves requests; managed readiness is a separate systemd/listener/application check. `docker compose restart` preserves managed host services, which Rootlane reconciles. `docker compose down` removes the backend container, not its SQLite state or managed host services. Stop managed environments through Rootlane before decommissioning; inspect and remove only the matching dedicated Rootlane Serve route separately.

This is a trusted single-owner host controller. The owner explicitly approved `apparmor:unconfined` for Rootlane only because Docker's default AppArmor policy prevents attributing host listeners to owned control groups. Host network/PID/cgroup namespaces and user-systemd/Tailscale sockets expose host integration. The container runs as your UID with all capabilities dropped, no privileged mode, no Docker socket and read-only project mounts. It is not a sandbox against code running as that owner. Managed host units are outside the container's resource limits.

Upgrades: back up SQLite through its backup API; stop Rootlane before restoring; preserve `~/.config/rootlane` and `~/.local/state/rootlane`. Load the new versioned image and use that release's Compose file. Do not run native-systemd and Compose backend installations simultaneously against the same state/port.

Owner-reviewed secondary operator addresses can be added with `additionalOrigins`, for example `["https://root.avlis.dev"]`. They must be canonical HTTPS origins. Rootlane validates both the allowed Host and its matching supplied Origin; original Tailscale access remains available. Configure the corresponding route in the existing proxy manager separately, without exposing the loopback backend directly.

Login accepts at most ten attempts in any sliding minute across all operator origins and clients. The bounded attempt timestamps persist in SQLite across Rootlane restarts; no submitted credential is recorded. `429` responses provide `Retry-After`. Malformed/oversized bodies consume the same budget before parsing. A sustained attempt flood can temporarily deny new logins; already authenticated sessions remain usable. Owner credentials are generated with 256 bits of randomness and must remain private. This does not protect against credential theft, an owner-user compromise or network-level denial of service.
