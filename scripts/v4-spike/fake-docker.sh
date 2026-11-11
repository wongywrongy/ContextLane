#!/usr/bin/env bash
# shellcheck disable=SC2016  # the case patterns match the spike's literal single-quoted scripts
# Stub `docker` for a dry structural run of v4-spike.sh on a machine without a Docker daemon.
# Not a Docker emulator: it logs every call, keeps a little state, answers each call the spike makes with
# plausible output, and runs the harmless parts for real (git in "helpers", the config generator, file
# writes inside the worktree) so the host-side checks have something to look at.
#
#   mkdir -p /tmp/fakebin && ln -sf "$PWD/fake-docker.sh" /tmp/fakebin/docker
#   python3 -c 'import socket,sys;socket.socket(socket.AF_UNIX).bind(sys.argv[1])' /tmp/fake.sock
#   FAKE_STATE=/tmp/fakestate DOCKER_HOST=unix:///tmp/fake.sock PATH=/tmp/fakebin:$PATH ./v4-spike.sh --allow-root <repo>
#
# Optional: FAKE_DEVCONTAINER=<path to a real devcontainer binary> so `up --help` prints the real help.
set -uo pipefail
ST="${FAKE_STATE:?set FAKE_STATE}"
mkdir -p "$ST"
{ printf 'docker'; printf ' %q' "$@"; printf '\n'; } >>"$ST/calls.log"

has() { [ -e "$ST/$1" ]; }
mark() { : >"$ST/$1"; }
unmark() { rm -f "$ST/$1"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  version)
    if [ "${1:-}" = --format ]; then echo "client 29.0.0 (API 1.52), server 29.0.0 (API 1.52)"; else printf 'Client: fake\n Version: 29.0.0\nServer: fake\n Version: 29.0.0\n'; fi ;;
  info)
    case "$*" in
      *SecurityOptions*) echo '["name=apparmor","name=seccomp,profile=builtin","name=cgroupns"]' ;;
      *) echo "storage driver: overlay2; cgroup: systemd v2; os: Ubuntu 24.04 LTS; root dir: /var/lib/docker" ;;
    esac ;;
  context) echo "unix:///var/run/docker.sock" ;;
  compose) echo "Docker Compose version v2.40.0" ;;
  buildx) echo "github.com/docker/buildx v0.29.0 fake" ;;
  build) echo "#1 [internal] load build definition"; echo "#12 [stage-1 9/9] RUN sh /usr/local/bin/cl-spike-mkwrappers /tools"; mark image ;;
  image)
    sub="$1"; shift
    case "$sub" in
      inspect) has image || exit 1 ;;
      rm) has image || exit 1; unmark image; echo "Untagged: cl-spike-tools:latest" ;;
    esac ;;
  volume)
    sub="$1"; shift
    case "$sub" in
      create) name="${*: -1}"; mark "vol-$name"; echo "$name" ;;
      inspect) has "vol-$1" || exit 1 ;;
      rm) has "vol-$1" || exit 1; unmark "vol-$1"; echo "$1" ;;
    esac ;;
  network)
    sub="$1"; shift
    case "$sub" in
      create) mark net; echo netid ;;
      connect) has net || exit 1 ;;
      inspect) has net || exit 1 ;;
      rm) has net || exit 1; unmark net; echo cl-spike-net ;;
    esac ;;
  ps)
    for f in "$ST"/ctr-*; do [ -e "$f" ] && basename "$f" | sed 's/^ctr-//'; done; exit 0 ;;
  rm)
    [ "${1:-}" = -f ] && shift
    has "ctr-$1" || exit 1; unmark "ctr-$1"; echo "$1" ;;
  restart) has "ctr-${*: -1}" || exit 1; mark restarted; unmark tmux; echo "${*: -1}" ;;
  port) exit 0 ;;
  inspect)
    fmt=""; [ "${1:-}" = -f ] && { fmt="$2"; shift 2; }
    id="${1:-}"
    has "ctr-$id" || exit 1
    name="$(cat "$ST/ctr-$id")"
    case "$fmt" in
      *State.Running*) echo true ;;
      *'.Name}} image='*) echo "/$name image=vsc-spike-0123-uid restart=no" ;;
      '{{.Name}}') echo "/$name" ;;
      *Config.Image*) echo "vsc-spike-0123-uid" ;;
      *Mounts*)
        wt="$(cat "$ST/wt")"; proj="$(cat "$ST/proj")"
        echo "bind $wt -> $wt rw=true"
        echo "volume cl-spike-tools -> /opt/contextlanes rw=false"
        echo "bind $proj/.git -> $proj/.git rw=true"
        echo "volume cl-spike-agent-home -> /opt/contextlanes-home rw=true" ;;
      *Config.Env*) echo "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"; echo "LANG=C.UTF-8" ;;
      *IPAddress*) echo "172.31.250.2" ;;
      *Aliases*) echo "[cl-spike-lane]" ;;
      *) echo "?" ;;
    esac ;;
  run)
    entry="" image="" net=""; declare -a envs=(); vsrc=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --rm|-it|-i|-t|-d) shift ;;
        --entrypoint) entry="$2"; shift 2 ;;
        -e) envs+=("$2"); shift 2 ;;
        -v) case "$2" in *:/var/run/docker.sock|cl-spike-*) ;; *) vsrc="${2%%:*}" ;; esac; shift 2 ;;
        --network) net="$2"; shift 2 ;;
        --label|--user|--group-add|--mount|--name|-w) shift 2 ;;
        -*) shift ;;
        *) image="$1"; shift; break ;;
      esac
    done
    case "$entry" in
      git) exec git "$@" ;;
      chown) [ -n "${FAKE_NO_AUTOCREATE:-}" ] && exit 1; [ -n "$vsrc" ] && mkdir -p "$vsrc"; exit 0 ;;
      cp) exit 0 ;;
      cat) cat /etc/passwd ;;
      node)
        if [ -n "$net" ]; then printf 'cl-spike-http-ok'; exit 0; fi
        exec env "${envs[@]}" node "$@" ;;
      devcontainer)
        case "$1" in
          up)
            if [ "${2:-}" = --help ]; then
              if [ -n "${FAKE_DEVCONTAINER:-}" ]; then exec "$FAKE_DEVCONTAINER" up --help; fi
              printf '  --workspace-folder x\n  --override-config x\n  --id-label x\n  --mount x\n  --remote-env x\n'; exit 0
            fi
            shift; wf="" variant=root
            while [ $# -gt 0 ]; do
              case "$1" in --workspace-folder) wf="$2"; shift 2 ;; --id-label) case "$2" in *variant=*) variant="${2##*=}" ;; esac; shift 2 ;; *) shift ;; esac
            done
            echo "[fake] devcontainer up for $wf ($variant)" >&2
            if [ -n "${FAKE_UP_FAIL:-}" ]; then echo "Error: fake failure" >&2; echo '{"outcome":"error","message":"fake"}'; exit 1; fi
            cid="fake$variant$RANDOM"
            if [ "$variant" = owner ]; then echo cl-spike-lane-owner >"$ST/ctr-$cid"; else echo cl-spike-lane >"$ST/ctr-$cid"; fi
            printf '%s\n' "$wf" >"$ST/wt"; printf '%s\n' "${wf%.lanes/*}" >"$ST/proj"
            printf '{"outcome":"success","containerId":"%s","remoteUser":"vscode","remoteWorkspaceFolder":"%s"}\n' "$cid" "$wf" ;;
          read-configuration) echo '{"configuration":{"image":"x"}}' ;;
        esac ;;
      /bin/sh)
        case "$image" in
          cl-spike-tools)
            if [ "${1:-}" = -c ] && [ "${3:-}" = sh ]; then printf 'tmux 3.6a\nv24.11.0\nclaude codex node tmux\n'; exit 0; fi
            printf 'devcontainer: 0.90.0\ndocker-cli: Docker version 29.0.0\ncompose: Docker Compose version v2.40.0\nbuildx: github.com/docker/buildx v0.29.0\ngit: git version 2.39.5\ntmux: tmux 3.6a\nnode: v24.11.0\nclaude: 2.1.314 (Claude Code)\ncodex: codex-cli 0.166.0\ntmux-file: ELF 64-bit LSB executable, x86-64, statically linked, stripped\ntmux-ldd: not a dynamic executable\ntools-size: 412M\nagents-bin: claude -> ../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe codex -> ../lib/node_modules/@openai/codex/bin/codex.js\n' ;;
          *) printf 'libc: ldd (Debian GLIBC 2.36-9+deb12u10) 2.36\ntmux: tmux 3.6a\nnode: v24.11.0\nclaude: 2.1.314 (Claude Code)\ncodex: codex-cli 0.166.0\ntmux session: ok\n' ;;
        esac ;;
      *) echo "[fake] unhandled run: entry=$entry image=$image $*" >&2; exit 1 ;;
    esac ;;
  exec)
    wd="" detach=0; declare -a envs=()
    while [ $# -gt 0 ]; do
      case "$1" in
        -u) shift 2 ;;
        -w) wd="$2"; shift 2 ;;
        -e) envs+=("$2"); shift 2 ;;
        -d) detach=1; shift ;;
        -it|-i|-t) shift ;;
        *) break ;;
      esac
    done
    id="$1"; shift
    has "ctr-$id" || { echo "Error: No such container: $id" >&2; exit 1; }
    [ "$detach" = 1 ] && exit 0
    if [ -n "$wd" ]; then cd "$wd" || exit 1; fi
    case "$1" in
      id) if [ "${2:-}" = -u ] || [ "${2:-}" = -g ]; then echo 0; else echo "uid=1000(vscode) gid=1000(vscode) groups=1000(vscode)"; fi ;;
      git) shift; exec git "$@" ;;
      tmux)
        case " $* " in
          *" -V "*) echo "tmux 3.6a" ;;
          *new-session*) mark tmux ;;
          *send-keys*) has tmux && echo cl-spike-tmux >"$wd/.cl-spike-tmux-marker" ;;
          *capture-pane*) printf 'vscode@lane:~$ echo cl-spike-tmux > .cl-spike-tmux-marker\nvscode@lane:~$\n' ;;
          *has-session*) has tmux ;;
        esac ;;
      node|claude|codex) echo "$1 fake-version" ;;
      /opt/contextlanes/bin/node) exit 0 ;;
      test)
        case "$*" in *"/opt/"*) exit 1 ;; *) exec "$@" ;; esac ;;
      sh)
        case "$*" in
          *ldd*--version*) echo "ldd (Debian GLIBC 2.36-9+deb12u10) 2.36" ;;
          *'ldd "$1"'*) exit 0 ;;
          *'touch "$1/.cl-spike-w"'*) echo read-only ;;
          *docker.sock*) echo absent ;;
          *'printf %s "$PATH"'*) echo "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" ;;
          *proc/mounts*) echo "/dev/vdb /opt/contextlanes ext4 ro,relatime 0 0" ;;
          *'/opt/'*) exit 0 ;;
          *) exec env "${envs[@]}" "$@" ;;
        esac ;;
      rm|cat) exec "$@" ;;
      *) echo "[fake] unhandled exec: $*" >&2; exit 1 ;;
    esac ;;
  *) echo "[fake] unhandled: $cmd $*" >&2; exit 1 ;;
esac
