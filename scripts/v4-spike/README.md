# ContextLanes v4 spike (phase 1)

This throwaway script tests the parts of `docs/V4.md` that nobody has run yet, on a real Linux Docker host and a real repository. It checks four things. First, git and the Dev Container CLI can work on a project from helper containers that mount only that project, so the control service never mounts user code. Second, a lane container built by `devcontainer up` sees its git worktree at the same path as the host and writes files owned by the folder's owner. Third, a read-only tools volume (static tmux, Node, Claude Code, Codex) runs inside an image that has none of them installed. Fourth, a lane's port can be reached from the private network but not from the host's loopback. If check 5 fails, the go/no-go in V4 §7 points to the fallback.

It has **not** been run against a real Docker daemon. It passed `bash -n` and `shellcheck`, and a dry run against `fake-docker.sh` (see the end of this file).

## Run

```sh
./v4-spike.sh ~/code/SomeRepo            # 10-25 min the first time (image build, lane image pull)
./v4-spike.sh --cleanup ~/code/SomeRepo  # removes everything it made; add --keep-image to keep cl-spike-tools
```

Run it as the user who owns the repository and is in the `docker` group. It refuses to run as root unless you pass `--allow-root`. The terminal shows one block per check and a summary at the end. Everything else goes to `./v4-spike-<timestamp>.log`. Paste the summary and attach the log.

Running it a second time first removes what the last run left behind. It keeps the agent-login volume, so a sign-in from check 9 survives. `--cleanup` removes:

- containers labelled `contextlanes.spike=1`
- `cl-spike-net`
- both volumes
- the worktree `<repo>.lanes/spike` (`git worktree remove --force`, then `prune`, through a helper)
- the `lane/spike` branch
- `<repo>.lanes`, if it is empty
- the `cl-spike-tools` image
- the temp folder `${TMPDIR:-/tmp}/cl-spike-<uid>`

It prints exactly what it removed. It does not remove images the Dev Container CLI built (`vsc-spike-…-uid`). Their names are not `cl-spike-*`, so it prints the `docker image rm` command for them instead. It never touches the repository's files, only its `.git` worktree records and the `lane/spike` branch.

Pinned versions are at the top of the script and can be overridden from the environment with a `SPIKE_` prefix, for example `SPIKE_TMUX_VERSION=3.5a ./v4-spike.sh …`. The prefix is needed because a plain `CLAUDE_CODE_VERSION` is already set inside Claude Code terminals.

## Checks, and what a FAIL means for the plan

| # | Check | A FAIL means |
|---|---|---|
| 1 | **Preflight.** Docker reachable; client and server versions, storage driver, security options; kernel; the uids involved; the argument is a top-level repository with no `,` or `:` in its path; the Docker socket path and its gid | Fix the machine before anything else. Rootless Docker or userns-remap shows up here as a *finding*: §3.2's assumption that the folder's owner is the container's uid does not hold there |
| 2 | **Tools image.** Node 24 (bookworm), git, `@devcontainers/cli`, Docker CLI with compose and buildx, a static tmux built on Alpine, Node copied to `/tools`, the agents installed with `npm --prefix /tools/agents`, and `/tools/bin` wrappers | Usually a version or URL. The message names the variable to change. If static tmux cannot be built, §3.3's tools volume needs another tmux source |
| 3 | **Tools volume.** Fill `cl-spike-tools` from the image; the wrappers run when it is mounted at `/opt/contextlanes` | The "fill the volume from the control image" step in §3.3 needs another mechanism |
| 4 | **Git in a helper.** Run as the folder's owner with only the project mounted: is it a repository, list its branches, then `git worktree add` at `<repo>.lanes/spike`. It first tries with only `<repo>` and `<repo>.lanes` mounted (`.lanes` is created by a `-v` auto-create plus a root `chown` helper) and falls back to mounting the parent folder. It reports which layout worked and whether `safe.directory` was needed. The host then checks the worktree exists, who owns it, and that `git status` works | §3.2's Docker-backed runner does not work as written. If only the parent layout works, the plan has to accept that helpers see sibling folders |
| 5 | **Dev Container CLI from a helper.** Print `up --help` and which flags exist. Run `devcontainer up` as root in a helper with the socket, the worktree, `.git` and the spike's temp folder mounted at their own paths. Pass an override config that sets a same-path `workspaceMount` and `workspaceFolder`, the read-only tools volume and `--name`, and pass `.git` and the agent-login volume as `--mount`. Show the JSON result and the container's mounts, check `remoteWorkspaceFolder` is the host path, and run `git status` inside. Then, for information only, run the CLI again as the folder's owner (with the socket's gid added) | **Go/no-go.** The fallback in §7 applies: implement the subset of `devcontainer.json` ourselves. A FAIL only on `remoteWorkspaceFolder` or in-lane `git` means the same-path mount is not honoured. Then either the worktree needs `--relative-paths` or we use `--mount-git-worktree-common-dir` |
| 6 | **Inside the lane.** `id`; `git status`; a file written in the lane is owned on the host by the folder's owner (**the user-id check**); tmux `-V`, a detached session, `send-keys` that writes a marker, `capture-pane`, and the session still there in a second `docker exec`; `node`, `claude` and `codex --version` through the volume; the lane's libc; the tools are read-only; there is no Docker socket. For information: whether the agent-login volume is writable, and the same tools on a bare `debian:bookworm-slim` | A wrong owner means §3.2's "matching the container user to the folder's owner" is not automatic in this setup (see the findings). A tools failure means §3.3's injection does not work on this image |
| 7 | **Network.** `cl-spike-net`, the lane joined with an alias, a Node HTTP server on `0.0.0.0:3000` in the lane fetched from a second container by name. Nothing is published, and the host's `127.0.0.1:3000` does not reach it. For information: whether the host reaches the lane's bridge IP | §3.4's "router targets `<lane>:3000`" does not work as planned |
| 8 | **Restart.** `docker restart`; the worktree file, the tools volume and `git` are still there. The tmux session being gone is reported as INFO (expected) | Lane state does not survive a restart; §3.6 reboot handling needs more |
| 9 | **Agent login (MANUAL).** Commands to sign in once inside the lane with `CLAUDE_CONFIG_DIR` and `CODEX_HOME` on the shared volume, to open a second container with the same volume and confirm it is signed in, and to attach to tmux | If the second container is not signed in, §3.3's "one login volume" needs per-agent handling (the §8 risk) |

## Assumptions not verified from here

Most risky first. Items marked *checked* were confirmed locally, without Docker.

1. **The CLI's uid mapping when run as root.** Read in the 0.90.0 source: `updateRemoteUserUID` builds with `NEW_UID=$(process.getuid())`, the uid of the CLI process. When the helper runs as root that is 0, the update script says "User with UID exists (root=0)", and nothing changes. A stubbed `devcontainer up` showed `--build-arg NEW_UID=0`. Check 6's ownership test will only pass from the root helper if the folder's owner happens to be uid 1000 (the `vscode` user). The owner variant in check 5 tests the fix. The CLI also needs a user name for its uid (`os.userInfo()`, then `id -un`); the variant retries with a passwd entry if that fails.
2. **`devcontainer up` inside a container is not the documented use.** The CLI starts the lane with an attached `docker run -a STDOUT -a STDERR --sig-proxy=false` (seen with the stub). I assume the lane keeps running when the helper exits and kills that client. Feature and Compose builds may also use paths that exist only inside the helper. Neither has been run.
3. **Static tmux on Alpine.** The packages `libevent-static`, `ncurses-static` and `ncurses-terminfo-base`, and `./configure --enable-static` working for tmux 3.6a, are from memory. The terminfo copied from Alpine is reached through `TERMINFO_DIRS` in the wrapper. That `alpine:3.22` exists is also from memory (*verify on first run*). The tmux 3.6a tarball URL answered 200 (*checked*).
4. **Claude Code 2.1.314 ships a native glibc binary** (`bin/claude.exe`, platform packages, a `postinstall`), so it needs glibc in the lane image but not Node. Codex 0.166.0 is a Node launcher around a vendored binary. Both come from npm metadata (*checked*). That the installs succeed with `--prefix /tools/agents`, and still run after the move to `/opt/contextlanes`, has not been run. The wrappers call the resolved targets by relative path, tested on a fake tree.
5. **Node copied from `node:24-bookworm`** needs `libstdc++` and glibc 2.28 or newer in the lane image. Check 6 runs `ldd` on it and reports missing libraries.
6. **Docker's apt repository for Debian bookworm** with `docker-ce-cli`, `docker-buildx-plugin` and `docker-compose-plugin`, at `https://download.docker.com/linux/debian`. These are the package names from Docker's install docs, from memory.
7. **`docker run -v` still auto-creates a missing host folder** (as root) on Docker 29. Check 4 falls back to mounting the parent if it does not.
8. **Flags of `devcontainer up` 0.90.0.** All twelve requested flags exist, plus `--mount-git-worktree-common-dir` and `--no-lockfile` (*checked* from `--help` locally). From reading the source, also *checked*:
   - `--mount` only accepts `type=bind|volume,source=,target=[,external=]` (no readonly).
   - `--config` must be named `devcontainer.json` or `.devcontainer.json`.
   - `--override-config` replaces the project's config contents, while relative paths still resolve from the project's `.devcontainer/` folder.
   - `read-configuration` prints `{"configuration": …}` with variables already substituted, and it calls `docker ps`.
9. **Image tags.** `node:24-bookworm`, `mcr.microsoft.com/devcontainers/base:bookworm` (a `vscode` user with uid 1000) and `debian:bookworm-slim`, from memory.
10. **A project with its own `devcontainer.json`.** It is read with `read-configuration` and changed (workspace mount, tools mount, `--name`). `${localEnv:…}` is then resolved in the helper, not on the host. A Compose-based config falls back to the default config and is reported.
11. **`docker exec` PATH.** The `--remote-env PATH=…` flag only affects commands the CLI runs itself. Plain `docker exec` uses the image's PATH, so the script passes `PATH` explicitly and reports what it saw.

## Dry run with the stub

`fake-docker.sh` stands in for `docker`. It logs every call and answers each one the script makes. It runs the harmless parts for real: `git` in "helpers", the config generator, and file writes in the worktree. The flow, quoting (a project path with spaces), the fallbacks, the second-run cleanup and `--cleanup` were all run with it. It proves nothing about real Docker behaviour.

```sh
mkdir -p /tmp/fakebin && ln -sf "$PWD/fake-docker.sh" /tmp/fakebin/docker
python3 -c 'import socket,sys;socket.socket(socket.AF_UNIX).bind(sys.argv[1])' /tmp/fake.sock
FAKE_STATE=/tmp/fakestate DOCKER_HOST=unix:///tmp/fake.sock PATH=/tmp/fakebin:$PATH ./v4-spike.sh --allow-root <repo>
# FAKE_NO_AUTOCREATE=1 tests the parent-mount fallback; FAKE_UP_FAIL=1 tests a failed devcontainer up
```
