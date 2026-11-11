#!/usr/bin/env bash
# ContextLanes v4, phase 1 spike (docs/V4.md section 7). Throwaway: no product code depends on it.
#
#   ./v4-spike.sh <path-to-git-repo>              run every check
#   ./v4-spike.sh --cleanup <path-to-git-repo>    remove everything the spike made
#   options: --keep-image (cleanup keeps the cl-spike-tools image), --allow-root, --help
#
# Every Docker object it makes is named or labelled cl-spike / contextlanes.spike=1.
# Full command output goes to ./v4-spike-<timestamp>.log; the terminal shows a summary per check.
set -uo pipefail

# ---------------------------------------------------------------------------------------------
# Pinned versions. Each can be overridden from the environment, e.g. SPIKE_TMUX_VERSION=3.5a ./v4-spike.sh ...
# (SPIKE_ prefix: a plain CLAUDE_CODE_VERSION is already set inside Claude Code terminals.)
# ---------------------------------------------------------------------------------------------
# Tools image base: Node 24 on Debian 12 (glibc). Tag exists on Docker Hub (node:24-bookworm).
SPIKE_NODE_IMAGE="${SPIKE_NODE_IMAGE:-node:24-bookworm}"
# Build stage for the static tmux. verify on first run (any Alpine 3.x with *-static packages works).
SPIKE_ALPINE_IMAGE="${SPIKE_ALPINE_IMAGE:-alpine:3.22}"
# tmux release tarball: https://github.com/tmux/tmux/releases/download/<v>/tmux-<v>.tar.gz
# (3.6a answered HTTP 200 on 2026-11-10).
SPIKE_TMUX_VERSION="${SPIKE_TMUX_VERSION:-3.6a}"
# @devcontainers/cli: latest on npm on 2026-11-10; its `up --help` was read locally at this version.
SPIKE_DEVCONTAINERS_CLI_VERSION="${SPIKE_DEVCONTAINERS_CLI_VERSION:-0.90.0}"
# Agent CLIs: copied from packages/protocol/src/agents.ts (AGENTS[claude-code].install, AGENTS[codex].install).
SPIKE_CLAUDE_CODE_VERSION="${SPIKE_CLAUDE_CODE_VERSION:-2.1.314}"
SPIKE_CODEX_VERSION="${SPIKE_CODEX_VERSION:-0.166.0}"
# Docker's apt repository suite for the Docker CLI in the tools image (matches NODE_IMAGE's Debian).
SPIKE_DOCKER_APT_SUITE="${SPIKE_DOCKER_APT_SUITE:-bookworm}"
# Default lane image when the project has no devcontainer.json (has a `vscode` user, uid 1000).
SPIKE_LANE_DEFAULT_IMAGE="${SPIKE_LANE_DEFAULT_IMAGE:-mcr.microsoft.com/devcontainers/base:bookworm}"
# An image with no Node, tmux or git: probes that the tools volume runs on a plain glibc image.
SPIKE_BARE_IMAGE="${SPIKE_BARE_IMAGE:-debian:bookworm-slim}"
# Branch and folder name of the spike's lane.
SPIKE_BRANCH="${SPIKE_BRANCH:-lane/spike}"
SPIKE_SLUG="${SPIKE_SLUG:-spike}"

# ---------------------------------------------------------------------------------------------
# Fixed names. Never change these to something without the cl-spike prefix.
# ---------------------------------------------------------------------------------------------
readonly IMG=cl-spike-tools
readonly VOL_TOOLS=cl-spike-tools
readonly VOL_HOME=cl-spike-agent-home
readonly NET=cl-spike-net
readonly LANE_NAME=cl-spike-lane
readonly LANE_OWNER_NAME=cl-spike-lane-owner
readonly HELPER_NAME=cl-spike-dc-helper
readonly LABEL=contextlanes.spike=1
readonly TOOLS_MNT=/opt/contextlanes
readonly HOME_MNT=/opt/contextlanes-home
readonly HTTP_MARKER=cl-spike-http-ok
readonly TMUX_SOCK=cl-spike

usage() {
  cat <<'EOF'
Usage:
  ./v4-spike.sh <path-to-git-repo>             run the ContextLanes v4 phase 1 spike
  ./v4-spike.sh --cleanup <path-to-git-repo>   remove everything the spike created
Options:
  --keep-image   with --cleanup: keep the cl-spike-tools image
  --allow-root   run even when invoked as root
  -h, --help     this text
Versions are variables at the top of the script and can be overridden from the environment.
EOF
}

MODE=run KEEP_IMAGE=0 ALLOW_ROOT=0 PROJECT_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cleanup) MODE=cleanup ;;
    --keep-image) KEEP_IMAGE=1 ;;
    --allow-root) ALLOW_ROOT=1 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; [ $# -gt 0 ] && { PROJECT_ARG="$1"; shift; }; [ $# -eq 0 ] || { usage >&2; exit 2; }; break ;;
    -*) printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    *) [ -z "$PROJECT_ARG" ] || { usage >&2; exit 2; }; PROJECT_ARG="$1" ;;
  esac
  shift
done
[ -n "$PROJECT_ARG" ] || { usage >&2; exit 2; }

if [ "$(id -u)" -eq 0 ] && [ "$ALLOW_ROOT" -ne 1 ]; then
  echo "Refusing to run as root: run it as the user who owns the repository (in the docker group), or pass --allow-root." >&2
  exit 2
fi
if [ ! -d "$PROJECT_ARG" ]; then
  printf 'Not a directory: %s\n' "$PROJECT_ARG" >&2
  exit 2
fi
P="$(cd -- "$PROJECT_ARG" && pwd -P)" || { echo "cannot resolve the project path" >&2; exit 2; }
PARENT="$(dirname -- "$P")"
LANES="$P.lanes"
WT="$LANES/$SPIKE_SLUG"
STATE="${TMPDIR:-/tmp}/cl-spike-$(id -u)"

TS="$(date +%Y%m%d-%H%M%S)"
if [ "$MODE" = cleanup ]; then LOG_NAME="v4-spike-cleanup-$TS.log"; else LOG_NAME="v4-spike-$TS.log"; fi
LOG="$PWD/$LOG_NAME"
: >"$LOG" || { printf 'cannot write the log file %s\n' "$LOG" >&2; exit 1; }
OUT="$(mktemp "${TMPDIR:-/tmp}/cl-spike-out.XXXXXX")" || exit 1
trap 'rm -f "$OUT"' EXIT
trap 'printf "\nInterrupted. Run: %s --cleanup %q\n" "$0" "$P" | tee -a "$LOG"; exit 130' INT TERM

# ---------------------------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------------------------
say() { printf '%s\n' "$*" | tee -a "$LOG"; }
line() { say "    $*"; }
logonly() { printf '%s\n' "$*" >>"$LOG"; }
log_cmd() { { printf '\n$'; printf ' %q' "$@"; printf '\n'; } >>"$LOG"; }

# run SECONDS cmd...: output to the log (live) and to $OUT; returns the command's exit status.
run() {
  local t="$1"; shift
  log_cmd "$@"
  timeout -k 10 "$t" "$@" 2>&1 | tee "$OUT" >>"$LOG"
  local rc="${PIPESTATUS[0]}"
  printf '[exit %s]\n' "$rc" >>"$LOG"
  [ "$rc" -eq 124 ] && line "timed out after ${t}s: $1 ${2:-}"
  return "$rc"
}

# run_split SECONDS STDOUT_FILE LOG_STDOUT(0|1) cmd...: stdout to a file, stderr to the log and $OUT.
run_split() {
  local t="$1" so="$2" logso="$3"; shift 3
  log_cmd "$@"
  { timeout -k 10 "$t" "$@" >"$so"; } 2>&1 | tee "$OUT" >>"$LOG"
  local rc="${PIPESTATUS[0]}"
  if [ "$logso" = 1 ]; then { echo "--- stdout:"; cat "$so"; } >>"$LOG"; else echo "--- stdout not logged (may contain project config)" >>"$LOG"; fi
  printf '[exit %s]\n' "$rc" >>"$LOG"
  [ "$rc" -eq 124 ] && line "timed out after ${t}s: $1 ${2:-}"
  return "$rc"
}

# Last lines of the previous command, on the terminal only (already in the log).
show_tail() { tail -n 15 "$OUT" | sed 's/^/      | /'; }
out_first() { head -n 1 "$OUT" | tr -d '\r'; }

declare -a C_TITLE=() C_RESULT=() C_TIME=()
declare -a C_FAILS=() FINDINGS=()
CUR=0
C_START=0

begin() { CUR="$1"; C_TITLE[$1]="$2"; C_FAILS=(); C_START=$SECONDS; say ""; say "[CHECK $1] $2"; }
ok() { line "ok: $*"; }
info() { line "info: $*"; }
bad() { C_FAILS+=("$*"); line "problem: $*"; }
finding() { FINDINGS+=("[$CUR] $*"); line "finding: $*"; }
finish() {
  local el=$((SECONDS - C_START)) res="" f
  case "${1:-}" in
    SKIP) res="SKIP: $2" ;;
    MANUAL) res="MANUAL" ;;
    *)
      if [ "${#C_FAILS[@]}" -gt 0 ]; then
        res="FAIL:"
        for f in "${C_FAILS[@]}"; do res="$res $f;"; done
        res="${res%;}"
      else
        res="PASS"
      fi ;;
  esac
  C_RESULT[CUR]="$res"
  C_TIME[CUR]="$el"
  say "    $res (${el}s)"
}
skip_check() { begin "$1" "$2"; finish SKIP "$3"; }
passed() { [ "${C_RESULT[$1]:-}" = PASS ]; }

image_exists() { docker image inspect "$IMG" >/dev/null 2>&1; }
container_running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }

# JSON string field from a one-line JSON document (only for simple fields without escapes).
json_field() { sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | tail -n 1; }

# ---------------------------------------------------------------------------------------------
# State shared between checks
# ---------------------------------------------------------------------------------------------
OWNER_UG="" OWNER_UID="" OWNER_GID=""
SOCK="/var/run/docker.sock" SOCK_GID=""
HOST_GIT=0
declare -a SAFE=() GIT_MOUNTS=()
declare -A HAS=()
CFGMODE=default
LANE_ID="" REMOTE_USER="" RWF="" LANE_PATH="" LANE_UID="" LANE_GID=""

read_owner() {
  OWNER_UG="$(stat -c '%u:%g' "$P")"
  OWNER_UID="${OWNER_UG%%:*}"
  OWNER_GID="${OWNER_UG##*:}"
}

detect_socket() {
  local host=""
  if [ -n "${DOCKER_HOST:-}" ]; then host="$DOCKER_HOST"; else host="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"; fi
  case "$host" in
    unix://*) SOCK="${host#unix://}" ;;
    "") SOCK="/var/run/docker.sock" ;;
    *) SOCK="" ;;
  esac
  if [ -n "$SOCK" ] && [ -S "$SOCK" ]; then SOCK_GID="$(stat -c '%g' "$SOCK")"; fi
}

# git in a helper container: only the folders in GIT_MOUNTS, as the folder's owner.
git_h() {
  local t="$1"; shift
  run "$t" docker run --rm --label "$LABEL" --user "$OWNER_UG" -e HOME=/tmp \
    "${GIT_MOUNTS[@]}" --entrypoint git "$IMG" "${SAFE[@]}" "$@"
}

# docker exec in the lane as its remote user, in the worktree, with the tools first on PATH.
lane_exec() {
  local t="$1"; shift
  run "$t" docker exec -u "$REMOTE_USER" -w "$WT" -e "PATH=$LANE_PATH" -e TERM=xterm-256color "$LANE_ID" "$@"
}

# ---------------------------------------------------------------------------------------------
# Files the spike writes into its state folder
# ---------------------------------------------------------------------------------------------
write_build_context() {
  mkdir -p "$STATE/build" || return 1
  cat >"$STATE/build/Dockerfile" <<'EOF'
# cl-spike-tools: written by v4-spike.sh. Throwaway.
ARG NODE_IMAGE=node:24-bookworm
ARG ALPINE_IMAGE=alpine:3.22

# ---- static tmux ----
FROM ${ALPINE_IMAGE} AS tmux
ARG TMUX_VERSION
RUN apk add --no-cache build-base bison curl file pkgconf \
      libevent-dev libevent-static ncurses-dev ncurses-static ncurses-terminfo-base
WORKDIR /src
RUN curl -fsSL -o tmux.tar.gz "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz" \
 && tar -xzf tmux.tar.gz \
 && cd "tmux-${TMUX_VERSION}" \
 && ./configure --enable-static --prefix=/opt/tmux \
 && make -j"$(nproc)" \
 && make install \
 && echo "file: $(file -b /opt/tmux/bin/tmux)" \
 && (ldd /opt/tmux/bin/tmux 2>&1 || true) \
 && file -b /opt/tmux/bin/tmux | grep -Eq 'statically linked|static-pie linked'
RUN mkdir -p /opt/terminfo \
 && for d in /etc/terminfo /usr/share/terminfo; do if [ -d "$d" ]; then cp -a "$d/." /opt/terminfo/; fi; done \
 && ls /opt/terminfo

# ---- tools image ----
FROM ${NODE_IMAGE}
ARG DEVCONTAINERS_CLI_VERSION
ARG CLAUDE_CODE_VERSION
ARG CODEX_VERSION
ARG DOCKER_APT_SUITE=bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg git file \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${DOCKER_APT_SUITE} stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@devcontainers/cli@${DEVCONTAINERS_CLI_VERSION}" && devcontainer --version
RUN mkdir -p /tools/bin /tools/libexec /tools/node/bin /tools/share \
 && cp /usr/local/bin/node /tools/node/bin/node
COPY --from=tmux /opt/tmux/bin/tmux /tools/libexec/tmux
COPY --from=tmux /opt/terminfo /tools/share/terminfo
RUN npm install --global --prefix /tools/agents "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && ls -l /tools/agents/bin
COPY mkwrappers.sh /usr/local/bin/cl-spike-mkwrappers
RUN sh /usr/local/bin/cl-spike-mkwrappers /tools && ls -l /tools/bin
EOF

  # Wrappers resolve their own folder at run time, so /tools works mounted anywhere (/opt/contextlanes).
  cat >"$STATE/build/mkwrappers.sh" <<'EOF'
#!/bin/sh
# Writes /tools/bin/{tmux,node,claude,codex}. Paths are relative to the folder the wrappers are in.
set -eu
T="$1"
HDR='#!/bin/sh
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
root=$(dirname -- "$here")
PATH="$root/bin:$PATH"; export PATH
'
write() { printf '%s%s\n' "$HDR" "$2" >"$T/bin/$1"; chmod 0755 "$T/bin/$1"; }

write tmux 'TERMINFO_DIRS="$root/share/terminfo${TERMINFO_DIRS:+:$TERMINFO_DIRS}:/etc/terminfo:/lib/terminfo:/usr/share/terminfo"; export TERMINFO_DIRS
exec "$root/libexec/tmux" "$@"'
write node 'exec "$root/node/bin/node" "$@"'

agent() {
  name="$1"; extra="$2"
  target=$(readlink -f "$T/agents/bin/$name")
  rel=${target#"$T"/}
  [ -f "$T/$rel" ] || { echo "no target for $name: $target" >&2; exit 1; }
  magic=$(od -An -c -N4 "$T/$rel" | tr -d ' \n')
  if [ "$magic" = '177ELF' ]; then
    write "$name" "$extra$(printf 'exec "$root/%s" "$@"' "$rel")"
  else
    write "$name" "$extra$(printf 'exec "$root/node/bin/node" "$root/%s" "$@"' "$rel")"
  fi
  echo "$name -> $rel ($magic)"
}
agent claude 'DISABLE_AUTOUPDATER=1; export DISABLE_AUTOUPDATER
'
agent codex ''
EOF

  # Builds the override devcontainer.json (run with node inside a helper container).
  cat >"$STATE/mkconfig.js" <<'EOF'
'use strict';
// Usage: node mkconfig.js <default|merge> <out.json> [read-configuration.json]. Inputs come from env.
const fs = require('fs');
const [mode, out, readcfg] = process.argv.slice(2);
const env = process.env;
let cfg;
if (mode === 'merge') {
  const raw = JSON.parse(fs.readFileSync(readcfg, 'utf8'));
  cfg = raw && raw.configuration;
  if (!cfg || typeof cfg !== 'object') { console.error('read-configuration gave no configuration'); process.exit(2); }
  if (cfg.dockerComposeFile) { console.error('compose-based devcontainer.json: not handled by the spike'); process.exit(3); }
  delete cfg.configFilePath;
} else {
  cfg = { name: env.LANE_NAME, image: env.DEFAULT_IMAGE, remoteUser: 'vscode', updateRemoteUserUID: true };
}
// The worktree's .git file points at the main repository by absolute host path: same path inside.
cfg.workspaceMount = `type=bind,source=${env.WT},target=${env.WT}`;
cfg.workspaceFolder = env.WT;
const mounts = Array.isArray(cfg.mounts) ? cfg.mounts.slice() : [];
// --mount on the CLI cannot say readonly, so the tools volume goes here.
mounts.push(`type=volume,source=${env.VOL_TOOLS},target=${env.TOOLS_MNT},readonly`);
if (env.MOUNTS_IN_CONFIG === '1') {
  mounts.push(`type=bind,source=${env.PROJECT_GIT},target=${env.PROJECT_GIT}`);
  mounts.push(`type=volume,source=${env.VOL_HOME},target=${env.HOME_MNT}`);
}
cfg.mounts = mounts;
const runArgs = Array.isArray(cfg.runArgs) ? cfg.runArgs.map(String) : [];
for (let i = runArgs.length - 1; i >= 0; i--) {
  if (runArgs[i] === '--name') runArgs.splice(i, 2);
  else if (runArgs[i].startsWith('--name=')) runArgs.splice(i, 1);
}
runArgs.push('--name', env.LANE_NAME);
cfg.runArgs = runArgs;
fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + '\n');
console.log(JSON.stringify({ mode, image: cfg.image || null, build: Boolean(cfg.build), remoteUser: cfg.remoteUser || null, mounts: mounts.length, runArgs }));
EOF
}

# mkconfig MODE NAME OUTDIR [READCFG]: writes OUTDIR/devcontainer.json. MODE is default or merge.
mkconfig() {
  local mode="$1" name="$2" outdir="$3" readcfg="${4:-}" mic=0
  [ -n "${HAS[--mount]:-}" ] || mic=1
  mkdir -p "$outdir" || return 1
  local -a args=("$mode" "$outdir/devcontainer.json")
  [ -n "$readcfg" ] && args+=("$readcfg")
  run 60 docker run --rm --label "$LABEL" --user "$(id -u):$(id -g)" \
    --mount "type=bind,source=$STATE,target=$STATE" \
    -e "LANE_NAME=$name" -e "DEFAULT_IMAGE=$SPIKE_LANE_DEFAULT_IMAGE" -e "WT=$WT" -e "VOL_TOOLS=$VOL_TOOLS" \
    -e "TOOLS_MNT=$TOOLS_MNT" -e "VOL_HOME=$VOL_HOME" -e "HOME_MNT=$HOME_MNT" -e "PROJECT_GIT=$P/.git" \
    -e "MOUNTS_IN_CONFIG=$mic" --entrypoint node "$IMG" "$STATE/mkconfig.js" "${args[@]}"
}

# up_args VARIANT CONFIG NAME: fills UP_ARGS for `devcontainer up`.
declare -a UP_ARGS=()
up_args() {
  local variant="$1" cfg="$2"
  UP_ARGS=(up --workspace-folder "$WT" --override-config "$cfg" --id-label "$LABEL"
    --id-label "contextlanes.spike.variant=$variant" --log-format text)
  if [ -n "${HAS[--mount]:-}" ]; then
    UP_ARGS+=(--mount "type=bind,source=$P/.git,target=$P/.git" --mount "type=volume,source=$VOL_HOME,target=$HOME_MNT")
  fi
  # shellcheck disable=SC2016  # ${containerEnv:PATH} is for the Dev Container CLI, not bash
  [ -n "${HAS[--remote-env]:-}" ] && UP_ARGS+=(--remote-env 'PATH=/opt/contextlanes/bin:${containerEnv:PATH}')
  [ -n "${HAS[--update-remote-user-uid-default]:-}" ] && UP_ARGS+=(--update-remote-user-uid-default on)
  [ -n "${HAS[--remove-existing-container]:-}" ] && UP_ARGS+=(--remove-existing-container)
  [ -n "${HAS[--no-lockfile]:-}" ] && UP_ARGS+=(--no-lockfile)
  return 0
}

# ---------------------------------------------------------------------------------------------
# CHECK 1: preflight
# ---------------------------------------------------------------------------------------------
check1() {
  begin 1 "Preflight"
  if ! command -v docker >/dev/null 2>&1; then bad "docker command not found"; finish; return; fi
  if ! run 30 docker version; then
    bad "docker not reachable (is the daemon running and is this user in the docker group?)"; show_tail; finish; return
  fi
  run 15 docker version --format 'client {{.Client.Version}} (API {{.Client.APIVersion}}), server {{.Server.Version}} (API {{.Server.APIVersion}})' && line "docker: $(out_first)"
  run 15 docker info --format 'storage driver: {{.Driver}}; cgroup: {{.CgroupDriver}} v{{.CgroupVersion}}; os: {{.OperatingSystem}}; root dir: {{.DockerRootDir}}' && line "$(out_first)"
  if run 15 docker info --format '{{json .SecurityOptions}}'; then
    line "security options: $(out_first)"
    grep -q rootless "$OUT" && finding "Docker runs rootless: uid mapping differs from the plan's assumptions (container uid 0 is the host user)"
    grep -q userns "$OUT" && finding "Docker uses userns-remap: same-uid file ownership will not hold"
  fi
  run 10 docker compose version && line "host compose: $(out_first)"
  run 10 docker buildx version && line "host buildx: $(out_first)"
  line "kernel: $(uname -r) ($(uname -m))"
  [ "$(uname -m)" = x86_64 ] || info "not x86_64: the agent CLI packages and the tools image are only expected to work on x86_64 here"
  line "invoking user: uid:gid $(id -u):$(id -g), groups: $(id -Gn)"
  read_owner
  line "project: $P"
  line "project owner uid:gid: $OWNER_UG"
  line "lane checkout will be: $WT"
  if [ -d "$P/.git" ]; then ok "the project has a .git directory"
  elif [ -f "$P/.git" ]; then bad "$P/.git is a file (the folder is itself a worktree or submodule); pass the main repository"
  else bad "$P is not the top level of a git repository (no .git)"; fi
  case "$P$STATE" in
    *,*|*:*) bad "the project or temp path contains ',' or ':', which Docker mount syntax cannot carry" ;;
  esac
  case "$P" in *" "*) info "the project path contains spaces (quoted throughout)" ;; esac
  detect_socket
  if [ -z "$SOCK" ]; then bad "Docker is not on a unix socket (DOCKER_HOST/context is not unix://): the helper cannot be given the socket"
  elif [ -S "$SOCK" ]; then line "docker socket: $SOCK (gid $SOCK_GID)"
  else bad "docker socket $SOCK not found"; fi
  if command -v git >/dev/null 2>&1; then HOST_GIT=1; line "host git: $(git --version)"; else info "git is not installed on the host: host-side git checks are skipped"; fi
  [ "$(id -u)" = "$OWNER_UID" ] || info "you are not the project's owner: host-side git may report dubious ownership"
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 2: tools image
# ---------------------------------------------------------------------------------------------
check2() {
  begin 2 "Tools image ($IMG)"
  if ! write_build_context; then bad "cannot write the build context in $STATE"; finish; return; fi
  line "build context: $STATE/build (Dockerfile written by the script)"
  line "versions: tmux $SPIKE_TMUX_VERSION, devcontainers/cli $SPIKE_DEVCONTAINERS_CLI_VERSION, claude-code $SPIKE_CLAUDE_CODE_VERSION, codex $SPIKE_CODEX_VERSION"
  line "building; this can take 5-15 minutes. Follow it with: tail -f $LOG_NAME"
  if ! run 2400 docker build --progress=plain --label "$LABEL" -t "$IMG" \
      --build-arg "NODE_IMAGE=$SPIKE_NODE_IMAGE" --build-arg "ALPINE_IMAGE=$SPIKE_ALPINE_IMAGE" \
      --build-arg "TMUX_VERSION=$SPIKE_TMUX_VERSION" --build-arg "DEVCONTAINERS_CLI_VERSION=$SPIKE_DEVCONTAINERS_CLI_VERSION" \
      --build-arg "CLAUDE_CODE_VERSION=$SPIKE_CLAUDE_CODE_VERSION" --build-arg "CODEX_VERSION=$SPIKE_CODEX_VERSION" \
      --build-arg "DOCKER_APT_SUITE=$SPIKE_DOCKER_APT_SUITE" "$STATE/build"; then
    show_tail
    local step
    step="$(grep -E '^#[0-9]+ \[' "$OUT" | tail -n 1)"
    line "last build step: ${step:-unknown}"
    case "$step" in
      *tmux.tar.gz*|*configure*) bad "static tmux build failed: change SPIKE_TMUX_VERSION (or SPIKE_ALPINE_IMAGE)" ;;
      *"FROM"*alpine*|*tmux\ 1/*) bad "alpine stage failed: change SPIKE_ALPINE_IMAGE" ;;
      *docker-ce-cli*|*download.docker.com*) bad "Docker CLI install failed: check SPIKE_DOCKER_APT_SUITE" ;;
      *devcontainers/cli*) bad "Dev Container CLI install failed: change SPIKE_DEVCONTAINERS_CLI_VERSION" ;;
      *claude-code*|*codex*) bad "agent install failed: check SPIKE_CLAUDE_CODE_VERSION / SPIKE_CODEX_VERSION" ;;
      *) bad "image build failed: see the log (variables: SPIKE_NODE_IMAGE, SPIKE_ALPINE_IMAGE, SPIKE_TMUX_VERSION, SPIKE_DEVCONTAINERS_CLI_VERSION, SPIKE_CLAUDE_CODE_VERSION, SPIKE_CODEX_VERSION, SPIKE_DOCKER_APT_SUITE)" ;;
    esac
    finish; return
  fi
  ok "image built"
  # shellcheck disable=SC2016  # the script runs inside the container
  local probe='
v() { n=$1; shift; if o=$("$@" 2>&1); then printf "%s: %s\n" "$n" "$(printf "%s" "$o" | head -n 1)"; else printf "MISSING %s: %s\n" "$n" "$(printf "%s" "$o" | tail -n 1)"; fi; }
v devcontainer devcontainer --version
v docker-cli docker --version
v compose docker compose version
v buildx docker buildx version
v git git --version
v tmux /tools/bin/tmux -V
v node /tools/bin/node --version
v claude /tools/bin/claude --version
v codex /tools/bin/codex --version
printf "tmux-file: %s\n" "$(file -b /tools/libexec/tmux)"
printf "tmux-ldd: %s\n" "$(ldd /tools/libexec/tmux 2>&1 | head -n 1)"
printf "tools-size: %s\n" "$(du -sh /tools | cut -f1)"
printf "agents-bin: %s\n" "$(ls -l /tools/agents/bin | tail -n +2 | sed "s/.* \([^ ]* -> .*\)/\1/" | tr "\n" " ")"
'
  if ! run 180 docker run --rm --label "$LABEL" --entrypoint /bin/sh "$IMG" -c "$probe"; then
    bad "could not run the tools image"; show_tail; finish; return
  fi
  local l
  while IFS= read -r l; do
    case "$l" in
      MISSING*) bad "${l#MISSING }" ;;
      *) line "$l" ;;
    esac
  done <"$OUT"
  if grep -Eq '^tmux-file: .*(statically linked|static-pie linked)' "$OUT"; then ok "tmux is statically linked"
  else bad "tmux is not statically linked"; fi
  if grep -q '^agents-bin: .*-> /tools/' "$OUT"; then
    finding "npm global bins are absolute symlinks into /tools; the wrappers call the targets directly, so this is harmless"
  fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 3: tools volume
# ---------------------------------------------------------------------------------------------
check3() {
  begin 3 "Tools volume ($VOL_TOOLS)"
  if ! run 30 docker volume create --label "$LABEL" "$VOL_TOOLS"; then bad "volume create failed"; show_tail; finish; return; fi
  if ! run 300 docker run --rm --label "$LABEL" -v "$VOL_TOOLS:/out" --entrypoint cp "$IMG" -a /tools/. /out/; then
    bad "copying /tools into the volume failed"; show_tail; finish; return
  fi
  ok "filled from the image"
  # shellcheck disable=SC2016
  if run 60 docker run --rm --label "$LABEL" -v "$VOL_TOOLS:$TOOLS_MNT:ro" --entrypoint /bin/sh "$IMG" \
      -c '"$1/bin/tmux" -V && "$1/bin/node" --version && ls "$1/bin" | tr "\n" " "' sh "$TOOLS_MNT"; then
    line "mounted at $TOOLS_MNT: $(tr '\n' ' ' <"$OUT")"
  else
    bad "wrappers do not run from $TOOLS_MNT"; show_tail
  fi
  if docker volume inspect "$VOL_HOME" >/dev/null 2>&1; then info "agent-login volume $VOL_HOME already exists (kept between runs)"
  elif run 30 docker volume create --label "$LABEL" "$VOL_HOME"; then ok "agent-login volume $VOL_HOME created"
  else bad "could not create $VOL_HOME"; fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 4: git in a helper container
# ---------------------------------------------------------------------------------------------
check4() {
  begin 4 "Helper container git"
  line "worktree: $WT"
  GIT_MOUNTS=(--mount "type=bind,source=$P,target=$P")
  SAFE=()
  if ! git_h 60 -C "$P" rev-parse --is-inside-work-tree; then
    if grep -q 'dubious ownership' "$OUT"; then
      SAFE=(-c 'safe.directory=*')
      finding "safe.directory was needed even as the folder's owner"
      git_h 60 -C "$P" rev-parse --is-inside-work-tree || { bad "not a repository from inside the helper"; show_tail; finish; return; }
    else
      bad "git in the helper failed"; show_tail; finish; return
    fi
  else
    ok "repository confirmed from a helper running as $OWNER_UG with only $P mounted; safe.directory not needed"
  fi
  git_h 30 --version && line "helper $(out_first)"
  if git_h 60 -C "$P" branch --list --format='%(refname:short)'; then
    line "branches ($(wc -l <"$OUT")): $(head -n 10 "$OUT" | tr '\n' ' ')"
  else
    bad "could not list branches"; show_tail
  fi
  if ! git_h 30 -C "$P" rev-parse --verify --quiet HEAD; then bad "the repository has no commits (HEAD unborn)"; finish; return; fi
  if [ -e "$WT" ]; then bad "$WT already exists and is not the spike's (left untouched); move it or set SPIKE_SLUG"; finish; return; fi
  if git_h 30 -C "$P" rev-parse --verify --quiet "refs/heads/$SPIKE_BRANCH"; then
    bad "branch $SPIKE_BRANCH already exists and was not cleaned up as the spike's; delete it or set SPIKE_BRANCH"; finish; return
  fi

  # Narrow first: the project plus <project>.lanes only. Docker -v creates a missing source folder (as root),
  # a root helper with only that folder mounted hands it to the owner.
  local approach=""
  if [ ! -e "$LANES" ]; then
    if run 60 docker run --rm --label "$LABEL" --user 0:0 -v "$LANES:$LANES" --entrypoint chown "$IMG" "$OWNER_UG" "$LANES" && [ -d "$LANES" ]; then
      : >"$STATE/lanes-created"
      ok "$LANES created by 'docker run -v' (auto-create) and chowned to $OWNER_UG by a root helper"
    else
      info "could not create $LANES from a narrow helper"; show_tail
    fi
  fi
  if [ -d "$LANES" ]; then
    GIT_MOUNTS=(--mount "type=bind,source=$P,target=$P" --mount "type=bind,source=$LANES,target=$LANES")
    if git_h 120 -C "$P" worktree add -b "$SPIKE_BRANCH" "$WT" HEAD; then approach=narrow; fi
  fi
  if [ -z "$approach" ]; then
    [ -d "$LANES" ] && { info "narrow worktree add failed:"; show_tail; }
    GIT_MOUNTS=(--mount "type=bind,source=$PARENT,target=$PARENT")
    if git_h 30 -C "$P" rev-parse --verify --quiet "refs/heads/$SPIKE_BRANCH"; then
      : >"$STATE/branch-created"
      git_h 120 -C "$P" worktree add "$WT" "$SPIKE_BRANCH" && approach=parent
    else
      git_h 120 -C "$P" worktree add -b "$SPIKE_BRANCH" "$WT" HEAD && approach=parent
    fi
    [ -d "$LANES" ] && [ ! -e "$STATE/lanes-created" ] && [ "$approach" = parent ] && : >"$STATE/lanes-created"
  fi
  if [ -z "$approach" ]; then bad "git worktree add failed with both mount layouts"; show_tail; finish; return; fi
  : >"$STATE/branch-created"
  printf '%s\n' "$P" >"$STATE/project"
  if [ "$approach" = narrow ]; then
    ok "worktree added on $SPIKE_BRANCH with only $P and $LANES mounted"
    finding "the parent folder did not need mounting: '$LANES' can be created by a -v auto-create plus a root chown helper, then mounted"
  else
    ok "worktree added on $SPIKE_BRANCH with the parent $PARENT mounted"
    finding "the worktree needed the project's parent folder mounted ($PARENT), which exposes sibling folders to that helper"
  fi
  # On the host
  if [ -f "$WT/.git" ]; then ok "on the host: $WT exists; .git says '$(head -n 1 "$WT/.git")'"; else bad "worktree not visible on the host"; fi
  local wt_owner
  wt_owner="$(stat -c '%u:%g' "$WT" 2>/dev/null || echo missing)"
  if [ "$wt_owner" = "$OWNER_UG" ]; then ok "worktree owned by $wt_owner (the folder's owner)"; else bad "worktree owned by $wt_owner, expected $OWNER_UG"; fi
  if [ -e "$LANES" ]; then line "$LANES owned by $(stat -c '%u:%g' "$LANES")"; fi
  if [ "$HOST_GIT" = 1 ]; then
    if run 30 git -C "$WT" status --short --branch; then ok "host git status: $(out_first)"
    elif grep -q 'dubious ownership' "$OUT"; then info "host git refused (dubious ownership): you are not the owner"
    else bad "host git status failed in the worktree"; show_tail; fi
  fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 5: Dev Container CLI from a helper container
# ---------------------------------------------------------------------------------------------
declare -a DC_MOUNTS=()
dc_helper_mounts() {
  DC_MOUNTS=(-v "$SOCK:/var/run/docker.sock"
    --mount "type=bind,source=$WT,target=$WT"
    --mount "type=bind,source=$P/.git,target=$P/.git"
    --mount "type=bind,source=$STATE,target=$STATE,readonly")
}

check5() {
  begin 5 "Dev Container CLI from a helper container"
  if run 60 docker run --rm --label "$LABEL" --entrypoint devcontainer "$IMG" up --help; then
    cp "$OUT" "$STATE/up-help.txt"
  else
    bad "devcontainer up --help failed"; show_tail; finish; return
  fi
  local f present="" missing=""
  for f in --workspace-folder --config --override-config --id-label --mount --remote-env --additional-features \
      --remove-existing-container --update-remote-user-uid-default --workspace-mount-consistency \
      --mount-workspace-git-root --docker-path --mount-git-worktree-common-dir --no-lockfile; do
    if awk '{print $1}' "$STATE/up-help.txt" | grep -qxF -- "$f"; then HAS[$f]=1; present="$present $f"; else missing="$missing $f"; fi
  done
  line "flags present:${present:- none}"
  line "flags missing:${missing:- none}"
  for f in --workspace-folder --override-config --id-label; do
    [ -n "${HAS[$f]:-}" ] || { bad "required flag $f missing: see docs/V4.md section 7 fallback"; }
  done
  [ "${#C_FAILS[@]}" -eq 0 ] || { finish; return; }
  grep -q 'readonly' "$STATE/up-help.txt" || finding "devcontainer up --mount has no readonly option; the read-only tools volume must go in the config's mounts"
  [ -n "${HAS[--mount-git-worktree-common-dir]:-}" ] && info "--mount-git-worktree-common-dir exists but needs worktrees made with 'git worktree add --relative-paths' (git >= 2.48); not used here"

  dc_helper_mounts
  local projcfg=""
  CFGMODE=default
  if [ -f "$WT/.devcontainer/devcontainer.json" ]; then projcfg="$WT/.devcontainer/devcontainer.json"
  elif [ -f "$WT/.devcontainer.json" ]; then projcfg="$WT/.devcontainer.json"; fi
  if [ -n "$projcfg" ]; then
    line "project config: ${projcfg#"$WT"/}"
    if run_split 180 "$STATE/readcfg.json" 0 docker run --rm --label "$LABEL" "${DC_MOUNTS[@]}" --entrypoint devcontainer "$IMG" \
        read-configuration --workspace-folder "$WT"; then
      if mkconfig merge "$LANE_NAME" "$STATE/dc-root" "$STATE/readcfg.json"; then
        CFGMODE=merge
        ok "override = the project's config + same-path workspace mount + tools mount: $(tail -n 1 "$OUT")"
      else
        info "could not merge the project's config (compose-based or unreadable): $(tail -n 1 "$OUT"); using the default config"
        finding "a compose-based devcontainer.json needs its own handling (workspaceMount is ignored for compose)"
      fi
    else
      info "devcontainer read-configuration failed; using the default config"; show_tail
    fi
  else
    line "the project has no devcontainer.json: default config ($SPIKE_LANE_DEFAULT_IMAGE, remoteUser vscode)"
  fi
  if [ "$CFGMODE" = default ]; then
    mkconfig default "$LANE_NAME" "$STATE/dc-root" || { bad "could not write the override config"; show_tail; finish; return; }
    ok "override config written: $(tail -n 1 "$OUT")"
  fi
  logonly "override config keys added by the spike: workspaceMount, workspaceFolder, mounts(+tools ro), runArgs(--name)"

  up_args root "$STATE/dc-root/devcontainer.json"
  line "helper runs as root with $SOCK mounted; running devcontainer up (image pull and build can take minutes)"
  if ! run_split 1500 "$STATE/up-root.out" 1 docker run --rm --label "$LABEL" --name "$HELPER_NAME" "${DC_MOUNTS[@]}" \
      --entrypoint devcontainer "$IMG" "${UP_ARGS[@]}"; then
    bad "devcontainer up failed"; show_tail
    [ -s "$STATE/up-root.out" ] && line "result: $(grep '^{' "$STATE/up-root.out" | tail -n 1)"
    finish; return
  fi
  grep '^{' "$STATE/up-root.out" | tail -n 1 >"$STATE/up-root.json"
  line "result: $(cat "$STATE/up-root.json")"
  local outcome
  outcome="$(json_field "$STATE/up-root.json" outcome)"
  LANE_ID="$(json_field "$STATE/up-root.json" containerId)"
  REMOTE_USER="$(json_field "$STATE/up-root.json" remoteUser)"
  RWF="$(json_field "$STATE/up-root.json" remoteWorkspaceFolder)"
  if [ "$outcome" != success ] || [ -z "$LANE_ID" ]; then bad "devcontainer up outcome: ${outcome:-none}"; finish; return; fi
  REMOTE_USER="${REMOTE_USER:-root}"
  docker inspect -f '{{.Config.Image}}' "$LANE_ID" >>"$STATE/images-made" 2>/dev/null
  run 15 docker inspect -f '{{.Name}} image={{.Config.Image}} restart={{.HostConfig.RestartPolicy.Name}}' "$LANE_ID" && line "lane container: $(out_first)"
  grep -q "/$LANE_NAME " "$OUT" || bad "lane container is not named $LANE_NAME (runArgs --name not honoured)"
  if run 15 docker inspect -f '{{range .Mounts}}{{.Type}} {{.Source}}{{.Name}} -> {{.Destination}} rw={{.RW}}{{"\n"}}{{end}}' "$LANE_ID"; then
    while IFS= read -r f; do [ -n "$f" ] && line "mount: $f"; done <"$OUT"
    grep -q 'docker.sock' "$OUT" && bad "the docker socket is mounted into the lane"
    grep -q " -> $TOOLS_MNT rw=false" "$OUT" || bad "tools volume not mounted read-only at $TOOLS_MNT"
    grep -qF -- "-> $P/.git " "$OUT" || bad "project .git not mounted at $P/.git"
    grep -q " -> $HOME_MNT rw=true" "$OUT" || bad "agent-login volume not mounted at $HOME_MNT"
  fi
  if [ "$RWF" = "$WT" ]; then ok "remoteWorkspaceFolder is the host path ($WT)"
  else bad "remoteWorkspaceFolder is '$RWF', not the host path $WT: workspaceMount/workspaceFolder not honoured"; fi
  local img_path
  img_path="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$LANE_ID" | sed -n 's/^PATH=//p' | head -n 1)"
  LANE_PATH="$TOOLS_MNT/bin:${img_path:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
  # shellcheck disable=SC2016
  if run 15 docker exec -u "$REMOTE_USER" "$LANE_ID" sh -c 'printf %s "$PATH"'; then
    case "$(out_first)" in
      *"$TOOLS_MNT/bin"*) info "plain docker exec PATH includes the tools" ;;
      *) finding "--remote-env PATH applies only to commands the CLI runs; plain 'docker exec' PATH is '$(out_first)', so the control service must pass PATH itself" ;;
    esac
  fi
  if lane_exec 30 git status --short --branch; then ok "git status inside the lane: $(out_first)"
  else
    bad "git status fails inside the lane"; show_tail
    grep -q 'dubious ownership' "$OUT" && finding "git in the lane reports dubious ownership: the lane user's uid differs from the repository owner's"
  fi

  # Variant: the CLI as the folder's owner (socket gid added). Recorded, never fails the check.
  if [ -n "$SOCK_GID" ]; then
    check5_owner
  else
    info "socket gid unknown: the run as the folder's owner was not tried"
  fi
  finish
}

check5_owner() {
  line "--- variant: helper as the folder's owner $OWNER_UG with --group-add $SOCK_GID"
  if [ "$CFGMODE" = merge ]; then
    mkconfig merge "$LANE_OWNER_NAME" "$STATE/dc-owner" "$STATE/readcfg.json" || { info "owner variant: could not write config"; return; }
  else
    mkconfig default "$LANE_OWNER_NAME" "$STATE/dc-owner" || { info "owner variant: could not write config"; return; }
  fi
  up_args owner "$STATE/dc-owner/devcontainer.json"
  local -a uargs=(--user "$OWNER_UG" --group-add "$SOCK_GID" -e HOME=/tmp)
  local how=""
  if run_split 1500 "$STATE/up-owner.out" 1 docker run --rm --label "$LABEL" --name "$HELPER_NAME-owner" "${uargs[@]}" "${DC_MOUNTS[@]}" \
      --entrypoint devcontainer "$IMG" "${UP_ARGS[@]}"; then
    how="as is"
  elif grep -qiE 'cannot find name|no such user|uv_os_get_passwd|userInfo' "$OUT"; then
    info "the CLI needs a user name for uid $OWNER_UID; retrying with a passwd entry"
    if run_split 30 "$STATE/passwd" 1 docker run --rm --label "$LABEL" --entrypoint cat "$IMG" /etc/passwd; then
      grep -q "^[^:]*:[^:]*:$OWNER_UID:" "$STATE/passwd" || printf 'clspike:x:%s:%s:cl-spike:/tmp:/bin/sh\n' "$OWNER_UID" "$OWNER_GID" >>"$STATE/passwd"
      if run_split 1500 "$STATE/up-owner.out" 1 docker run --rm --label "$LABEL" --name "$HELPER_NAME-owner" "${uargs[@]}" \
          --mount "type=bind,source=$STATE/passwd,target=/etc/passwd,readonly" "${DC_MOUNTS[@]}" \
          --entrypoint devcontainer "$IMG" "${UP_ARGS[@]}"; then
        how="with a passwd entry for the uid"
      fi
    fi
  fi
  if [ -z "$how" ]; then
    info "devcontainer up as the folder's owner failed (see log)"; show_tail
    finding "the Dev Container CLI did not run as the folder's owner; only the root helper worked"
    return
  fi
  local oj oid ouser
  oj="$(grep '^{' "$STATE/up-owner.out" | tail -n 1)"
  printf '%s\n' "$oj" >"$STATE/up-owner.json"
  oid="$(json_field "$STATE/up-owner.json" containerId)"
  ouser="$(json_field "$STATE/up-owner.json" remoteUser)"
  line "owner variant result: $oj"
  if [ -z "$oid" ]; then info "owner variant: no container id"; return; fi
  docker inspect -f '{{.Config.Image}}' "$oid" >>"$STATE/images-made" 2>/dev/null
  finding "devcontainer up works as the folder's owner ($how)"
  # shellcheck disable=SC2016
  if run 30 docker exec -u "${ouser:-root}" -w "$WT" "$oid" sh -c 'id; printf x > "$1"' sh "$WT/.cl-spike-owner-write"; then
    line "owner variant id: $(out_first)"
    local o
    o="$(stat -c '%u:%g' "$WT/.cl-spike-owner-write" 2>/dev/null || echo missing)"
    if [ "$o" = "$OWNER_UG" ]; then finding "with the CLI run as the owner, files written in the lane are owned by $o (matches)"
    else finding "with the CLI run as the owner, files written in the lane are owned by $o, expected $OWNER_UG"; fi
    run 15 docker exec -u "${ouser:-root}" "$oid" rm -f "$WT/.cl-spike-owner-write" || true
  fi
  run 30 docker rm -f "$oid" && info "owner variant container removed"
}

# ---------------------------------------------------------------------------------------------
# CHECK 6: inside the lane container
# ---------------------------------------------------------------------------------------------
check6() {
  begin 6 "Inside the lane container"
  if [ -z "$LANE_ID" ] || ! container_running "$LANE_ID"; then finish SKIP "no running lane container from check 5"; return; fi
  if lane_exec 15 id; then line "id: $(out_first)"; else bad "docker exec as $REMOTE_USER failed"; show_tail; finish; return; fi
  LANE_UID="$(docker exec -u "$REMOTE_USER" "$LANE_ID" id -u 2>/dev/null)"
  LANE_GID="$(docker exec -u "$REMOTE_USER" "$LANE_ID" id -g 2>/dev/null)"
  if lane_exec 30 git status --short --branch; then ok "git status: $(out_first)"; else bad "git status fails in the lane"; show_tail; fi

  # The user-id check
  local testf="$WT/.cl-spike-write-test" owner
  # shellcheck disable=SC2016
  if lane_exec 15 sh -c 'echo cl-spike > "$1"' sh "$testf"; then
    owner="$(stat -c '%u:%g' "$testf" 2>/dev/null || echo missing)"
    if [ "$owner" = "$OWNER_UG" ]; then ok "file written in the lane is owned on the host by $owner (the folder's owner)"
    else
      bad "file written in the lane is owned on the host by $owner, expected $OWNER_UG"
      finding "the root helper's CLI maps the lane user to the CLI's own uid (0), which changes nothing; the CLI must run as the folder's owner (see check 5 variant)"
    fi
    [ "$OWNER_UID" = 1000 ] && info "the folder's owner is uid 1000, the same as the image's vscode user, so a match here can be a coincidence"
  else
    bad "cannot write in the worktree as $REMOTE_USER"; show_tail
  fi

  # tmux
  if lane_exec 15 tmux -V; then ok "$TOOLS_MNT/bin/tmux -V: $(out_first)"; else bad "tmux does not run in the lane"; show_tail; fi
  if lane_exec 15 tmux -L "$TMUX_SOCK" new-session -d -s spike -x 120 -y 30 -c "$WT"; then
    lane_exec 15 tmux -L "$TMUX_SOCK" send-keys -t spike 'echo cl-spike-tmux > .cl-spike-tmux-marker' Enter
    local i got=0
    for i in 1 2 3 4 5 6 7 8 9 10; do
      if docker exec -u "$REMOTE_USER" "$LANE_ID" test -f "$WT/.cl-spike-tmux-marker"; then got=1; break; fi
      sleep 1
    done
    logonly "marker polls: $i"
    if [ "$got" = 1 ]; then ok "keys sent to tmux ran (marker file written)"; else bad "tmux send-keys did not write the marker"; fi
    if lane_exec 15 tmux -L "$TMUX_SOCK" capture-pane -p -t spike; then
      line "capture-pane: $(grep -v '^[[:space:]]*$' "$OUT" | tail -n 3 | tr '\n' '|')"
    else bad "capture-pane failed"; fi
    if lane_exec 15 tmux -L "$TMUX_SOCK" has-session -t spike; then ok "session survives into a second docker exec"
    else bad "tmux session gone after the exec that made it ended"; fi
  else
    bad "tmux new-session failed"; show_tail
  fi

  # Agents and Node through the tools volume
  local cmd
  for cmd in node claude codex; do
    if lane_exec 60 "$cmd" --version; then ok "$cmd --version: $(out_first)"; else bad "$cmd --version failed in the lane"; show_tail; fi
  done
  # shellcheck disable=SC2016
  lane_exec 15 sh -c 'ldd --version 2>&1 | head -n 1' && line "lane libc: $(out_first)"
  # shellcheck disable=SC2016
  if lane_exec 15 sh -c 'ldd "$1" 2>&1 | grep "not found" || true' sh "$TOOLS_MNT/node/bin/node" && [ -s "$OUT" ]; then
    bad "node from the tools volume misses libraries in this image: $(tr '\n' ' ' <"$OUT")"
  fi
  # shellcheck disable=SC2016
  lane_exec 15 sh -c 'if touch "$1/.cl-spike-w" 2>/dev/null; then echo writable; else echo read-only; fi' sh "$TOOLS_MNT"
  if [ "$(out_first)" = read-only ]; then ok "tools volume is read-only in the lane"; else bad "tools volume is writable in the lane"; fi
  lane_exec 15 sh -c 'if [ -e /var/run/docker.sock ]; then echo present; else echo absent; fi'
  if [ "$(out_first)" = absent ]; then ok "no docker socket in the lane"; else bad "/var/run/docker.sock exists in the lane"; fi

  # Agent-login volume: who owns it, and make it usable for the lane user
  if docker exec -u "$REMOTE_USER" "$LANE_ID" test -w "$HOME_MNT"; then info "$HOME_MNT is writable by $REMOTE_USER as created"
  else
    finding "$HOME_MNT (a fresh named volume) is root-owned; it had to be chowned to the lane user ($LANE_UID:$LANE_GID). Lanes with different uids cannot share it as is"
  fi
  # shellcheck disable=SC2016
  run 15 docker exec -u 0 "$LANE_ID" sh -c 'mkdir -p "$1/claude" "$1/codex" && chown "$2" "$1" "$1/claude" "$1/codex"' sh "$HOME_MNT" "$LANE_UID:$LANE_GID" \
    || { bad "could not prepare $HOME_MNT"; show_tail; }

  # Portability probe (INFO only): the tools volume on an image with nothing installed
  # shellcheck disable=SC2016
  if run 300 docker run --rm --label "$LABEL" -e TERM=xterm-256color -v "$VOL_TOOLS:$TOOLS_MNT:ro" --entrypoint /bin/sh "$SPIKE_BARE_IMAGE" -c '
      t="$1"
      echo "libc: $(ldd --version 2>&1 | head -n 1)"
      for c in tmux node claude codex; do
        if [ "$c" = tmux ]; then a=-V; else a=--version; fi
        if o=$("$t/bin/$c" "$a" 2>&1); then echo "$c: $(echo "$o" | head -n 1)"; else echo "$c FAILED: $(echo "$o" | tail -n 1)"; fi
      done
      "$t/bin/tmux" -L probe new-session -d -s p && "$t/bin/tmux" -L probe has-session -t p && echo "tmux session: ok"' sh "$TOOLS_MNT"; then
    while IFS= read -r cmd; do info "on $SPIKE_BARE_IMAGE: $cmd"; done <"$OUT"
    grep -q FAILED "$OUT" && finding "the tools volume does not fully work on $SPIKE_BARE_IMAGE (see above)"
  else
    info "could not run the $SPIKE_BARE_IMAGE probe (see log)"
  fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 7: network
# ---------------------------------------------------------------------------------------------
host_get() { # host_get HOST PORT: raw HTTP GET from the host with bash /dev/tcp
  # shellcheck disable=SC2016
  timeout 5 bash -c 'exec 3<>"/dev/tcp/$1/$2" || exit 7; printf "GET / HTTP/1.0\r\nHost: x\r\n\r\n" >&3; cat <&3' _ "$1" "$2" 2>&1
}

check7() {
  begin 7 "Private network ($NET)"
  if [ -z "$LANE_ID" ] || ! container_running "$LANE_ID"; then finish SKIP "no running lane container from check 5"; return; fi
  run 30 docker network create --label "$LABEL" "$NET" || { bad "network create failed"; show_tail; finish; return; }
  run 30 docker network connect --alias "$LANE_NAME" "$NET" "$LANE_ID" || { bad "network connect failed"; show_tail; finish; return; }
  ok "lane connected with alias $LANE_NAME"
  run 15 docker exec -d -u "$REMOTE_USER" "$LANE_ID" "$TOOLS_MNT/bin/node" -e \
    "require('http').createServer((q,r)=>r.end(process.argv[1])).listen(3000,'0.0.0.0')" "$HTTP_MARKER" \
    || { bad "could not start the HTTP server in the lane"; show_tail; finish; return; }
  local i up=0
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if docker exec -u "$REMOTE_USER" "$LANE_ID" "$TOOLS_MNT/bin/node" -e \
        "fetch('http://127.0.0.1:3000/').then(r=>r.text()).then(t=>process.exit(t===process.argv[1]?0:1),()=>process.exit(1))" "$HTTP_MARKER" >/dev/null 2>&1; then
      up=1; break
    fi
    sleep 1
  done
  logonly "server polls: $i"
  if [ "$up" = 1 ]; then ok "server answers inside the lane on 0.0.0.0:3000"; else bad "server did not come up in the lane"; fi
  if run 120 docker run --rm --label "$LABEL" --network "$NET" --entrypoint node "$IMG" -e \
      "fetch(process.argv[1]).then(r=>r.text()).then(t=>process.stdout.write(t),e=>{console.error(String(e));process.exit(1)})" \
      "http://$LANE_NAME:3000/"; then
    if [ "$(out_first)" = "$HTTP_MARKER" ]; then ok "a second container on $NET got '$HTTP_MARKER' from http://$LANE_NAME:3000/"
    else bad "second container got '$(out_first)', expected '$HTTP_MARKER'"; fi
  else
    bad "second container could not reach http://$LANE_NAME:3000/"; show_tail
  fi
  run 15 docker port "$LANE_ID"
  if [ -s "$OUT" ]; then bad "the lane publishes ports: $(tr '\n' ' ' <"$OUT")"; else ok "no ports published"; fi
  local r
  r="$(host_get 127.0.0.1 3000)"
  logonly "host loopback probe: $r"
  case "$r" in
    *"$HTTP_MARKER"*) bad "the lane's port 3000 is reachable on the host's 127.0.0.1" ;;
    *HTTP/*) ok "host 127.0.0.1:3000 does not reach the lane (something else answers there, not the lane)" ;;
    *) ok "host 127.0.0.1:3000 does not reach the lane" ;;
  esac
  local ip
  ip="$(docker inspect -f "{{with index .NetworkSettings.Networks \"$NET\"}}{{.IPAddress}}{{end}}" "$LANE_ID" 2>/dev/null)"
  if [ -n "$ip" ]; then
    r="$(host_get "$ip" 3000)"
    logonly "host -> $ip:3000 probe: $r"
    case "$r" in
      *"$HTTP_MARKER"*) finding "the host (any local process) reaches the lane directly at its bridge IP $ip:3000; 'not published' is not 'unreachable from the host', so tokens stay necessary" ;;
      *) info "the host cannot reach the lane's bridge IP $ip:3000" ;;
    esac
  fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 8: persistence across a restart
# ---------------------------------------------------------------------------------------------
check8() {
  begin 8 "Persistence across docker restart"
  if [ -z "$LANE_ID" ] || ! docker inspect "$LANE_ID" >/dev/null 2>&1; then finish SKIP "no lane container from check 5"; return; fi
  run 90 docker restart -t 5 "$LANE_ID" || { bad "docker restart failed"; show_tail; finish; return; }
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do container_running "$LANE_ID" && break; sleep 1; done
  container_running "$LANE_ID" || { bad "lane not running after restart"; finish; return; }
  ok "restarted"
  if lane_exec 15 cat "$WT/.cl-spike-write-test"; then ok "worktree file still there"; else bad "worktree file missing after restart"; fi
  if lane_exec 15 tmux -V; then ok "tools volume still mounted ($(out_first))"; else bad "tools not available after restart"; fi
  # shellcheck disable=SC2016
  lane_exec 15 sh -c 'grep " $1 " /proc/mounts' sh "$TOOLS_MNT" && line "mount: $(out_first)"
  if lane_exec 15 git status --short --branch; then ok "git status after restart"; else bad "git status fails after restart"; fi
  if lane_exec 15 tmux -L "$TMUX_SOCK" has-session -t spike; then info "tmux session survived the restart (unexpected)"
  else info "tmux session is gone after restart (expected; v4 needs a start script to bring it back)"; fi
  run 15 docker inspect -f "{{with index .NetworkSettings.Networks \"$NET\"}}{{.Aliases}}{{end}}" "$LANE_ID" && info "network aliases after restart: $(out_first)"
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 9: agent login (manual)
# ---------------------------------------------------------------------------------------------
check9() {
  begin 9 "Agent login (manual)"
  local ru="${REMOTE_USER:-vscode}" ug="${LANE_UID:-1000}:${LANE_GID:-1000}" lp="${LANE_PATH:-$TOOLS_MNT/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
  local base_path="$TOOLS_MNT/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  line "Not automated. Run these yourself, then paste what you saw:"
  line "(a) sign in once inside the lane:"
  say "$(printf '      docker exec -it -u %q -w %q -e CLAUDE_CONFIG_DIR=%q -e CODEX_HOME=%q -e PATH=%q -e TERM=xterm-256color %q bash' \
    "$ru" "$WT" "$HOME_MNT/claude" "$HOME_MNT/codex" "$lp" "$LANE_NAME")"
  line "    then: claude   (inside it type /login, finish, then /exit)"
  line "    then: codex login --device-auth   and   codex login status"
  line "(b) a second container with the same volume should already be signed in:"
  say "$(printf '      docker run --rm -it --label %q --user %q -e HOME=/tmp -e CLAUDE_CONFIG_DIR=%q -e CODEX_HOME=%q -e PATH=%q -e TERM=xterm-256color -v %q -v %q %q bash' \
    "$LABEL" "$ug" "$HOME_MNT/claude" "$HOME_MNT/codex" "$base_path" "$VOL_TOOLS:$TOOLS_MNT:ro" "$VOL_HOME:$HOME_MNT" "$SPIKE_LANE_DEFAULT_IMAGE")"
  line "    then: claude   (it should not ask you to sign in)   and   codex login status"
  line "(c) attach to a tmux session in the lane (detach with Ctrl-b d):"
  say "$(printf '      docker exec -it -u %q -w %q -e PATH=%q -e TERM=xterm-256color %q tmux -L %q new-session -A -s spike' \
    "$ru" "$WT" "$lp" "$LANE_NAME" "$TMUX_SOCK")"
  [ -n "$LANE_ID" ] || info "the lane container was not created, so (a) and (c) will not work in this run"
  finish MANUAL
}

# ---------------------------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------------------------
declare -a REMOVED=() LEFT=()

cleanup_all() { # cleanup_all full|prerun
  local full="$1" id name img
  REMOVED=() LEFT=()
  read_owner
  for id in $(docker ps -aq --filter "label=$LABEL" 2>/dev/null); do
    name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null)"; name="${name#/}"
    img="$(docker inspect -f '{{.Config.Image}}' "$id" 2>/dev/null)"
    [ -n "$img" ] && printf '%s\n' "$img" >>"$STATE/images-made" 2>/dev/null
    if run 60 docker rm -f "$id"; then REMOVED+=("container $name ($id)"); else LEFT+=("container $name ($id): docker rm failed"); fi
  done
  if docker network inspect "$NET" >/dev/null 2>&1; then
    if run 30 docker network rm "$NET"; then REMOVED+=("network $NET"); else LEFT+=("network $NET: rm failed"); fi
  fi
  if docker volume inspect "$VOL_TOOLS" >/dev/null 2>&1; then
    if run 30 docker volume rm "$VOL_TOOLS"; then REMOVED+=("volume $VOL_TOOLS"); else LEFT+=("volume $VOL_TOOLS: rm failed"); fi
  fi
  if [ "$full" = full ] && docker volume inspect "$VOL_HOME" >/dev/null 2>&1; then
    if run 30 docker volume rm "$VOL_HOME"; then REMOVED+=("volume $VOL_HOME (agent logins made in check 9)"); else LEFT+=("volume $VOL_HOME: rm failed"); fi
  fi

  # Worktree and branch, through a helper when the image exists, else host git.
  local -a G=()
  if image_exists; then
    GIT_MOUNTS=(--mount "type=bind,source=$P,target=$P")
    [ -d "$LANES" ] && GIT_MOUNTS+=(--mount "type=bind,source=$LANES,target=$LANES")
    SAFE=(-c 'safe.directory=*')
    G=(helper)
  elif command -v git >/dev/null 2>&1; then
    G=(host)
  fi
  gitc() { if [ "${G[0]}" = helper ]; then git_h "$@"; else local t="$1"; shift; run "$t" git "$@"; fi; }
  if [ "${#G[@]}" -eq 0 ]; then
    LEFT+=("worktree/branch: no tools image and no host git; run: git -C '$P' worktree remove --force '$WT' && git -C '$P' branch -D '$SPIKE_BRANCH'")
  elif [ -d "$P/.git" ]; then
    if gitc 60 -C "$P" worktree list --porcelain && grep -qxF "worktree $WT" "$OUT"; then
      if gitc 120 -C "$P" worktree remove --force "$WT"; then REMOVED+=("worktree $WT"); else LEFT+=("worktree $WT: remove failed (see log)"); fi
    elif [ -e "$WT" ]; then
      LEFT+=("$WT exists but is not a registered worktree of $P: left untouched")
    fi
    gitc 60 -C "$P" worktree prune && REMOVED+=("stale worktree records, if any (ran git worktree prune)")
    if gitc 30 -C "$P" rev-parse --verify --quiet "refs/heads/$SPIKE_BRANCH"; then
      if [ "$full" = full ] || [ -e "$STATE/branch-created" ]; then
        if gitc 30 -C "$P" branch -D "$SPIKE_BRANCH"; then REMOVED+=("branch $SPIKE_BRANCH"); rm -f "$STATE/branch-created"
        else LEFT+=("branch $SPIKE_BRANCH: delete failed"); fi
      else
        LEFT+=("branch $SPIKE_BRANCH: exists but this machine has no record of the spike making it; left (use --cleanup to delete it)")
      fi
    else
      rm -f "$STATE/branch-created"
    fi
  fi
  if [ -d "$LANES" ]; then
    if [ -z "$(ls -A "$LANES" 2>/dev/null)" ] && { [ "$full" = full ] || [ -e "$STATE/lanes-created" ]; }; then
      if rmdir "$LANES" 2>/dev/null; then REMOVED+=("empty folder $LANES"); rm -f "$STATE/lanes-created"
      else LEFT+=("$LANES: empty but rmdir failed; run: rmdir '$LANES'"); fi
    elif [ -n "$(ls -A "$LANES" 2>/dev/null)" ]; then
      LEFT+=("$LANES: not empty, left untouched")
    fi
  fi
  if [ "$full" = full ]; then
    if image_exists; then
      if [ "$KEEP_IMAGE" = 1 ]; then LEFT+=("image $IMG (--keep-image)")
      elif run 60 docker image rm "$IMG"; then REMOVED+=("image $IMG"); else LEFT+=("image $IMG: rm failed"); fi
    fi
    if [ -f "$STATE/images-made" ]; then
      while IFS= read -r img; do
        case "$img" in vsc-*|*-uid) docker image inspect "$img" >/dev/null 2>&1 && LEFT+=("image $img (built by the Dev Container CLI; not a cl-spike name, so not removed): docker image rm $img") ;; esac
      done < <(sort -u "$STATE/images-made")
    fi
    case "$STATE" in
      */cl-spike-[0-9]*) if [ -d "$STATE" ]; then rm -rf -- "$STATE" && REMOVED+=("temp folder $STATE"); fi ;;
    esac
  fi
  return 0
}

print_cleanup() {
  local r
  if [ "${#REMOVED[@]}" -eq 0 ]; then line "removed: nothing"; else for r in "${REMOVED[@]}"; do line "removed: $r"; done; fi
  for r in "${LEFT[@]}"; do line "left: $r"; done
  line "the project folder $P was not modified (only its .git worktree records and the $SPIKE_BRANCH branch)"
}

# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------
if ! { mkdir -p "$STATE" && chmod 0755 "$STATE"; }; then echo "cannot create $STATE" >&2; exit 1; fi

say "ContextLanes v4 spike ($MODE) $(date -Is)"
say "project: $P"
say "log: $LOG"

if [ "$MODE" = cleanup ]; then
  if ! docker version >/dev/null 2>&1; then say "docker not reachable"; exit 3; fi
  say ""
  say "[CLEANUP]"
  cleanup_all full
  print_cleanup
  exit 0
fi

check1
if passed 1; then
  say ""
  say "[PREPARE] removing leftovers of an earlier run (the agent-login volume is kept)"
  cleanup_all prerun
  print_cleanup
  mkdir -p "$STATE" && chmod 0755 "$STATE"
  check2
else
  skip_check 2 "Tools image ($IMG)" "check 1 did not pass"
fi
if passed 2; then check3; else skip_check 3 "Tools volume ($VOL_TOOLS)" "check 2 did not pass"; fi
if passed 2; then check4; else skip_check 4 "Helper container git" "check 2 did not pass (the helper uses the tools image)"; fi
if passed 3 && passed 4; then check5; else skip_check 5 "Dev Container CLI from a helper container" "checks 3 and 4 must pass"; fi
check6
check7
check8
check9

say ""
say "== Summary =="
say "$(printf '%-6s %-48s %6s  %s' CHECK TITLE TIME RESULT)"
for i in 1 2 3 4 5 6 7 8 9; do
  say "$(printf '%-6s %-48s %5ss  %s' "$i" "${C_TITLE[$i]:-}" "${C_TIME[$i]:-0}" "${C_RESULT[$i]:-not run}")"
done
if [ "${#FINDINGS[@]}" -gt 0 ]; then
  say ""
  say "Findings:"
  for f in "${FINDINGS[@]}"; do say "  - $f"; done
fi
say ""
say "Versions: tmux $SPIKE_TMUX_VERSION, devcontainers/cli $SPIKE_DEVCONTAINERS_CLI_VERSION, claude-code $SPIKE_CLAUDE_CODE_VERSION, codex $SPIKE_CODEX_VERSION, lane image $SPIKE_LANE_DEFAULT_IMAGE"
say "Clean up with: $0 --cleanup $(printf '%q' "$P")"
say "Paste the summary above and attach $LOG_NAME"
