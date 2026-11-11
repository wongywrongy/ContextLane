#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2016
# SC2015: ok and bad always succeed, so "test && ok || bad" is an if/else here.
# SC2016: the single-quoted $ and backticks are JavaScript for jsq, not shell.
# ContextLanes v4, phase 2 machine check (docs/V4.md section 7): the control service.
#
#   scripts/v4-check/phase2.sh <path-to-git-repo>             bring the stack up and check it
#   scripts/v4-check/phase2.sh --cleanup <path-to-git-repo>   remove what the check made
#   options: --volumes (cleanup also removes the contextlanes-tools volume), --allow-root, --help
#
# It touches only Docker objects named or labelled contextlanes: the stack's container, network and tools
# volume, and its own throwaway containers (label contextlanes.check=1). It installs nothing on the host:
# the host command is written to a temporary folder and removed. The repository is only read.
# A container, network, volume or port that is already there and is not this stack's stops the check
# with instructions; it is never removed.
# Full command output goes to ./v4-phase2-<timestamp>.log; the terminal shows a summary per check.
set -uo pipefail

readonly CONTAINER=contextlanes
readonly SERVICE=control
readonly COMPOSE_PROJECT=contextlanes
readonly NET=contextlanes
readonly VOL=contextlanes-tools
readonly IMAGE=contextlanes:local
readonly CHECK_LABEL=contextlanes.check=1
readonly HELPER_LABEL=contextlanes.helper=1
readonly TOOLS_VOLUME_PATH=/var/lib/contextlanes-tools
readonly TOOLS_IMAGE_PATH=/opt/contextlanes-tools
readonly ROUTER_PORT=4601
readonly API_PORT=4600

usage() {
  cat <<'EOF'
Usage:
  scripts/v4-check/phase2.sh <path-to-git-repo>             check the v4 control service against a repository
  scripts/v4-check/phase2.sh --cleanup <path-to-git-repo>   remove what the check made (keeps ./data)
Options:
  --volumes      with --cleanup: also remove the contextlanes-tools volume
  --allow-root   run even when invoked as root
  -h, --help     this text
EOF
}

MODE=run VOLUMES=0 ALLOW_ROOT=0 PROJECT_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cleanup) MODE=cleanup ;;
    --volumes) VOLUMES=1 ;;
    --allow-root) ALLOW_ROOT=1 ;;
    -h|--help) usage; exit 0 ;;
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
if [ ! -d "$PROJECT_ARG" ]; then printf 'Not a directory: %s\n' "$PROJECT_ARG" >&2; exit 2; fi
P="$(cd -- "$PROJECT_ARG" && pwd -P)" || { echo "cannot resolve the project path" >&2; exit 2; }
STACK="$(cd -- "$(dirname -- "$0")/../.." && pwd -P)" || exit 2
[ -f "$STACK/compose.yaml" ] || { printf 'No compose.yaml in %s\n' "$STACK" >&2; exit 2; }

TS="$(date +%Y%m%d-%H%M%S)"
if [ "$MODE" = cleanup ]; then LOG_NAME="v4-phase2-cleanup-$TS.log"; else LOG_NAME="v4-phase2-$TS.log"; fi
LOG="$PWD/$LOG_NAME"
: >"$LOG" || { printf 'cannot write the log file %s\n' "$LOG" >&2; exit 1; }
OUT="$(mktemp "${TMPDIR:-/tmp}/cl-phase2-out.XXXXXX")" || exit 1
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/cl-phase2.XXXXXX")" || exit 1
trap 'rm -rf "$OUT" "$TMPD"' EXIT
trap 'printf "\nInterrupted. Clean up with: %s --cleanup %q\n" "$0" "$P" | tee -a "$LOG"; exit 130' INT TERM

# ---------------------------------------------------------------------------------------------
# Output helpers (as in scripts/v4-spike/v4-spike.sh)
# ---------------------------------------------------------------------------------------------
say() { printf '%s\n' "$*" | tee -a "$LOG"; }
line() { say "    $*"; }
logonly() { printf '%s\n' "$*" >>"$LOG"; }
log_cmd() { { printf '\n$'; printf ' %q' "$@"; printf '\n'; } >>"$LOG"; }

# run SECONDS cmd...: output to the log and to $OUT; returns the command's exit status.
run() {
  local t="$1"; shift
  log_cmd "$@"
  # stdin is /dev/null: timeout puts the command in its own process group, where reading the terminal stops it.
  timeout -k 10 "$t" "$@" </dev/null 2>&1 | tee "$OUT" >>"$LOG"
  local rc="${PIPESTATUS[0]}"
  printf '[exit %s]\n' "$rc" >>"$LOG"
  [ "$rc" -eq 124 ] && line "timed out after ${t}s: $1 ${2:-}"
  return "$rc"
}
# run_split SECONDS STDOUT_FILE cmd...: stdout to a file (and the log), stderr to the log and $OUT.
run_split() {
  local t="$1" so="$2"; shift 2
  log_cmd "$@"
  { timeout -k 10 "$t" "$@" </dev/null >"$so"; } 2>&1 | tee "$OUT" >>"$LOG"
  local rc="${PIPESTATUS[0]}"
  { echo "--- stdout:"; cat "$so"; } >>"$LOG"
  printf '[exit %s]\n' "$rc" >>"$LOG"
  [ "$rc" -eq 124 ] && line "timed out after ${t}s: $1 ${2:-}"
  return "$rc"
}
show_tail() { tail -n 15 "$OUT" | sed 's/^/      | /'; }
out_first() { head -n 1 "$OUT" | tr -d '\r'; }

declare -a C_TITLE=() C_RESULT=() C_TIME=() C_FAILS=()
CUR=0 C_START=0
begin() { CUR="$1"; C_TITLE[$1]="$2"; C_FAILS=(); C_START=$SECONDS; say ""; say "[CHECK $1] $2"; }
ok() { line "ok: $*"; }
info() { line "info: $*"; }
bad() { C_FAILS+=("$*"); line "problem: $*"; }
finish() {
  local el=$((SECONDS - C_START)) res="" f
  if [ "${1:-}" = SKIP ]; then res="SKIP: $2"
  elif [ "${#C_FAILS[@]}" -gt 0 ]; then res="FAIL:"; for f in "${C_FAILS[@]}"; do res="$res $f;"; done; res="${res%;}"
  else res="PASS"; fi
  C_RESULT[CUR]="$res"; C_TIME[CUR]="$el"
  say "    $res (${el}s)"
}
skip_check() { begin "$1" "$2"; finish SKIP "$3"; }
passed() { [ "${C_RESULT[$1]:-}" = PASS ]; }

label_of() { docker inspect -f "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null; }
container_ours() { [ "$(label_of "$CONTAINER" com.docker.compose.project)" = "$COMPOSE_PROJECT" ] && [ "$(label_of "$CONTAINER" com.docker.compose.service)" = "$SERVICE" ]; }
# The command inside the control container is run as: docker exec -i -e CONTEXTLANES_CWD=<folder> contextlanes ...
# (written out at each call: `timeout` cannot run a shell function).
# Evaluates a JavaScript expression over the JSON on stdin (d), in the control container's Node.
# The expression is fixed text in this script; extra arguments arrive as a[0], a[1]...
# UNVERIFIED: with node -e, process.argv[1] is the first extra argument (from memory).
jsq() {
  local expr="$1"; shift
  docker exec -i "$CONTAINER" node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);const a=process.argv.slice(1);const r=($expr);process.stdout.write(typeof r==='string'?r:JSON.stringify(r));})" "$@"
}

OWNER_UG="" HOST_GIT=0
declare -a SNAP_GIT=()

# git as the folder's owner: on the host when that works, else in a read-only throwaway container.
snapshot() { # snapshot FILE
  local f="$1" q
  : >"$f"
  for q in "status --porcelain=v1 --branch --untracked-files=all" "rev-parse HEAD" "for-each-ref --format=%(refname):%(objectname)" "worktree list --porcelain" "stash list"; do
    # shellcheck disable=SC2086  # each query is a fixed list of words
    "${SNAP_GIT[@]}" --no-optional-locks -C "$P" $q >>"$f" 2>&1 || printf '[git %s failed]\n' "$q" >>"$f"
  done
  [ -e "$P.lanes" ] && printf '%s.lanes exists\n' "$P" >>"$f"
  return 0
}

# ---------------------------------------------------------------------------------------------
# CHECK 1: preflight
# ---------------------------------------------------------------------------------------------
check1() {
  begin 1 "Preflight"
  command -v docker >/dev/null 2>&1 || { bad "docker command not found"; finish; return; }
  if ! run 30 docker version --format 'client {{.Client.Version}}, server {{.Server.Version}}'; then
    bad "Docker is not reachable by this user (is it running, and is this user in the docker group?)"; show_tail; finish; return
  fi
  line "docker: $(out_first)"
  if run 15 docker compose version; then line "compose: $(out_first)"; else bad "docker compose is not installed"; fi
  line "stack folder: $STACK"
  line "project: $P"
  OWNER_UG="$(stat -c '%u:%g' "$P")"
  line "project owner uid:gid: $OWNER_UG"
  if [ -d "$P/.git" ]; then ok "the project has a .git folder"; else bad "$P is not the top folder of a git repository with a .git folder"; fi
  case "$P" in "$STACK"|"$STACK"/*) bad "the project is inside the stack folder; ContextLanes refuses that (its data folder would be visible). Use another repository" ;; esac
  case "$P" in *,*|*\"*) bad "the project path contains a comma or a double quote, which docker --mount cannot carry" ;; esac
  if command -v git >/dev/null 2>&1 && git --no-optional-locks -C "$P" rev-parse --git-dir >/dev/null 2>&1; then
    HOST_GIT=1; SNAP_GIT=(git); line "host git: $(git --version)"
  else
    info "host git is missing or refuses the folder: the before/after snapshot uses a read-only container as the owner"
  fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 2: nothing else holds the names or the port
# ---------------------------------------------------------------------------------------------
check2() {
  begin 2 "No clash with another container, network, volume or port"
  local stop=0
  if docker inspect --type container "$CONTAINER" >/dev/null 2>&1; then
    if container_ours; then
      ok "container $CONTAINER exists and is this stack's (compose project $COMPOSE_PROJECT, service $SERVICE)"
    else
      stop=1
      bad "a container named $CONTAINER exists and is not this stack's (project '$(label_of "$CONTAINER" com.docker.compose.project)', service '$(label_of "$CONTAINER" com.docker.compose.service)', image $(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null))"
      line "It is left as it is. Look at it:   docker inspect $CONTAINER"
      line "If it is the old stack from /opt/stacks/contextlanes and you no longer need it:   docker rm -f $CONTAINER"
      line "Or keep it under another name:   docker stop $CONTAINER && docker rename $CONTAINER contextlanes-old"
    fi
  else
    ok "no container named $CONTAINER yet"
  fi
  if docker network inspect "$NET" >/dev/null 2>&1; then
    local np nn
    np="$(docker network inspect -f '{{index .Labels "com.docker.compose.project"}}' "$NET" 2>/dev/null)"
    nn="$(docker network inspect -f '{{index .Labels "com.docker.compose.network"}}' "$NET" 2>/dev/null)"
    if [ "$np" = "$COMPOSE_PROJECT" ] && [ "$nn" = "$NET" ]; then ok "network $NET exists and is this stack's"
    else stop=1; bad "a network named $NET exists and is not this stack's (project '$np'). Left as it is; remove it yourself if unused: docker network rm $NET"; fi
  fi
  if docker volume inspect "$VOL" >/dev/null 2>&1; then
    local vp
    vp="$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' "$VOL" 2>/dev/null)"
    if [ "$vp" = "$COMPOSE_PROJECT" ]; then ok "volume $VOL exists and is this stack's"
    else stop=1; bad "a volume named $VOL exists and is not this stack's (project '$vp'). Left as it is; remove it yourself if unused: docker volume rm $VOL"; fi
  fi
  local other
  # UNVERIFIED: the publish= filter of docker ps, from memory; the 127.0.0.1 probe below catches a miss.
  other="$(docker ps --filter "publish=$ROUTER_PORT" --format '{{.Names}}' 2>/dev/null | grep -vx "$CONTAINER" || true)"
  if [ -n "$other" ]; then stop=1; bad "port $ROUTER_PORT is published by another container: $(echo "$other" | tr '\n' ' '). Stop it or change its port first"; fi
  if ! container_running_ours && timeout 3 bash -c 'exec 3<>"/dev/tcp/127.0.0.1/$1"' _ "$ROUTER_PORT" 2>/dev/null; then
    stop=1; bad "something on this machine already listens on 127.0.0.1:$ROUTER_PORT (find it: ss -ltnp 'sport = :$ROUTER_PORT'). Stop it first"
  fi
  [ "$stop" = 0 ] || line "Nothing was changed. Fix the above, then run this check again."
  finish
}
container_running_ours() { container_ours && [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ]; }

# ---------------------------------------------------------------------------------------------
# CHECK 3: bring the stack up
# ---------------------------------------------------------------------------------------------
check3() {
  begin 3 "docker compose up -d --build"
  line "building the image can take 5-15 minutes the first time. Follow it with: tail -f $LOG_NAME"
  if ! run 2400 docker compose --project-directory "$STACK" -f "$STACK/compose.yaml" up -d --build; then
    bad "docker compose up failed"; show_tail; finish; return
  fi
  local i status=""
  for i in $(seq 1 60); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null)"
    [ "$status" = healthy ] && break
    [ "$status" = unhealthy ] && break
    sleep 3
  done
  logonly "health polls: $i"
  if [ "$status" = healthy ]; then ok "container $CONTAINER is healthy"
  else
    bad "container $CONTAINER is '${status:-missing}', not healthy"
    run 30 docker logs --tail 40 "$CONTAINER"; show_tail
  fi
  container_ours || bad "the running $CONTAINER does not carry this stack's compose labels"
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 4: what the control container publishes and mounts
# ---------------------------------------------------------------------------------------------
check4() {
  begin 4 "Ports, mounts and privileges of the control container"
  if run 15 docker port "$CONTAINER"; then
    while IFS= read -r l; do [ -n "$l" ] && line "published: $l"; done <"$OUT"
    grep -q "^$ROUTER_PORT/tcp" "$OUT" && ok "the router ($ROUTER_PORT) is published" || bad "the router port $ROUTER_PORT is not published"
    grep -q "^$API_PORT/tcp" "$OUT" && bad "the API port $API_PORT is published" || ok "the API ($API_PORT) is not published"
  else bad "docker port failed"; show_tail; fi
  local data_src
  data_src="$(cd "$STACK" && pwd -P)/data"
  if run 15 docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Name}}|{{.Destination}}{{"\n"}}{{end}}' "$CONTAINER"; then
    local type src name dst
    while IFS='|' read -r type src name dst; do
      [ -n "$type" ] || continue
      line "mount: $type ${name:-$src} -> $dst"
      case "$type:$dst" in
        bind:/data) [ "$src" = "$data_src" ] || bad "/data comes from $src, expected $data_src" ;;
        bind:/var/run/docker.sock) ;;
        volume:"$TOOLS_VOLUME_PATH") [ "$name" = "$VOL" ] || bad "the tools mount is volume $name, expected $VOL" ;;
        *) bad "unexpected mount: $type ${name:-$src} -> $dst" ;;
      esac
      case "$P/" in "$src"/*) [ "$type" = bind ] && [ "$dst" != /var/run/docker.sock ] && bad "the control container can see the project through $src" ;; esac
    done <"$OUT"
    grep -qF "|$P|" "$OUT" && bad "the project folder is mounted into the control container"
    [ "${#C_FAILS[@]}" -eq 0 ] && ok "only ./data, the Docker socket and $VOL are mounted; not the repository"
  else bad "docker inspect failed"; show_tail; fi
  run 15 docker inspect -f '{{.HostConfig.Privileged}}|{{json .HostConfig.SecurityOpt}}|{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER"
  local priv secopt restart
  IFS='|' read -r priv secopt restart <"$OUT"
  [ "$priv" = false ] && ok "not privileged" || bad "the control container runs privileged"
  case "$secopt" in *unconfined*) bad "a security profile is turned off: $secopt" ;; *) ok "security options: $secopt" ;; esac
  [ "$restart" = unless-stopped ] && ok "restart: unless-stopped" || bad "restart policy is '$restart'"
  if run 15 docker inspect -f "{{with index .NetworkSettings.Networks \"$NET\"}}on{{end}}" "$CONTAINER" && [ "$(out_first)" = on ]; then ok "on the $NET network"
  else bad "not on the $NET network"; fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 5: the tools volume
# ---------------------------------------------------------------------------------------------
check5() {
  begin 5 "Tools volume ($VOL)"
  local have want
  have="$(docker exec "$CONTAINER" cat "$TOOLS_VOLUME_PATH/.version" 2>/dev/null)"
  want="$(docker exec "$CONTAINER" cat "$TOOLS_IMAGE_PATH/.version" 2>/dev/null)"
  line "image has: ${want:-nothing}"
  line "volume has: ${have:-nothing}"
  if [ -z "$want" ]; then bad "the image has no tools marker"
  elif [ "$have" = "$want" ]; then ok "the volume is filled at the image's versions"
  else bad "the volume is not filled at the image's versions"; fi
  local c
  for c in tmux node claude codex; do
    local a=--version; [ "$c" = tmux ] && a=-V
    if run 120 docker run --rm --label "$CHECK_LABEL" --network none -e TERM=xterm-256color -v "$VOL:/opt/contextlanes:ro" --entrypoint "/opt/contextlanes/bin/$c" "$IMAGE" "$a"; then
      ok "$c from the volume (read-only): $(out_first)"
    else bad "$c does not run from the volume"; show_tail; fi
  done
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 6: projects through docker exec, with the repository not mounted
# ---------------------------------------------------------------------------------------------
PROJECT_ID=""
check6() {
  begin 6 "add, projects, branches, doctor and the host command (repository not mounted)"
  if [ "$HOST_GIT" = 0 ]; then
    SNAP_GIT=(docker run --rm --label "$CHECK_LABEL" --network none --read-only --tmpfs /tmp --user "$OWNER_UG" -e HOME=/tmp
      --mount "type=bind,source=$P,target=$P,readonly" --entrypoint git "$IMAGE")
  fi
  snapshot "$TMPD/before"
  logonly "--- before:"; cat "$TMPD/before" >>"$LOG"
  local helpers_before
  helpers_before="$(docker ps -aq --filter "label=$HELPER_LABEL" | wc -l)"
  [ "$helpers_before" -eq 0 ] || info "$helpers_before helper containers existed before the check"

  if run_split 120 "$TMPD/add.json" docker exec -i -e "CONTEXTLANES_CWD=$P" "$CONTAINER" contextlanes add --json; then
    local path owner
    path="$(jsq 'd.path' <"$TMPD/add.json")"; owner="$(jsq '`${d.owner?.uid}:${d.owner?.gid}`' <"$TMPD/add.json")"
    PROJECT_ID="$(jsq 'd.id' <"$TMPD/add.json")"
    [ "$path" = "$P" ] && ok "add: project $PROJECT_ID at $path" || bad "add returned path '$path', expected $P"
    [ "$owner" = "$OWNER_UG" ] && ok "owner recorded as $owner (read by a helper stat)" || bad "owner recorded as $owner, expected $OWNER_UG"
  else bad "contextlanes add failed"; show_tail; finish; return; fi

  if run_split 60 "$TMPD/projects.json" docker exec -i -e "CONTEXTLANES_CWD=$P" "$CONTAINER" contextlanes projects --json && [ "$(jsq 'd.some(p => p.path === a[0]) ? "yes" : "no"' "$P" <"$TMPD/projects.json")" = yes ]; then
    ok "projects lists $P"
  else bad "projects does not list $P"; show_tail; fi

  # Branches: the API the menus and `new` use, called with the CLI's own credential inside the container.
  local want_n got
  want_n="$("${SNAP_GIT[@]}" -C "$P" for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null | wc -l)"
  if run_split 120 "$TMPD/branches.json" docker exec "$CONTAINER" node --input-type=module -e \
      "import { api } from '/opt/contextlanes/apps/cli/dist/index.js'; console.log(JSON.stringify(await api('/api/projects/' + process.argv[1] + '/branches')))" "$PROJECT_ID"; then
    got="$(jsq 'd.branches.length' <"$TMPD/branches.json")"
    line "branches: $got through helpers (default $(jsq 'd.defaultBranch' <"$TMPD/branches.json"), current $(jsq 'd.current' <"$TMPD/branches.json")); $want_n local on the host"
    [ "$got" -ge "$want_n" ] && [ "$got" -gt 0 ] && ok "branches listed" || bad "branches: got $got, expected at least $want_n"
  else bad "listing branches failed"; show_tail; fi

  if run_split 60 "$TMPD/new.out" docker exec -i -e "CONTEXTLANES_CWD=$P" "$CONTAINER" contextlanes new "phase 2 check" --json; then bad "contextlanes new succeeded; lanes should be refused until phase 3"
  elif grep -q not_yet "$OUT"; then ok "new is refused with not_yet (lanes are phase 3)"
  else bad "new failed without not_yet"; show_tail; fi

  if run_split 180 "$TMPD/doctor.json" docker exec -i -e "CONTEXTLANES_CWD=$P" "$CONTAINER" contextlanes doctor --json || [ -s "$TMPD/doctor.json" ]; then
    local id st
    for id in docker network tools api mounts helpers socket; do
      st="$(jsq '(d.checks.find(c => c.id === a[0]) || { state: "missing" }).state' "$id" <"$TMPD/doctor.json")"
      [ "$st" = ok ] && ok "doctor $id: $(jsq 'd.checks.find(c => c.id === a[0]).found' "$id" <"$TMPD/doctor.json")" || bad "doctor $id: $st"
    done
    local fails
    fails="$(jsq 'd.checks.filter(c => c.state !== "ok").map(c => `${c.id} ${c.state}: ${c.found}`).join("; ")' <"$TMPD/doctor.json")"
    [ -n "$fails" ] && info "doctor, not ok: $fails"
  else bad "doctor --json gave nothing"; show_tail; fi

  # The host command, written to a temporary folder (nothing is installed).
  if run 30 "$STACK/install-command" --to "$TMPD/bin"; then
    if (cd "$P" && run_split 60 "$TMPD/host-projects.json" "$TMPD/bin/contextlanes" projects --json) && [ "$(jsq 'd.some(p => p.path === a[0]) ? "yes" : "no"' "$P" <"$TMPD/host-projects.json")" = yes ]; then
      ok "the host command lists the project from inside the repository"
    else bad "the host command did not list the project"; show_tail; fi
    (cd "$P" && run 30 "$TMPD/bin/contextlanes" nosuchcommand --json); local rc=$?
    [ "$rc" -eq 2 ] && ok "the host command keeps exit codes (2 for wrong usage)" || bad "wrong usage exited $rc through the host command, expected 2"
    if (cd "$P" && run_split 60 "$TMPD/here.txt" "$TMPD/bin/contextlanes" add --json); then
      [ "$(jsq 'd.id' <"$TMPD/here.txt")" = "$PROJECT_ID" ] && ok "add from the host command uses the host's folder" || bad "add from the host command found another project"
    else bad "add through the host command failed"; show_tail; fi
  else bad "install-command --to failed"; show_tail; fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 7: helpers leave nothing, the folder is unchanged
# ---------------------------------------------------------------------------------------------
check7() {
  begin 7 "Nothing left behind, repository unchanged"
  sleep 2
  local left
  left="$(docker ps -a --filter "label=$HELPER_LABEL" --format '{{.Names}} {{.Status}}')"
  if [ -z "$left" ]; then ok "no helper containers left"; else bad "helper containers left: $(echo "$left" | tr '\n' ';')"; fi
  left="$(docker ps -a --filter "label=$CHECK_LABEL" --format '{{.Names}}')"
  [ -z "$left" ] || bad "check containers left: $(echo "$left" | tr '\n' ' ')"
  snapshot "$TMPD/after"
  logonly "--- after:"; cat "$TMPD/after" >>"$LOG"
  if cmp -s "$TMPD/before" "$TMPD/after"; then ok "git status, HEAD, refs, worktrees and stashes are the same as before"
  else bad "the repository changed:"; diff "$TMPD/before" "$TMPD/after" | head -n 20 | sed 's/^/      | /' | tee -a "$LOG"; fi
  finish
}

# ---------------------------------------------------------------------------------------------
# Cleanup: only what is this stack's or this check's
# ---------------------------------------------------------------------------------------------
cleanup() {
  say ""; say "[CLEANUP]"
  local id
  for id in $(docker ps -aq --filter "label=$CHECK_LABEL") $(docker ps -aq --filter "label=$HELPER_LABEL"); do
    run 30 docker rm -f "$id" && line "removed: container $id"
  done
  if container_running_ours; then
    local pid
    if run_split 30 "$TMPD/projects.json" docker exec -i -e "CONTEXTLANES_CWD=$P" "$CONTAINER" contextlanes projects --json; then
      pid="$(jsq '(d.find(p => p.path === a[0]) || {}).id || ""' "$P" <"$TMPD/projects.json")"
      if [ -n "$pid" ] && run 30 docker exec -i -e "CONTEXTLANES_CWD=$P" "$CONTAINER" contextlanes remove "$pid"; then line "removed: project $pid from ContextLanes (the folder is untouched)"; fi
    fi
  fi
  if docker inspect --type container "$CONTAINER" >/dev/null 2>&1; then
    if container_ours; then run 60 docker rm -f "$CONTAINER" && line "removed: container $CONTAINER"
    else line "left: container $CONTAINER is not this stack's"; fi
  fi
  if docker network inspect "$NET" >/dev/null 2>&1; then
    if [ "$(docker network inspect -f '{{index .Labels "com.docker.compose.project"}}' "$NET")" = "$COMPOSE_PROJECT" ]; then run 30 docker network rm "$NET" && line "removed: network $NET"
    else line "left: network $NET is not this stack's"; fi
  fi
  if docker volume inspect "$VOL" >/dev/null 2>&1; then
    if [ "$VOLUMES" = 1 ] && [ "$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' "$VOL")" = "$COMPOSE_PROJECT" ]; then run 30 docker volume rm "$VOL" && line "removed: volume $VOL"
    else line "left: volume $VOL (remove it with --volumes)"; fi
  fi
  line "left: $STACK/data (settings, database, sign-in token) and the image $IMAGE"
}

# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------
say "ContextLanes v4 phase 2 check ($MODE) $(date -Is)"
say "project: $P"
say "stack: $STACK"
say "log: $LOG"

if [ "$MODE" = cleanup ]; then
  docker version >/dev/null 2>&1 || { say "Docker is not reachable"; exit 3; }
  cleanup
  exit 0
fi

check1
if passed 1; then check2; else skip_check 2 "No clash" "check 1 did not pass"; fi
if passed 2; then check3; else skip_check 3 "docker compose up -d --build" "check 2 did not pass: nothing was started"; fi
if passed 3; then check4; check5; check6; check7
else
  skip_check 4 "Ports, mounts and privileges" "the stack is not up"
  skip_check 5 "Tools volume" "the stack is not up"
  skip_check 6 "Projects through docker exec" "the stack is not up"
  skip_check 7 "Nothing left behind" "the stack is not up"
fi

say ""
say "== Summary =="
say "$(printf '%-6s %-70s %6s  %s' CHECK TITLE TIME RESULT)"
fails=0
for i in 1 2 3 4 5 6 7; do
  say "$(printf '%-6s %-70s %5ss  %s' "$i" "${C_TITLE[$i]:-}" "${C_TIME[$i]:-0}" "${C_RESULT[$i]:-not run}")"
  passed "$i" || fails=$((fails + 1))
done
say ""
say "The stack is left running. Clean up with: $0 --cleanup $(printf '%q' "$P")"
say "Paste the summary above and attach $LOG_NAME"
[ "$fails" -eq 0 ]
