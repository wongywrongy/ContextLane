# ContextLanes as a Docker stack

The preferred install. One container holds the daemon, tmux, the `cl` command and the agents' CLIs. Everything it keeps is in one folder next to `compose.yaml`, and removing the stack removes ContextLanes.

## Start

```sh
git clone https://github.com/wongywrongy/ContextLane.git /opt/stacks/contextlanes
cd /opt/stacks/contextlanes
cp .env.example .env        # set PUID, PGID and the two folders
docker compose up -d --build
sudo ln -s "$PWD/docker/cl" /usr/local/bin/cl
cl setup                    # prints the sign-in link
```

Then, in any repository under your code folder, run `cl`.

Stack managers that read `/opt/stacks/<name>/compose.yaml` (Dockge and the like) pick it up as it is.

## What goes in `.env`

| Setting | What it is |
|---|---|
| `PUID`, `PGID` | Your user's ids on the host (`id -u`, `id -g`). ContextLanes runs as that user inside the container, so files it writes in your folders stay yours. |
| `CONTEXTLANES_CODE` | The folder that holds your repositories. |
| `CONTEXTLANES_LANES` | A folder for lane checkouts. |
| `CONTEXTLANES_DOMAIN` | Optional. With it, every lane's app is at `https://<service>-<n>-<project>.<domain>` and the web app at `https://lanes.<domain>`. |
| `CONTEXTLANES_PUBLISH` | Where the one port is published. Default `127.0.0.1:4601`. |
| `CONTEXTLANES_SANDBOX` | `bwrap` (default) or `off`. |

The two folders are mounted **at the same path inside the container as outside**. Git worktrees store absolute paths, so this is what keeps a lane's checkout usable from both sides, and every path ContextLanes prints is a real path on the host.

`.env` is read on the first start, which writes `data/config.toml`. After that, change settings in that file and `docker compose restart`.

## Where things live

| Path | What |
|---|---|
| `./data/config.toml` | Settings |
| `./data/state/` | Database and ContextLanes' own files |
| `./data/home/` | The container user's home: agent logins (`.claude`, `.codex`), git and ssh settings |
| `./data/mise/` | Toolchains installed by mise |

Back up `./data`. Delete it to start over.

## The `cl` command

`docker/cl` runs `cl` inside the container from the folder you are in. With a terminal you get the menus and can attach to a lane's terminal; in a script or a pipe it stays plain and takes `--json`. The container is found by name (`contextlanes`); set `CONTEXTLANES_CONTAINER` if you renamed it.

## Agents

Claude Code and Codex are in the image at the versions this release was tested with. Sign each in once:

```sh
cl new "sign in" --no-agent     # any lane's shell will do
cl sh 1
claude                          # then /login;  or: codex login
```

The login is kept in `./data/home` and survives rebuilds.

To push from a lane, the container user needs your git identity and credentials. Either sign in with `gh auth login` in a lane shell, or mount what you already have by adding to `volumes:` in `compose.yaml`:

```yaml
      - ${HOME}/.gitconfig:/data/home/.gitconfig:ro
      - ${HOME}/.ssh:/data/home/.ssh:ro
```

## Toolchains

Agents and lane services run inside the container, so they use the tools in the image, not the host's. Two standard ways to give a project what it needs:

1. **Per project, no rebuild: mise.** The image ships [mise](https://mise.jdx.dev), which reads the files projects already have: `.tool-versions`, `.nvmrc`, `.python-version`, `mise.toml`. Run `mise install` in a lane, or make it a setup step in the project's `.contextlanes.json`, and the lane gets the versions the repository asks for. They are kept in `./data/mise`.
2. **For everything: extend the image.** Put a `Dockerfile` beside `compose.yaml`:

   ```dockerfile
   FROM contextlanes:local
   RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
   ```

   and point `build:` at it.

A project that runs Docker itself (its own compose file, databases in containers) needs the host's Docker socket mounted into this container. That gives agents control of Docker on the host; do it only if you accept that.

## Links from other devices

Set `CONTEXTLANES_DOMAIN` (before the first start, or `[previews] domain` in `data/config.toml` later), add a wildcard DNS record `*.<domain>`, and one wildcard entry in your reverse proxy pointing at the published port with WebSockets on. [PROXY.md](PROXY.md) has the details for Nginx Proxy Manager, Caddy, Traefik and nginx.

If the proxy is itself a container, put both on one network instead of publishing the port wider. Add to `compose.yaml`:

```yaml
services:
  contextlanes:
    networks: [default, proxy]
networks:
  proxy:
    external: true
    name: <your proxy's network>
```

and forward the wildcard entry to `contextlanes:4601`.

Run `cl doctor` after. It sends a request through DNS, your certificate and the proxy, and names the step that fails.

## The sandbox

Inside the container, agents and lane services still run in bubblewrap, which hides ContextLanes' own data (its database and sign-in token) from them. Bubblewrap makes namespaces, which Docker's default seccomp and AppArmor profiles refuse, so `compose.yaml` turns those two profiles off for this container. `cl doctor` says whether the sandbox works on your machine.

Where it cannot work, `CONTEXTLANES_SANDBOX=off` (or `[sandbox] mode = "off"`) lets agents start without it. The container is then the only boundary: agents can read ContextLanes' own token, and so could approve their own requests.

## Update

```sh
cd /opt/stacks/contextlanes
git pull
docker compose up -d --build
```

Recreating the container ends the tmux sessions in it, so running agents stop. Their lanes, checkouts and branches are kept, and an agent lane is started again with `cl lane restart <lane>`. (The host install keeps lanes running through an update; this one does not.)

## Compared with the host install

| | Docker stack | Host install (`install.sh`) |
|---|---|---|
| Install and removal | `docker compose up` / delete the folder | A user service, files under `~/.local` and `~/.config` |
| Agents see | Only the folders you mounted | Everything your user can |
| Toolchains | The image, mise, or your own `FROM` | Whatever the machine already has |
| Lanes during an update | Stop; restart them after | Keep running |
| Needs | Docker | Node, git, tmux, python3; bubblewrap on Linux |
