# ContextLanes

Give every coding task its own lane: a branch and checkout, a terminal that keeps running, a copy of your app on its own ports, and a link to open it from any device. Run Claude Code or Codex in a lane, or your own agent in your own checkout; either way it drives the lane with the `contextlanes` command. ContextLanes is one more service on a machine that stays on, behind the reverse proxy you already run.

![A lane in ContextLanes: the agent's steps, the message box and the lane's branch and folder](docs/screenshot.webp)

- **Lanes.** Own branch, checkout, tmux terminal and running app per task; several at once, and they keep going when you close your laptop.
- **Links that work.** Every service gets `https://<service>-<n>-<project>.<your domain>`, known before it starts and passed to it as `$LANE_URL`. One wildcard entry in your proxy covers every lane.
- **Made for agents.** `contextlanes env start`, `url`, `logs`, all with `--json` and exit codes an agent can act on. Agents are told about them when a lane starts.
- **You decide.** Questions and permission requests from every lane in one inbox, answerable from your phone. New or changed recipes run only after you approve them. Agents never approve themselves.
- **Self-hosted and confined.** The API listens on 127.0.0.1 only. Agents and lane services run in a bubblewrap sandbox that cannot see ContextLanes' own data.

## Run it

**On one machine, no setup.** Links are `http://web-01-shop.localhost:4601` and open in a browser on that machine.

**Behind your reverse proxy.** Add `*.root.example.dev` → port 4601 to Nginx Proxy Manager, Caddy or Traefik, set `[previews] domain = "root.example.dev"`, and open lanes from anywhere at `https://lanes.root.example.dev`. See [docs/PROXY.md](docs/PROXY.md).

**On a tailnet without a domain.** `[previews] mode = "serve"` uses Tailscale Serve, one HTTPS port per service.

## Install

Linux or macOS with Node 22.13 or newer (24 recommended), git, tmux and python3. On Linux, bubblewrap confines agents (`sudo apt install bubblewrap`).

```sh
curl -fsSL https://raw.githubusercontent.com/wongywrongy/ContextLane/main/install.sh | sh
contextlanes setup
```

With a systemd user session the installer runs ContextLanes as a user service; elsewhere it installs the commands, and you run `contextlanes daemon` under whatever keeps processes running. `setup` prints a one-time sign-in link. Then `contextlanes doctor` checks everything, including the path through your proxy.

On macOS, where bubblewrap does not exist, agents start only after you choose to run them unconfined: `[sandbox] mode = "off"` in `~/.config/contextlanes/config.toml`.

## Use

```sh
cd ~/code/shop
contextlanes claude                                   # Claude Code in a new lane (or: contextlanes codex)
contextlanes lane start shop "Add a health check"     # a lane from anywhere
contextlanes lane start . "Try the app" --here --no-agent   # this checkout, no agent: your own tools, managed services

contextlanes env start        # inside a lane: start the app from .contextlanes.json and wait until it is healthy
contextlanes url web          # its link
contextlanes logs web -n 50
contextlanes inbox            # what waits on you
contextlanes agent-notes      # what to put in AGENTS.md so any agent uses this
```

Add `--json` to any command. Exit codes: 0 done, 1 failed, 2 wrong usage, 3 ContextLanes not reachable, 4 waiting on you (a recipe to approve).

What a lane runs comes from `.contextlanes.json` in your repository: see [docs/RECIPES.md](docs/RECIPES.md).

## For agents

Paste this into a project's `AGENTS.md` or `CLAUDE.md` (it is also what `contextlanes agent-notes` prints), so agents you run yourself use lanes too:

```md
## ContextLanes

This checkout is a ContextLanes lane: its own branch, its own copy of the app on its own ports, and a link for each service. Use the `contextlanes` command; inside a lane it already knows which lane you are in. Add --json to any command for machine-readable output.

- `contextlanes env` — services, their state, port and link
- `contextlanes env start` — start the app from the recipe (.contextlanes.json) and wait until it is healthy or failed; on failure it prints the logs
- `contextlanes env restart [service]`, `contextlanes env stop`
- `contextlanes logs <service> [-n 100]` — recent log lines
- `contextlanes url [service]` — the service's link, and nothing else (default service: web)
- `contextlanes recipe` — the recipe, its hash and whether it is approved

Services get `$PORT` and must listen on 127.0.0.1 (`$HOST`). They also get `$LANE_URL` and `$LANE_HOSTNAME` (their own link), and `$LANE_URL_<NAME>` for every service, usable in the recipe's commands and env values.

Exit codes: 0 done, 1 failed, 2 wrong usage, 3 ContextLanes not reachable, 4 waiting on the owner. Exit 4 means the recipe is new or changed and only the owner can approve it: say so, and continue with work that does not need the app. Never try to approve it yourself.
```

## More, when you want it

Review with checks and screenshots, the code map and Architecture page, Insights, local-model helpers, sub-lanes, hand-off, schedules and ACP agents (OpenCode and others) are built but off. Turn one on in `~/.config/contextlanes/config.toml`, for example `[features] review = true`, and restart. The list is in [docs/V3.md](docs/V3.md).

## Update

```sh
contextlanes update             # newest version; lanes keep running
contextlanes update --check     # list what is new
contextlanes update --rollback  # back one version
```

## Docs

- [Proxy](docs/PROXY.md): one wildcard entry in Nginx Proxy Manager, Caddy or Traefik
- [Recipes](docs/RECIPES.md): run your app in each lane with `.contextlanes.json`
- [v3](docs/V3.md): what ContextLanes is now, and why
- [Architecture](docs/ARCHITECTURE.md): processes, data and security
- [Developing](docs/DEVELOPING.md): build, test and run from source
- [Design](docs/DESIGN.md), [Brief](docs/BRIEF.md) and [implementation log](docs/IMPLEMENTATION.md)
