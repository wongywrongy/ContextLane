#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2016
# SC2015: ok and bad always succeed, so "test && ok || bad" is an if/else here.
# SC2016: the single-quoted $ and backticks are JavaScript for jsq or sh for the lane, not this shell.
# ContextLanes v4, phase 3 machine check (docs/V4.md section 7): lanes as containers.
#
#   scripts/v4-check/phase3.sh <path-to-git-repo>             check lanes against a repository
#   scripts/v4-check/phase3.sh --cleanup <path-to-git-repo>   remove what the check made
#   options: --no-other-uid (skip the second repository owned by another uid), --allow-root, --help
#
# It needs the phase 2 stack: when the control container is missing, stopped or older, it runs
# docker compose up -d --build in this checkout's folder. It touches only what it made: lanes whose task
# starts with "phase 3 check" (their containers, images and checkouts, through contextlanes delete), the
# project entry when it added it, a throwaway repository owned by another uid under $TMPDIR, the
# agent-login volume for that uid when it made it, and its own containers (label contextlanes.check=1).
# Nothing that was there before is removed. The repository's status, refs, worktrees and stashes are
# compared before and after.
# Full command output goes to ./v4-phase3-<timestamp>.log; the terminal shows a summary per check.
set -uo pipefail

readonly CONTAINER=contextlanes
readonly SERVICE=control
readonly COMPOSE_PROJECT=contextlanes
readonly NET=contextlanes
readonly IMAGE=contextlanes:local
readonly CHECK_LABEL=contextlanes.check=1
readonly HELPER_LABEL=contextlanes.helper=1
readonly LANE_LABEL=contextlanes.lane
readonly TASK="phase 3 check"
readonly OTHER_UID=23456
readonly TOOLS=/opt/contextlanes

usage() {
  cat <<'EOF'
Usage:
  scripts/v4-check/phase3.sh <path-to-git-repo>             check v4 lanes against a repository
  scripts/v4-check/phase3.sh --cleanup <path-to-git-repo>   remove the lanes and files the check made
Options:
  --no-other-uid   skip the check with a second repository owned by another uid
  --allow-root     run even when invoked as root
  -h, --help       this text
EOF
}

MODE=run OTHER=1 ALLOW_ROOT=0 PROJECT_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cleanup) MODE=cleanup ;;
    --no-other-uid) OTHER=0 ;;
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
# What the check made, kept between a run and its --cleanup (as the spike did).
STATE="${TMPDIR:-/tmp}/cl-phase3-$(id -u)"
OTHER_ROOT="$STATE/other-uid"
OTHER_REPO="$OTHER_ROOT/repo"

TS="$(date +%Y%m%d-%H%M%S)"
if [ "$MODE" = cleanup ]; then LOG_NAME="v4-phase3-cleanup-$TS.log"; else LOG_NAME="v4-phase3-$TS.log"; fi
LOG="$PWD/$LOG_NAME"
: >"$LOG" || { printf 'cannot write the log file %s\n' "$LOG" >&2; exit 1; }
OUT="$(mktemp "${TMPDIR:-/tmp}/cl-phase3-out.XXXXXX")" || exit 1
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/cl-phase3.XXXXXX")" || exit 1
trap 'rm -rf "$OUT" "$TMPD"' EXIT
trap 'printf "\nInterrupted. Clean up with: %s --cleanup %q\n" "$0" "$P" | tee -a "$LOG"; exit 130' INT TERM

# ---------------------------------------------------------------------------------------------
# Output helpers (as in phase2.sh)
# ---------------------------------------------------------------------------------------------
say() { printf '%s\n' "$*" | tee -a "$LOG"; }
line() { say "    $*"; }
logonly() { printf '%s\n' "$*" >>"$LOG"; }
log_cmd() { { printf '\n$'; printf ' %q' "$@"; printf '\n'; } >>"$LOG"; }

# run SECONDS cmd...: output to the log and to $OUT; returns the command's exit status.
# stdin is /dev/null: timeout puts the command in its own process group, where reading the terminal stops it.
# Only real commands go through timeout, never a shell function (phase 2 found both bugs).
run() {
  local t="$1"; shift
  log_cmd "$@"
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
  elif [ "${1:-}" = MANUAL ]; then res="MANUAL"
  elif [ "${#C_FAILS[@]}" -gt 0 ]; then res="FAIL:"; for f in "${C_FAILS[@]}"; do res="$res $f;"; done; res="${res%;}"
  else res="PASS"; fi
  C_RESULT[CUR]="$res"; C_TIME[CUR]="$el"
  say "    $res (${el}s)"
}
skip_check() { begin "$1" "$2"; finish SKIP "$3"; }
passed() { [ "${C_RESULT[$1]:-}" = PASS ]; }

label_of() { docker inspect -f "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null; }
container_ours() { [ "$(label_of "$CONTAINER" com.docker.compose.project)" = "$COMPOSE_PROJECT" ] && [ "$(label_of "$CONTAINER" com.docker.compose.service)" = "$SERVICE" ]; }
healthy() { [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null)" = healthy ]; }
wait_healthy() { local i; for i in $(seq 1 60); do healthy && return 0; sleep 3; done; return 1; }
# Evaluates a JavaScript expression over the JSON on stdin (d), in the control container's Node; a[0]… are extra arguments.
jsq() {
  local expr="$1"; shift
  docker exec -i "$CONTAINER" node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s||'null');const a=process.argv.slice(1);const r=($expr);process.stdout.write(typeof r==='string'?r:JSON.stringify(r));})" "$@"
}
# The command in the control container, as the host command runs it (written out at each call).
#   docker exec -i -e CONTEXTLANES_CWD=<folder> contextlanes contextlanes ...

declare -a SNAP_GIT=()
snapshot() { # snapshot FILE: what must be the same after the check
  local f="$1" q
  : >"$f"
  for q in "status --porcelain=v1 --branch --untracked-files=all" "rev-parse HEAD" "for-each-ref --format=%(refname):%(objectname)" "worktree list --porcelain" "stash list"; do
    # shellcheck disable=SC2086  # each query is a fixed list of words
    "${SNAP_GIT[@]}" --no-optional-locks -C "$P" $q >>"$f" 2>&1 || printf '[git %s failed]\n' "$q" >>"$f"
  done
  return 0
}

OWNER_UG="" PROJECT_ID="" LANE_ID="" LANE_NAME="" WT="" BRANCH="" LANE_IMAGE="" LANE_STARTED=""
declare -a LX=()   # docker exec into the lane as its user, in the checkout, with the tools on PATH

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
  line "stack folder: $STACK"
  line "project: $P"
  OWNER_UG="$(stat -c '%u:%g' "$P")"
  line "project owner uid:gid: $OWNER_UG"
  [ -d "$P/.git" ] && ok "the project has a .git folder" || bad "$P is not the top folder of a git repository with a .git folder"
  case "$P" in "$STACK"|"$STACK"/*) bad "the project is inside the stack folder; ContextLanes refuses that. Use another repository" ;; esac
  case "$P" in *,*|*\"*) bad "the project path contains a comma or a double quote, which docker --mount cannot carry" ;; esac
  if git --no-optional-locks -C "$P" rev-parse --verify --quiet HEAD >/dev/null 2>&1; then SNAP_GIT=(git); ok "host git reads the repository: $(git --version)"
  else bad "host git cannot read $P (or it has no commits); this check compares the repository with host git"; fi
  if [ -e "$P.lanes" ]; then info "$P.lanes exists already ($(find "$P.lanes" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l) entries); the check adds one checkout there and removes it"
  else info "$P.lanes does not exist; the first lane makes it"; fi
  mkdir -p "$STATE" && chmod 0700 "$STATE" || bad "cannot create $STATE"
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 2: the phase 2 stack, up and healthy, at this checkout's version
# ---------------------------------------------------------------------------------------------
check2() {
  begin 2 "The control service is up, healthy and has the lane tools"
  if docker inspect --type container "$CONTAINER" >/dev/null 2>&1 && ! container_ours; then
    bad "a container named $CONTAINER exists and is not this stack's; run scripts/v4-check/phase2.sh first, which says what to do"; finish; return
  fi
  line "docker compose up -d --build (rebuilds only what changed; the first build takes 5-15 minutes). Follow it: tail -f $LOG_NAME"
  if ! run 2400 docker compose --project-directory "$STACK" -f "$STACK/compose.yaml" up -d --build; then bad "docker compose up failed"; show_tail; finish; return; fi
  if wait_healthy; then ok "$CONTAINER is healthy"; else bad "$CONTAINER is not healthy"; run 30 docker logs --tail 40 "$CONTAINER"; show_tail; finish; return; fi
  local have want
  have="$(docker exec "$CONTAINER" cat /var/lib/contextlanes-tools/.version 2>/dev/null)"
  want="$(docker exec "$CONTAINER" cat /opt/contextlanes-tools/.version 2>/dev/null)"
  line "tools: $have"
  [ -n "$want" ] && [ "$have" = "$want" ] && ok "the tools volume is at the image's version" || bad "the tools volume holds '$have', the image has '$want'"
  case "$have" in *cli=*layout=2*) ok "the volume has the contextlanes command (layout=2)" ;; *) bad "the tools volume has no contextlanes command (layout is not 2)" ;; esac
  # The lane tools on a glibc image with none of them: the default lane image is pulled here if needed.
  local img
  img="$(docker exec -i "$CONTAINER" node -e "import('/opt/contextlanes/apps/daemon/dist/config.js').then(m=>process.stdout.write(m.loadConfig().lanes.image))" 2>/dev/null)"
  img="${img:-mcr.microsoft.com/devcontainers/base:bookworm}"
  line "default lane image: $img"
  if run 600 docker run --rm --label "$CHECK_LABEL" --network none -v contextlanes-tools:/opt/contextlanes:ro --entrypoint /opt/contextlanes/bin/contextlanes "$img" help --json; then
    grep -q '"help"' "$OUT" && ok "contextlanes runs from the read-only volume in $img" || bad "contextlanes from the volume printed no help"
  else bad "contextlanes does not run from the volume in $img"; show_tail; fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 3: a lane with no agent: checkout and container
# ---------------------------------------------------------------------------------------------
check3() {
  begin 3 "contextlanes new --no-agent: worktree and container"
  snapshot "$TMPD/before"; logonly "--- before:"; cat "$TMPD/before" >>"$LOG"
  [ -e "$P.lanes" ] || : >"$STATE/lanes-folder-made"
  if ! run_split 60 "$TMPD/projects.json" docker exec -i -e "CONTEXTLANES_CWD=$P" "$CONTAINER" contextlanes projects --json; then bad "contextlanes projects failed"; show_tail; finish; return; fi
  if [ "$(jsq 'd.some(p => p.path === a[0]) ? "yes" : "no"' "$P" <"$TMPD/projects.json")" = no ]; then
    run_split 120 "$TMPD/add.json" docker exec -i -e "CONTEXTLANES_CWD=$P" "$CONTAINER" contextlanes add --json || { bad "contextlanes add failed"; show_tail; finish; return; }
    : >"$STATE/project-added"
  else
    run_split 30 "$TMPD/add.json" docker exec -i -e "CONTEXTLANES_CWD=$P" "$CONTAINER" contextlanes add --json
  fi
  PROJECT_ID="$(jsq 'd.id' <"$TMPD/add.json")"
  line "project: $PROJECT_ID"
  line "creating the lane (pulling or building the lane image can take minutes)"
  if ! run_split 1800 "$TMPD/new.json" docker exec -i -e "CONTEXTLANES_CWD=$P" "$CONTAINER" contextlanes new --no-agent "$TASK" --json; then
    bad "contextlanes new failed"; show_tail
    if [ -s "$TMPD/new.json" ]; then
      local failed_id; failed_id="$(jsq 'd.id' <"$TMPD/new.json")"
      printf '%s\n' "$failed_id" >>"$STATE/lanes"
      line "lane: $(jsq '`${d.id} ${d.state}`' <"$TMPD/new.json")"
      # What the lane recorded: the step that failed and why.
      run_split 30 "$TMPD/ev.json" docker exec "$CONTAINER" node --input-type=module -e \
        "import { api } from '/opt/contextlanes/apps/cli/dist/index.js'; const e = await api('/api/lanes/' + process.argv[1] + '/events'); const list = Array.isArray(e) ? e : e.events ?? []; for (const x of list.filter((x) => x.type === 'lane.state' || x.type === 'lane.container').slice(-3)) console.log(JSON.stringify(x.payload).slice(0, 600))" "$failed_id"
      while IFS= read -r l; do line "recorded: $l"; done <"$TMPD/ev.json"
    fi
    finish; return
  fi
  LANE_ID="$(jsq 'd.id' <"$TMPD/new.json")"; LANE_NAME="$(jsq 'd.terminal' <"$TMPD/new.json")"; WT="$(jsq 'd.worktree' <"$TMPD/new.json")"; BRANCH="$(jsq 'd.branch' <"$TMPD/new.json")"
  printf '%s\n' "$LANE_ID" >>"$STATE/lanes"
  line "lane $LANE_ID: container $LANE_NAME, checkout $WT, branch $BRANCH, state $(jsq 'd.state' <"$TMPD/new.json")"
  [ "$(jsq 'd.state' <"$TMPD/new.json")" = working ] && ok "the lane is working" || bad "the lane is $(jsq 'd.state' <"$TMPD/new.json")"
  case "$WT" in "$P.lanes/"*) ok "the checkout is beside the project, in $P.lanes" ;; *) bad "the checkout $WT is not in $P.lanes" ;; esac
  [ -f "$WT/.git" ] && ok "on the host: $WT exists; .git says '$(head -n 1 "$WT/.git")'" || bad "the checkout is not on the host"
  [ "$(stat -c %u:%g "$WT" 2>/dev/null)" = "$OWNER_UG" ] && ok "the checkout belongs to $OWNER_UG" || bad "the checkout belongs to $(stat -c %u:%g "$WT" 2>/dev/null)"
  git -C "$WT" status --short --branch >/dev/null 2>&1 && ok "host git status works in the checkout" || bad "host git status fails in the checkout"
  git -C "$P" rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null && ok "branch $BRANCH is in the project's own repository" || bad "branch $BRANCH is not in the repository"
  if run 15 docker inspect -f "{{.State.Running}} {{index .Config.Labels \"$LANE_LABEL\"}} {{index .Config.Labels \"contextlanes.project\"}} {{.Config.Image}} {{.State.StartedAt}}" "$LANE_NAME"; then
    local running lab plab
    read -r running lab plab LANE_IMAGE LANE_STARTED <"$OUT"
    [ "$running" = true ] && ok "container $LANE_NAME is running" || bad "container $LANE_NAME is not running"
    [ "$lab" = "$LANE_ID" ] && [ "$plab" = "$PROJECT_ID" ] && ok "labelled $LANE_LABEL=$lab, contextlanes.project=$plab" || bad "labels are '$lab' '$plab'"
    line "lane image: $LANE_IMAGE"
  else bad "no container named $LANE_NAME"; show_tail; finish; return; fi
  # How a person attaches: the argv the CLI execs.
  if run_split 30 "$TMPD/open.json" docker exec -i -e "CONTEXTLANES_CWD=$P" "$CONTAINER" contextlanes open "$LANE_ID" --json; then
    local user lpath
    user="$(jsq 'd.attach[d.attach.indexOf("-u") + 1]' <"$TMPD/open.json")"
    lpath="$(jsq 'd.attach.find(x => x.startsWith("PATH=")).slice(5)' <"$TMPD/open.json")"
    line "attach: $(jsq 'd.attach.join(" ")' <"$TMPD/open.json")"
    LX=(docker exec -u "$user" -w "$WT" -e "PATH=$lpath" -e TERM=xterm-256color -e "CONTEXTLANES_LANE=$LANE_ID" -e CONTEXTLANES_URL=http://contextlanes:4600 "$LANE_NAME")
    case "$(jsq 'd.attach.join(" ")' <"$TMPD/open.json")" in *"-i -t"*"tmux -L contextlanes attach-session -t =$LANE_NAME") ok "open gives docker exec -it into the lane's tmux" ;; *) bad "open --json gave an unexpected command" ;; esac
  else bad "contextlanes open --json failed"; show_tail; fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 4: what the lane container can see
# ---------------------------------------------------------------------------------------------
check4() {
  begin 4 "The lane has no socket, no ./data, nothing published"
  local data_src
  data_src="$STACK/data"
  if run 15 docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Name}}|{{.Destination}}|{{.RW}}{{"\n"}}{{end}}' "$LANE_NAME"; then
    local type src name dst rw
    while IFS='|' read -r type src name dst rw; do
      [ -n "$type" ] || continue
      line "mount: $type ${name:-$src} -> $dst (rw=$rw)"
      case "$src$dst" in *docker.sock*) bad "the Docker socket is mounted into the lane" ;; esac
      case "$src/" in "$data_src"/*) bad "ContextLanes' data folder is mounted into the lane" ;; esac
    done <"$OUT"
    grep -qF "|contextlanes-tools|$TOOLS|false" "$OUT" && ok "tools read-only at $TOOLS" || bad "the tools volume is not read-only at $TOOLS"
    grep -qF "bind|$WT||$WT|true" "$OUT" && ok "the checkout at its host path" || bad "the checkout is not mounted at $WT"
    grep -qF "bind|$P/.git||$P/.git|true" "$OUT" && ok "the project's .git at its host path" || bad "the project's .git is not mounted at $P/.git"
    grep -q "|contextlanes-agent-home-[0-9]*|/opt/contextlanes-home|true" "$OUT" && ok "the agent logins volume at /opt/contextlanes-home" || bad "no agent-login volume"
  else bad "docker inspect failed"; show_tail; fi
  run 15 docker inspect -f '{{.HostConfig.Privileged}}|{{json .HostConfig.SecurityOpt}}' "$LANE_NAME"
  case "$(out_first)" in false\|*unconfined*) bad "a security profile is off: $(out_first)" ;; false\|*) ok "not privileged; security options $(out_first | cut -d'|' -f2)" ;; *) bad "the lane is privileged" ;; esac
  run 15 docker port "$LANE_NAME"
  [ -s "$OUT" ] && bad "the lane publishes ports: $(tr '\n' ' ' <"$OUT")" || ok "no ports published"
  if run 15 docker inspect -f "{{with index .NetworkSettings.Networks \"$NET\"}}{{.Aliases}}{{end}}" "$LANE_NAME" && grep -q "$LANE_NAME" "$OUT"; then ok "on $NET as $LANE_NAME"
  else bad "not on the $NET network under its name"; fi
  if run 15 "${LX[@]}" sh -c 'if [ -e /var/run/docker.sock ] || [ -e /run/docker.sock ]; then echo present; else echo absent; fi'; then
    [ "$(out_first)" = absent ] && ok "no Docker socket inside the lane" || bad "a Docker socket exists inside the lane"
  else bad "docker exec into the lane failed"; show_tail; fi
  run 15 "${LX[@]}" sh -c 'touch "$1/.cl-w" 2>/dev/null && echo writable || echo read-only' sh "$TOOLS"
  [ "$(out_first)" = read-only ] && ok "the tools are read-only inside" || bad "the tools are writable inside the lane"
  # The lane reaches the control service by name, and nothing else of the stack.
  if run 30 "${LX[@]}" node -e "fetch('http://contextlanes:4600/api/health').then(r=>r.json()).then(j=>console.log(j.ok?'ok':'no'),e=>{console.log('error '+e.message);process.exit(1)})"; then
    [ "$(out_first)" = ok ] && ok "the lane reaches http://contextlanes:4600" || bad "health from the lane: $(out_first)"
  else bad "the lane cannot reach http://contextlanes:4600"; show_tail; fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 5: files written in the lane belong to the folder's owner
# ---------------------------------------------------------------------------------------------
check5() {
  begin 5 "Files written in the lane belong to the folder's owner"
  local f="$WT/.cl-phase3-owner" o
  if run 15 "${LX[@]}" sh -c 'id; echo x > "$1"' sh "$f"; then
    line "lane user: $(out_first)"
    o="$(stat -c %u:%g "$f" 2>/dev/null || echo missing)"
    [ "$o" = "$OWNER_UG" ] && ok "$f belongs to $o on the host" || bad "$f belongs to $o, expected $OWNER_UG"
    run 15 "${LX[@]}" rm -f "$f"
  else bad "cannot write in the checkout from the lane"; show_tail; fi
  [ "${OWNER_UG%%:*}" = 1000 ] && info "the owner is uid 1000, as the image's own user; check 6 repeats this with uid $OTHER_UID"
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 6: the same with a repository owned by another uid
# ---------------------------------------------------------------------------------------------
check6() {
  begin 6 "A repository owned by uid $OTHER_UID"
  [ "$OTHER" = 1 ] || { finish SKIP "--no-other-uid"; return; }
  if [ -e "$OTHER_ROOT" ]; then finish SKIP "$OTHER_ROOT is left from an earlier run; run --cleanup first"; return; fi
  [ "${OWNER_UG%%:*}" = "$OTHER_UID" ] && { finish SKIP "the project's owner is uid $OTHER_UID already"; return; }
  local vol="contextlanes-agent-home-$OTHER_UID"
  docker volume inspect "$vol" >/dev/null 2>&1 && info "$vol exists already (kept)" || : >"$STATE/agent-home-made"
  mkdir -p "$OTHER_ROOT" && chmod 0755 "$OTHER_ROOT" || { finish SKIP "cannot create $OTHER_ROOT"; return; }
  # A throwaway repository, made and handed to the other uid by a root container: nothing on the host needs root.
  if ! run 120 docker run --rm --label "$CHECK_LABEL" --network none --user 0:0 --mount "type=bind,source=$OTHER_ROOT,target=$OTHER_ROOT" --entrypoint sh "$IMAGE" -c \
      'git init -q -b main "$1" && git -C "$1" -c user.email=check@contextlanes -c user.name=check commit -q --allow-empty -m init && chown -R "$2" "$1"' sh "$OTHER_REPO" "$OTHER_UID:$OTHER_UID"; then
    finish SKIP "could not make a repository for uid $OTHER_UID in a helper (see the log)"; return
  fi
  ok "made $OTHER_REPO owned by $(stat -c %u:%g "$OTHER_REPO")"
  run_split 120 "$TMPD/oadd.json" docker exec -i -e "CONTEXTLANES_CWD=$OTHER_REPO" "$CONTAINER" contextlanes add --json || { bad "add failed"; show_tail; finish; return; }
  local opid owner
  opid="$(jsq 'd.id' <"$TMPD/oadd.json")"; owner="$(jsq '`${d.owner?.uid}:${d.owner?.gid}`' <"$TMPD/oadd.json")"
  printf '%s\n' "$opid" >"$STATE/other-project"
  [ "$owner" = "$OTHER_UID:$OTHER_UID" ] && ok "project $opid, owner $owner" || bad "owner recorded as $owner"
  if ! run_split 1800 "$TMPD/onew.json" docker exec -i -e "CONTEXTLANES_CWD=$OTHER_REPO" "$CONTAINER" contextlanes new --no-agent "$TASK other uid" --json; then
    bad "contextlanes new failed for uid $OTHER_UID"; show_tail; finish; return
  fi
  local oid oname owt
  oid="$(jsq 'd.id' <"$TMPD/onew.json")"; oname="$(jsq 'd.terminal' <"$TMPD/onew.json")"; owt="$(jsq 'd.worktree' <"$TMPD/onew.json")"
  printf '%s\n' "$oid" >>"$STATE/lanes"
  [ "$(jsq 'd.state' <"$TMPD/onew.json")" = working ] && ok "lane $oid is working" || bad "lane $oid is $(jsq 'd.state' <"$TMPD/onew.json")"
  if run_split 30 "$TMPD/oopen.json" docker exec -i "$CONTAINER" contextlanes open "$oid" --json; then
    local ouser
    ouser="$(jsq 'd.attach[d.attach.indexOf("-u") + 1]' <"$TMPD/oopen.json")"
    if run 15 docker exec -u "$ouser" -w "$owt" "$oname" sh -c 'id -u; echo x > "$1"' sh "$owt/.cl-phase3-owner"; then
      line "lane user uid: $(out_first)"
      local o; o="$(stat -c %u:%g "$owt/.cl-phase3-owner" 2>/dev/null || echo missing)"
      [ "$o" = "$OTHER_UID:$OTHER_UID" ] && ok "a file written in that lane belongs to $o on the host" || bad "the file belongs to $o, expected $OTHER_UID:$OTHER_UID"
    else bad "cannot write in that lane's checkout"; show_tail; fi
  else bad "open --json failed"; show_tail; fi
  run 15 docker inspect -f '{{range .Mounts}}{{.Name}} {{end}}' "$oname"
  grep -q "$vol" "$OUT" && ok "that lane has its own agent-login volume $vol" || bad "that lane does not use $vol"
  if run_split 300 "$TMPD/odel.json" docker exec -i "$CONTAINER" contextlanes delete "$oid" --force --delete-branch --json; then ok "deleted $oid"; else bad "deleting $oid failed"; show_tail; fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 7: tmux in the lane, keys sent to it run
# ---------------------------------------------------------------------------------------------
check7() {
  begin 7 "tmux runs in the lane and keys sent to it run"
  if run 15 "${LX[@]}" tmux -L contextlanes has-session -t "=$LANE_NAME"; then ok "tmux session $LANE_NAME exists in the lane"
  else bad "no tmux session $LANE_NAME in the lane"; show_tail; finish; return; fi
  run 15 "${LX[@]}" tmux -L contextlanes show-options -t "=$LANE_NAME:" mouse
  grep -q "mouse on" "$OUT" && ok "mouse is on (the wheel scrolls output)" || bad "mouse is not on: $(out_first)"
  run 15 "${LX[@]}" tmux -L contextlanes send-keys -t "=$LANE_NAME:" 'echo cl-phase3 > .cl-phase3-tmux' Enter
  local i got=0
  for i in $(seq 1 10); do [ -f "$WT/.cl-phase3-tmux" ] && { got=1; break; }; sleep 1; done
  [ "$got" = 1 ] && ok "keys sent to tmux ran in the checkout (seen on the host)" || bad "the keys sent did not write the marker"
  rm -f "$WT/.cl-phase3-tmux" 2>/dev/null || run 15 "${LX[@]}" rm -f .cl-phase3-tmux
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 8: the contextlanes command inside the lane
# ---------------------------------------------------------------------------------------------
check8() {
  begin 8 "contextlanes inside the lane, with the lane's token"
  run 15 "${LX[@]}" sh -c 'test -s /var/lib/contextlanes-lane/token && echo present || echo absent'
  [ "$(out_first)" = present ] && ok "the lane's token is in /var/lib/contextlanes-lane/token" || bad "no token file in the lane"
  if run_split 30 "$TMPD/lstatus.json" "${LX[@]}" contextlanes status --json; then
    [ "$(jsq 'd.ok && d.runtime === "docker" ? "yes" : "no"' <"$TMPD/lstatus.json")" = yes ] && ok "contextlanes status --json answers from the lane (runtime docker)" || bad "status from the lane: $(cat "$TMPD/lstatus.json")"
  else bad "contextlanes status --json failed in the lane"; show_tail; fi
  # The token is accepted: a lane tool route answers with its own reason, not 401.
  run_split 30 "$TMPD/lapp.json" "${LX[@]}" contextlanes app status --json
  if grep -q '"code":"not_yet"' "$OUT"; then ok "the lane's token is accepted (app status says not_yet: apps are phase 4)"
  elif grep -q unauthorized "$OUT"; then bad "the lane's token was refused (401)"
  else info "app status in the lane: $(out_first)"; fi
  run_split 30 "$TMPD/ldel.json" "${LX[@]}" contextlanes delete "$LANE_ID" --json; local rc=$?
  [ "$rc" -eq 4 ] && grep -q owner_only "$OUT" && ok "an owner-only command in the lane exits 4 (owner_only)" || bad "delete from inside the lane exited $rc"
  run_split 30 "$TMPD/lopen.json" "${LX[@]}" contextlanes open "$LANE_ID" --json; rc=$?
  [ "$rc" -eq 2 ] && ok "open inside the lane is refused (exit 2)" || bad "open inside the lane exited $rc"
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 9: the control container restarts and is replaced; the lane keeps running and is found
# ---------------------------------------------------------------------------------------------
check9() {
  begin 9 "Restart and replace the control container; the lane keeps running"
  run 120 docker restart "$CONTAINER" || { bad "docker restart failed"; show_tail; finish; return; }
  wait_healthy && ok "restarted and healthy" || { bad "not healthy after restart"; finish; return; }
  line "replacing it as an update does: docker compose up -d --force-recreate --no-build $SERVICE"
  run 300 docker compose --project-directory "$STACK" -f "$STACK/compose.yaml" up -d --force-recreate --no-build "$SERVICE" || { bad "compose up --force-recreate failed"; show_tail; finish; return; }
  wait_healthy && ok "replaced and healthy" || { bad "not healthy after it was replaced"; finish; return; }
  local now
  now="$(docker inspect -f '{{.State.Running}} {{.State.StartedAt}}' "$LANE_NAME" 2>/dev/null)"
  [ "$now" = "true $LANE_STARTED" ] && ok "the lane container kept running (started at $LANE_STARTED)" || bad "the lane container changed: '$now', was 'true $LANE_STARTED'"
  if run_split 30 "$TMPD/list.json" docker exec -i -e "CONTEXTLANES_CWD=$P" "$CONTAINER" contextlanes list --json; then
    [ "$(jsq '(d.find(l => l.id === a[0]) || {}).state || "missing"' "$LANE_ID" <"$TMPD/list.json")" = working ] && ok "$LANE_ID is still working" || bad "$LANE_ID is $(jsq '(d.find(l => l.id === a[0]) || {}).state || "missing"' "$LANE_ID" <"$TMPD/list.json")"
  else bad "contextlanes list failed"; show_tail; fi
  run 15 "${LX[@]}" tmux -L contextlanes has-session -t "=$LANE_NAME" && ok "its tmux session is still there" || bad "its tmux session is gone"
  if run_split 180 "$TMPD/doctor.json" docker exec -i -e "CONTEXTLANES_CWD=$P" "$CONTAINER" contextlanes doctor --json || [ -s "$TMPD/doctor.json" ]; then
    local id st
    for id in lanes agent-logins lane-image; do
      st="$(jsq '(d.checks.find(c => c.id === a[0]) || { state: "missing" }).state' "$id" <"$TMPD/doctor.json")"
      line "doctor $id: $st, $(jsq '(d.checks.find(c => c.id === a[0]) || {}).found || ""' "$id" <"$TMPD/doctor.json")"
    done
    [ "$(jsq '(d.checks.find(c => c.id === "lanes") || {}).state' <"$TMPD/doctor.json")" = ok ] && ok "doctor finds the lane and its container" || bad "doctor lanes is not ok"
  else bad "doctor --json gave nothing"; show_tail; fi
  docker logs "$CONTAINER" >>"$LOG" 2>&1
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 10: delete removes container, image and checkout; the repository is as it was
# ---------------------------------------------------------------------------------------------
check10() {
  begin 10 "contextlanes delete, and the repository is as it was"
  if ! run_split 300 "$TMPD/del.json" docker exec -i -e "CONTEXTLANES_CWD=$P" "$CONTAINER" contextlanes delete "$LANE_ID" --force --delete-branch --json; then
    bad "contextlanes delete failed"; show_tail; finish; return
  fi
  [ "$(jsq 'd.state' <"$TMPD/del.json")" = archived ] && ok "the lane is deleted (archived in the history)" || bad "the lane is $(jsq 'd.state' <"$TMPD/del.json")"
  docker inspect --type container "$LANE_NAME" >/dev/null 2>&1 && bad "container $LANE_NAME is still there" || ok "container $LANE_NAME is gone"
  case "$LANE_IMAGE" in
    vsc-*) docker image inspect "$LANE_IMAGE" >/dev/null 2>&1 && bad "image $LANE_IMAGE is still there" || ok "image $LANE_IMAGE is gone" ;;
    *) info "the lane ran the image $LANE_IMAGE directly; it is shared and kept" ;;
  esac
  [ -e "$WT" ] && bad "$WT is still on the host" || ok "the checkout $WT is gone"
  git -C "$P" rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null && bad "branch $BRANCH is still there" || ok "branch $BRANCH is deleted (it was the lane's own, and --delete-branch asked)"
  sleep 2
  local left
  left="$(docker ps -a --filter "label=$HELPER_LABEL" --format '{{.Names}} {{.Status}}')"
  [ -z "$left" ] && ok "no helper containers left" || bad "helper containers left: $(echo "$left" | tr '\n' ';')"
  snapshot "$TMPD/after"; logonly "--- after:"; cat "$TMPD/after" >>"$LOG"
  if cmp -s "$TMPD/before" "$TMPD/after"; then ok "git status, HEAD, refs, worktrees and stashes are the same as before"
  else bad "the repository changed:"; diff "$TMPD/before" "$TMPD/after" | head -n 20 | sed 's/^/      | /' | tee -a "$LOG"; fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 11: agents (manual)
# ---------------------------------------------------------------------------------------------
check11() {
  begin 11 "Agent sign-in and a permission answered (manual)"
  local q; q="$(printf '%q' "$P")"
  line "Not automated. In a terminal on this machine, with the host command installed (./install-command):"
  line "(a) a Claude Code lane, signed in once:"
  say "      cd $q && contextlanes new \"$TASK agent: list the files here, then create hello.txt\""
  say "      contextlanes open <lane>        (in Claude Code: /login, finish it; detach with Ctrl-b d)"
  line "(b) the permission request reaches you:"
  say "      contextlanes inbox"
  say "      contextlanes answer <id> <option>     (the id and option from inbox)"
  say "      contextlanes send <lane> \"thanks, now delete hello.txt\""
  say "      contextlanes resume <lane>"
  line "(c) a second lane is already signed in (the open question of docs/V4.md 8b):"
  say "      contextlanes new \"$TASK second agent: say hello\" && contextlanes open <second lane>"
  line "(d) Codex the same way: contextlanes codex   (inside: codex login --device-auth if asked)"
  line "(e) clean up:  contextlanes delete <lane> --force --delete-branch   for each, or: $0 --cleanup $q"
  line "Paste what you saw, especially whether (c) asked you to sign in again."
  finish MANUAL
}

# ---------------------------------------------------------------------------------------------
# Cleanup: only what this check made
# ---------------------------------------------------------------------------------------------
cleanup() {
  say ""; say "[CLEANUP]"
  local id
  for id in $(docker ps -aq --filter "label=$CHECK_LABEL"); do run 30 docker rm -f "$id" && line "removed: check container $id"; done
  if ! { container_ours && [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ]; }; then
    line "left: the control service is not running, so lanes cannot be deleted through it. Start it (docker compose up -d) and run --cleanup again."
    return 0
  fi
  # Lanes of this check: by task, in every project, and the ids this machine recorded.
  if run_split 60 "$TMPD/all.json" docker exec -i "$CONTAINER" contextlanes list --json; then
    for id in $(jsq 'd.filter(l => l.task.startsWith(a[0])).map(l => l.id).join(" ")' "$TASK" <"$TMPD/all.json"); do
      if run 300 docker exec -i "$CONTAINER" contextlanes delete "$id" --force --delete-branch --json; then line "removed: lane $id (container, image, checkout, lane branch)"
      else line "left: lane $id: delete failed (see the log)"; fi
    done
  fi
  if run_split 30 "$TMPD/projects.json" docker exec -i "$CONTAINER" contextlanes projects --json; then
    local pid
    if [ -e "$STATE/other-project" ]; then
      pid="$(cat "$STATE/other-project")"
      run 30 docker exec -i "$CONTAINER" contextlanes remove "$pid" && line "removed: project $pid (the uid $OTHER_UID repository)"
    fi
    if [ -e "$STATE/project-added" ]; then
      pid="$(jsq '(d.find(p => p.path === a[0]) || {}).id || ""' "$P" <"$TMPD/projects.json")"
      [ -n "$pid" ] && run 30 docker exec -i "$CONTAINER" contextlanes remove "$pid" && line "removed: project $pid from ContextLanes (the folder is untouched)"
    fi
  fi
  if [ -e "$OTHER_ROOT" ]; then
    # Owned by uid $OTHER_UID, so a root container removes it; it mounts only that folder.
    run 120 docker run --rm --label "$CHECK_LABEL" --network none --user 0:0 --mount "type=bind,source=$STATE,target=$STATE" --entrypoint rm "$IMAGE" -rf -- "$OTHER_ROOT" && line "removed: $OTHER_ROOT"
  fi
  if [ -e "$STATE/agent-home-made" ] && docker volume inspect "contextlanes-agent-home-$OTHER_UID" >/dev/null 2>&1; then
    run 30 docker volume rm "contextlanes-agent-home-$OTHER_UID" && line "removed: volume contextlanes-agent-home-$OTHER_UID"
  fi
  if [ -e "$STATE/lanes-folder-made" ] && [ -d "$P.lanes" ] && [ -z "$(ls -A "$P.lanes" 2>/dev/null)" ]; then
    rmdir "$P.lanes" && line "removed: empty $P.lanes"
  fi
  rm -f "$STATE/lanes" "$STATE/project-added" "$STATE/other-project" "$STATE/agent-home-made" "$STATE/lanes-folder-made"
  rmdir "$STATE" 2>/dev/null || true
  line "left: the stack (running), $STACK/data, the image $IMAGE, contextlanes-tools and agent-login volumes this check did not make"
}

# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------
say "ContextLanes v4 phase 3 check ($MODE) $(date -Is)"
say "project: $P"
say "stack: $STACK"
say "log: $LOG"

if [ "$MODE" = cleanup ]; then
  docker version >/dev/null 2>&1 || { say "Docker is not reachable"; exit 3; }
  cleanup
  exit 0
fi

check1
if passed 1; then check2; else skip_check 2 "The control service" "check 1 did not pass"; fi
if passed 2; then check3; else skip_check 3 "contextlanes new --no-agent" "the control service is not ready"; fi
if [ -n "$LANE_NAME" ] && [ "${#LX[@]}" -gt 0 ]; then
  check4; check5; check6; check7; check8; check9; check10
else
  for n in 4 5 6 7 8 9 10; do skip_check "$n" "(needs the lane from check 3)" "no lane"; done
fi
check11

say ""
say "== Summary =="
say "$(printf '%-6s %-62s %6s  %s' CHECK TITLE TIME RESULT)"
fails=0
for i in 1 2 3 4 5 6 7 8 9 10 11; do
  say "$(printf '%-6s %-62s %5ss  %s' "$i" "${C_TITLE[$i]:-}" "${C_TIME[$i]:-0}" "${C_RESULT[$i]:-not run}")"
  case "${C_RESULT[$i]:-}" in PASS|MANUAL|SKIP*) ;; *) fails=$((fails + 1)) ;; esac
done
say ""
say "The stack is left running. Clean up what the check made with: $0 --cleanup $(printf '%q' "$P")"
say "Paste the summary above and attach $LOG_NAME"
[ "$fails" -eq 0 ]
