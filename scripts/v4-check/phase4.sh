#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2016
# SC2015: ok and bad always succeed, so "test && ok || bad" is an if/else here.
# SC2016: the single-quoted $ and backticks are JavaScript for node, or sh for the lane, not this shell.
# ContextLanes v4, phase 4 machine check (docs/V4.md section 7): a lane's app and its links.
#
#   scripts/v4-check/phase4.sh <path-to-git-repo>             check lane apps against a repository
#   scripts/v4-check/phase4.sh --cleanup <path-to-git-repo>   remove what the check made
#   options: --allow-root, --help
#
# It needs the phase 3 stack: it runs docker compose up -d --build in this checkout's folder first. It does
# not need the repository to have a recipe: it makes two lanes with --no-agent (tasks starting with
# "phase 4 check"), writes a tiny recipe and a tiny Node HTTP server into each lane's checkout (through
# the lane, as its user), runs them with the tools volume's Node (nothing is installed in the lane), and
# removes the files again. The lanes, their containers, images, checkouts and lane/ branches are deleted at
# the end (contextlanes delete --force --delete-branch). Its own check containers carry the label
# contextlanes.check=1. Nothing that was there before is removed. The repository's status, HEAD, refs,
# worktrees and stashes are compared before and after.
# Full command output goes to ./v4-phase4-<timestamp>.log; the terminal shows a summary per check.
set -uo pipefail

readonly CONTAINER=contextlanes
readonly SERVICE=control
readonly COMPOSE_PROJECT=contextlanes
readonly NET=contextlanes
readonly IMAGE=contextlanes:local
readonly CHECK_LABEL=contextlanes.check=1
readonly HELPER_LABEL=contextlanes.helper=1
readonly TASK="phase 4 check"
readonly ROUTER=4601
readonly WEB_PORT=3000
readonly LO_PORT=3001
readonly SERVER_FILE=.cl-phase4-server.cjs
readonly RECIPE_FILE=.contextlanes.json

usage() {
  cat <<'EOF'
Usage:
  scripts/v4-check/phase4.sh <path-to-git-repo>             check lane apps and links against a repository
  scripts/v4-check/phase4.sh --cleanup <path-to-git-repo>   remove the lanes and files the check made
Options:
  --allow-root     run even when invoked as root
  -h, --help       this text
EOF
}

MODE=run ALLOW_ROOT=0 PROJECT_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cleanup) MODE=cleanup ;;
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
# What the check made, kept between a run and its --cleanup.
STATE="${TMPDIR:-/tmp}/cl-phase4-$(id -u)"

TS="$(date +%Y%m%d-%H%M%S)"
if [ "$MODE" = cleanup ]; then LOG_NAME="v4-phase4-cleanup-$TS.log"; else LOG_NAME="v4-phase4-$TS.log"; fi
LOG="$PWD/$LOG_NAME"
: >"$LOG" || { printf 'cannot write the log file %s\n' "$LOG" >&2; exit 1; }
OUT="$(mktemp "${TMPDIR:-/tmp}/cl-phase4-out.XXXXXX")" || exit 1
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/cl-phase4.XXXXXX")" || exit 1
trap 'rm -rf "$OUT" "$TMPD"' EXIT
trap 'printf "\nInterrupted. Clean up with: %s --cleanup %q\n" "$0" "$P" | tee -a "$LOG"; exit 130' INT TERM

# ---------------------------------------------------------------------------------------------
# Output helpers (as in phase3.sh)
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
# run_in SECONDS INPUT_FILE cmd...: like run, with stdin from a file (never the terminal).
run_in() {
  local t="$1" in="$2"; shift 2
  log_cmd "$@"
  timeout -k 10 "$t" "$@" <"$in" 2>&1 | tee "$OUT" >>"$LOG"
  local rc="${PIPESTATUS[0]}"
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
  docker exec -i "$CONTAINER" node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{let d=null;try{d=JSON.parse(s||'null')}catch{};const a=process.argv.slice(1);const r=($expr);process.stdout.write(typeof r==='string'?r:JSON.stringify(r));})" "$@"
}
# The command in the control container, as the host command runs it:
#   docker exec -i -e CONTEXTLANES_CWD=<folder> contextlanes contextlanes ...
CL=(docker exec -i -e "CONTEXTLANES_CWD=$P" "$CONTAINER" contextlanes)

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

# A check container on the contextlanes network (as a proxy container attached to it would be), and one
# with the host's network (as a proxy on this machine is). Both run the control image's own Node.
BY_NAME=(docker run --rm --label "$CHECK_LABEL" --network "$NET" --entrypoint node "$IMAGE" -e)
ON_HOST=(docker run --rm --label "$CHECK_LABEL" --network host --entrypoint node "$IMAGE" -e)
# GET a URL; prints "<status> <body>" or "error <code>".
readonly JS_GET='fetch(process.argv[1]).then(async r=>console.log(r.status+" "+(await r.text()).trim()),e=>{console.log("error "+((e.cause&&e.cause.code)||e.message));process.exit(1)})'
# GET 127.0.0.1:<router><path> with a Host header; prints "<status> <body>".
readonly JS_ROUTER='const [host,path,port]=process.argv.slice(1);require("http").get({host:"127.0.0.1",port:Number(port),path,headers:{host}},r=>{let b="";r.on("data",d=>b+=d);r.on("end",()=>console.log(r.statusCode+" "+b.trim()))}).on("error",e=>{console.log("error "+e.code);process.exit(1)})'
# A WebSocket upgrade through the router; prints "<status> <what came back>".
readonly JS_WS='const [host,port]=process.argv.slice(1);const req=require("http").request({host:"127.0.0.1",port:Number(port),path:"/",headers:{host,Connection:"Upgrade",Upgrade:"websocket","Sec-WebSocket-Version":"13","Sec-WebSocket-Key":"dGhlIHNhbXBsZSBub25jZQ=="}});req.on("upgrade",(res,sock)=>{sock.once("data",d=>{console.log(res.statusCode+" "+d.toString());sock.destroy()});sock.write("cl-phase4-ping")});req.on("response",res=>{console.log("no upgrade "+res.statusCode);process.exit(1)});req.on("error",e=>{console.log("error "+e.code);process.exit(1)});req.setTimeout(8000,()=>{console.log("timeout");process.exit(1)});req.end()'

PROJECT_ID=""
# Two lanes: A and B. Per lane: id, container name, checkout, branch, and the docker exec prefix into it.
A_ID="" A_NAME="" A_WT="" A_BRANCH="" B_ID="" B_NAME="" B_WT="" B_BRANCH=""
declare -a LXA=() LXA_IN=() LXB=() LXB_IN=()

# The files the check writes into a lane's checkout.
write_files() {
  cat >"$TMPD/server.cjs" <<'EOF'
// ContextLanes phase 4 check: a tiny HTTP server, removed again by the check.
const http = require("node:http");
const crypto = require("node:crypto");
const loopback = process.argv[2] === "loopback";
const host = loopback ? "127.0.0.1" : process.env.HOST;
const port = Number(process.env.PORT);
const server = http.createServer((req, res) => {
  if (req.url === "/crash") { res.end("bye\n"); setTimeout(() => process.exit(1), 50); return; }
  res.setHeader("content-type", "text/plain");
  res.end(`cl-phase4 pid=${process.pid} lane=${process.env.CONTEXTLANES_LANE} host=${req.headers.host}\n`);
});
server.on("upgrade", (req, socket) => {
  const accept = crypto.createHash("sha1").update(`${req.headers["sec-websocket-key"] || ""}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on("data", (d) => socket.end(d));
});
server.listen(port, host, () => console.log(`cl-phase4 listening on ${host}:${port} pid ${process.pid}`));
EOF
  # copy names a pattern no repository has, so the copy helper runs and copies nothing.
  cat >"$TMPD/recipe.json" <<EOF
{
  "copy": [".cl-phase4-nothing-*"],
  "services": [
    { "name": "web", "command": ["node", "$SERVER_FILE"], "port": { "number": $WEB_PORT }, "health": { "path": "/health", "timeoutSeconds": 30 } },
    { "name": "lo", "command": ["node", "$SERVER_FILE", "loopback"], "port": { "number": $LO_PORT }, "health": { "path": "/health", "timeoutSeconds": 8 } }
  ]
}
EOF
}

# new_lane LETTER TASK: makes a lane with --no-agent and sets <LETTER>_ID, _NAME, _WT, _BRANCH, LX<LETTER>, LX<LETTER>_IN.
new_lane() {
  local which="$1" task="$2" id name wt branch user lpath
  if ! run_split 1800 "$TMPD/new-$which.json" "${CL[@]}" new --no-agent "$task" --json; then
    bad "contextlanes new failed for lane $which"; show_tail
    [ -s "$TMPD/new-$which.json" ] && jsq 'd && d.id || ""' <"$TMPD/new-$which.json" >>"$STATE/lanes" && echo >>"$STATE/lanes"
    return 1
  fi
  id="$(jsq 'd.id' <"$TMPD/new-$which.json")"; name="$(jsq 'd.terminal' <"$TMPD/new-$which.json")"
  wt="$(jsq 'd.worktree' <"$TMPD/new-$which.json")"; branch="$(jsq 'd.branch' <"$TMPD/new-$which.json")"
  printf '%s\n' "$id" >>"$STATE/lanes"
  line "lane $which: $id, container $name, checkout $wt, state $(jsq 'd.state' <"$TMPD/new-$which.json")"
  [ "$(jsq 'd.state' <"$TMPD/new-$which.json")" = working ] || { bad "lane $id is $(jsq 'd.state' <"$TMPD/new-$which.json")"; return 1; }
  run_split 30 "$TMPD/open-$which.json" "${CL[@]}" open "$id" --json || { bad "contextlanes open --json failed for $id"; show_tail; return 1; }
  user="$(jsq 'd.attach[d.attach.indexOf("-u") + 1]' <"$TMPD/open-$which.json")"
  lpath="$(jsq 'd.attach.find(x => x.startsWith("PATH=")).slice(5)' <"$TMPD/open-$which.json")"
  local -a env=(-e "PATH=$lpath" -e TERM=xterm-256color -e "CONTEXTLANES_LANE=$id" -e CONTEXTLANES_URL=http://contextlanes:4600)
  if [ "$which" = A ]; then
    A_ID="$id" A_NAME="$name" A_WT="$wt" A_BRANCH="$branch"
    LXA=(docker exec -u "$user" -w "$wt" "${env[@]}" "$name"); LXA_IN=(docker exec -i -u "$user" -w "$wt" "${env[@]}" "$name")
  else
    B_ID="$id" B_NAME="$name" B_WT="$wt" B_BRANCH="$branch"
    LXB=(docker exec -u "$user" -w "$wt" "${env[@]}" "$name"); LXB_IN=(docker exec -i -u "$user" -w "$wt" "${env[@]}" "$name")
  fi
  return 0
}

# put WHICH SOURCE NAME: writes a file into the lane's checkout through the lane, as its user (stdin, never an argument).
put() {
  local which="$1" src="$2" name="$3"
  if [ "$which" = A ]; then run_in 30 "$src" "${LXA_IN[@]}" sh -c 'cat > "$1"' sh "$name"; else run_in 30 "$src" "${LXB_IN[@]}" sh -c 'cat > "$1"' sh "$name"; fi
}

# The lane's own recipe (from the repository) is kept aside and put back before the lane is deleted.
place_files() {
  local which="$1"
  local -a lx
  if [ "$which" = A ]; then lx=("${LXA[@]}"); else lx=("${LXB[@]}"); fi
  if run 15 "${lx[@]}" sh -c 'test -e "$1" && echo present || echo absent' sh "$RECIPE_FILE" && [ "$(out_first)" = present ]; then
    run_split 15 "$TMPD/own-recipe-$which" "${lx[@]}" cat "$RECIPE_FILE" && info "the repository has its own $RECIPE_FILE; it is put back before the lane is deleted"
  else rm -f "$TMPD/own-recipe-$which"; fi
  if put "$which" "$TMPD/server.cjs" "$SERVER_FILE" && put "$which" "$TMPD/recipe.json" "$RECIPE_FILE"; then ok "wrote $SERVER_FILE and $RECIPE_FILE into lane $which's checkout"; return 0; fi
  bad "could not write the files into lane $which"; show_tail; return 1
}

remove_files() {
  local which="$1"
  local -a lx
  if [ "$which" = A ]; then lx=("${LXA[@]}"); else lx=("${LXB[@]}"); fi
  [ "${#lx[@]}" -gt 0 ] || return 0
  run 15 "${lx[@]}" rm -f "$SERVER_FILE"
  if [ -f "$TMPD/own-recipe-$which" ]; then put "$which" "$TMPD/own-recipe-$which" "$RECIPE_FILE"; else run 15 "${lx[@]}" rm -f "$RECIPE_FILE"; fi
}

# service_field LANE SERVICE EXPR: from contextlanes app status --json, EXPR over the service (s).
service_field() {
  run_split 30 "$TMPD/status.json" "${CL[@]}" app status "$1" --json >/dev/null
  jsq "((d && d.services || []).find(x => x.name === a[0]) ? (s => ($3))(d.services.find(x => x.name === a[0])) : 'missing')" "$2" <"$TMPD/status.json"
}
wait_state() { # wait_state LANE SERVICE STATE SECONDS
  local i
  for i in $(seq 1 "$4"); do [ "$(service_field "$1" "$2" 's.state')" = "$3" ] && return 0; sleep 1; done
  return 1
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
  line "stack folder: $STACK"
  line "project: $P (owner $(stat -c '%u:%g' "$P"))"
  [ -d "$P/.git" ] && ok "the project has a .git folder" || bad "$P is not the top folder of a git repository with a .git folder"
  case "$P" in "$STACK"|"$STACK"/*) bad "the project is inside the stack folder; ContextLanes refuses that. Use another repository" ;; esac
  if git --no-optional-locks -C "$P" rev-parse --verify --quiet HEAD >/dev/null 2>&1; then SNAP_GIT=(git); ok "host git reads the repository: $(git --version)"
  else bad "host git cannot read $P (or it has no commits); this check compares the repository with host git"; fi
  [ -f "$P/$RECIPE_FILE" ] && info "the repository has its own $RECIPE_FILE; the check writes its own into the lanes' checkouts only" || info "the repository has no $RECIPE_FILE (not needed)"
  [ -e "$P.lanes" ] || : >"$TMPD/lanes-folder-missing"
  mkdir -p "$STATE" && chmod 0700 "$STATE" || bad "cannot create $STATE"
  [ -e "$TMPD/lanes-folder-missing" ] && : >"$STATE/lanes-folder-made"
  write_files
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 2: the stack at this checkout's version
# ---------------------------------------------------------------------------------------------
check2() {
  begin 2 "The control service is up, healthy and at this checkout's version"
  if docker inspect --type container "$CONTAINER" >/dev/null 2>&1 && ! container_ours; then
    bad "a container named $CONTAINER exists and is not this stack's; run scripts/v4-check/phase2.sh first, which says what to do"; finish; return
  fi
  line "docker compose up -d --build (rebuilds only what changed). Follow it: tail -f $LOG_NAME"
  if ! run 2400 docker compose --project-directory "$STACK" -f "$STACK/compose.yaml" up -d --build; then bad "docker compose up failed"; show_tail; finish; return; fi
  if wait_healthy; then ok "$CONTAINER is healthy"; else bad "$CONTAINER is not healthy"; run 30 docker logs --tail 40 "$CONTAINER"; show_tail; finish; return; fi
  run 15 docker port "$CONTAINER"
  line "published by the control container: $(tr '\n' ' ' <"$OUT")"
  grep -q "^$ROUTER/tcp" "$OUT" && ok "the router ($ROUTER) is published" || bad "the router ($ROUTER) is not published; this check reaches it on 127.0.0.1:$ROUTER"
  grep -q '^4600/tcp' "$OUT" && bad "the API (4600) is published" || ok "the API (4600) is not published"
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 3: a lane, and its recipe refused until the owner approves it
# ---------------------------------------------------------------------------------------------
check3() {
  begin 3 "A lane's recipe waits for the owner (exit 4); a lane cannot approve it"
  snapshot "$TMPD/before"; logonly "--- before:"; cat "$TMPD/before" >>"$LOG"
  run_split 60 "$TMPD/projects.json" "${CL[@]}" projects --json || { bad "contextlanes projects failed"; show_tail; finish; return; }
  if [ "$(jsq 'd.some(p => p.path === a[0]) ? "yes" : "no"' "$P" <"$TMPD/projects.json")" = no ]; then
    run_split 120 "$TMPD/add.json" "${CL[@]}" add --json || { bad "contextlanes add failed"; show_tail; finish; return; }
    : >"$STATE/project-added"
  else run_split 30 "$TMPD/add.json" "${CL[@]}" add --json; fi
  PROJECT_ID="$(jsq 'd.id' <"$TMPD/add.json")"
  line "project: $PROJECT_ID"
  line "creating lane A (the lane image is already there from phase 3, or is pulled now)"
  new_lane A "$TASK" || { finish; return; }
  place_files A || { finish; return; }
  if run_split 60 "$TMPD/recipe-a.json" "${CL[@]}" recipe "$A_ID" --json; then
    line "recipe: $(jsq '`${d.file} sha ${d.hash.slice(0, 7)} approved=${d.approved} error=${d.error}`' <"$TMPD/recipe-a.json")"
    [ "$(jsq 'd.approved === false && d.error === null && d.recipe.services.length === 2 ? "yes" : "no"' <"$TMPD/recipe-a.json")" = yes ] && ok "read from inside the lane: valid, two services, not approved" || bad "the recipe read back is not the one written"
  else bad "contextlanes recipe failed"; show_tail; fi
  run_split 120 "$TMPD/start0.json" "${CL[@]}" app start "$A_ID" web --json; local rc=$?
  [ "$rc" -eq 4 ] && grep -q '"code":"recipe_unapproved"' "$OUT" && ok "app start before approval exits 4 (recipe_unapproved)" || bad "app start before approval exited $rc: $(out_first)"
  run_split 30 "$TMPD/lapprove.json" "${LXA[@]}" contextlanes approve --json; rc=$?
  [ "$rc" -eq 4 ] && grep -q owner_only "$OUT" && ok "contextlanes approve inside the lane exits 4 (owner_only)" || bad "approve inside the lane exited $rc"
  # Past the command: the lane's own token straight at the API is refused too.
  local hash; hash="$(jsq 'd.hash' <"$TMPD/recipe-a.json")"
  run 30 "${LXA[@]}" node -e 'const fs=require("fs");const t=fs.readFileSync("/var/lib/contextlanes-lane/token","utf8").trim();fetch(`http://contextlanes:4600/api/projects/${process.argv[1]}/recipe/approve`,{method:"POST",headers:{authorization:`Bearer ${t}`,"content-type":"application/json"},body:JSON.stringify({hash:process.argv[2]})}).then(r=>console.log(r.status),e=>{console.log("error "+e.message);process.exit(1)})' "$PROJECT_ID" "$hash"
  [ "$(out_first)" = 401 ] && ok "the lane's token posting the approval itself gets 401" || bad "the lane's token posting the approval got '$(out_first)'"
  if run_split 60 "$TMPD/approve.json" "${CL[@]}" approve "$A_ID" --json; then
    [ "$(jsq 'd.approved && d.hash === a[0] ? "yes" : "no"' "$hash" <"$TMPD/approve.json")" = yes ] && ok "approved by the owner: sha ${hash:0:7}" || bad "approve answered $(cat "$TMPD/approve.json")"
  else bad "contextlanes approve failed"; show_tail; fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 4: app start, healthy, logs, nothing published
# ---------------------------------------------------------------------------------------------
check4() {
  begin 4 "app start: the service runs inside the lane on its real port and is healthy"
  if ! run_split 120 "$TMPD/start.json" "${CL[@]}" app start "$A_ID" web --json; then bad "app start failed"; show_tail; cat "$TMPD/start.json" >>"$LOG"; finish; return; fi
  local st port
  st="$(jsq '(d.services.find(s => s.name === "web") || {}).state' <"$TMPD/start.json")"; port="$(jsq '(d.services.find(s => s.name === "web") || {}).port' <"$TMPD/start.json")"
  [ "$st" = healthy ] && ok "web is healthy" || bad "web is $st: $(jsq '(d.services.find(s => s.name === "web") || {}).detail' <"$TMPD/start.json")"
  [ "$port" = "$WEB_PORT" ] && ok "on the recipe's port $WEB_PORT (no port allocated)" || bad "web is on port $port, not $WEB_PORT"
  if run 15 "${LXA[@]}" sh -c 'for p in /proc/[0-9]*; do [ "${p#/proc/}" = "$$" ] && continue; c=$(tr "\0" " " < "$p/cmdline" 2>/dev/null); case "$c" in *cl-phase4-server*) echo "$c";; esac; done'; then
    grep -q "$SERVER_FILE" "$OUT" && ok "the server runs inside $A_NAME: $(out_first)" || bad "no server process inside the lane"
  fi
  if run_split 30 "$TMPD/logs.json" "${CL[@]}" logs web "$A_ID" --json -n 20; then
    [ "$(jsq 'd.some(l => l.text.includes("cl-phase4 listening on 0.0.0.0:" + a[0])) ? "yes" : "no"' "$WEB_PORT" <"$TMPD/logs.json")" = yes ] && ok "logs: it listens on 0.0.0.0:$WEB_PORT (HOST and PORT came from ContextLanes)" || bad "logs do not show 'listening on 0.0.0.0:$WEB_PORT': $(jsq 'd.map(l => l.text).join(" | ")' <"$TMPD/logs.json")"
  else bad "contextlanes logs failed"; show_tail; fi
  run 15 docker port "$A_NAME"
  [ -s "$OUT" ] && bad "the lane publishes ports: $(tr '\n' ' ' <"$OUT")" || ok "nothing published on $A_NAME"
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 5: reached by name, and through the router with the right Host, websockets included
# ---------------------------------------------------------------------------------------------
check5() {
  begin 5 "Reached by container name and through the router on 127.0.0.1:$ROUTER, websockets too"
  if run 120 "${BY_NAME[@]}" "$JS_GET" "http://$A_NAME:$WEB_PORT/"; then
    case "$(out_first)" in "200 cl-phase4 "*"lane=$A_ID"*) ok "a container on $NET reaches http://$A_NAME:$WEB_PORT/: $(out_first)" ;; *) bad "by name: $(out_first)" ;; esac
  else bad "a container on $NET cannot reach http://$A_NAME:$WEB_PORT/: $(out_first)"; fi
  run_split 30 "$TMPD/url.json" "${CL[@]}" url web "$A_ID" --json || { bad "contextlanes url failed"; show_tail; finish; return; }
  local url host
  url="$(jsq 'd.url' <"$TMPD/url.json")"; host="$(jsq 'new URL(d.url).hostname' <"$TMPD/url.json")"
  line "link: $url"
  if run 120 "${ON_HOST[@]}" "$JS_ROUTER" "$host" / "$ROUTER"; then
    case "$(out_first)" in "200 cl-phase4 "*"host=$host") ok "through the router with Host $host: $(out_first)" ;; "200 cl-phase4 "*) bad "the router changed the Host header: $(out_first)" ;; *) bad "through the router: $(out_first)" ;; esac
  else bad "the router on 127.0.0.1:$ROUTER did not answer: $(out_first)"; fi
  run 120 "${ON_HOST[@]}" "$JS_ROUTER" "nothing-00-${PROJECT_ID}.localhost" / "$ROUTER"
  case "$(out_first)" in "404 ContextLanes: no running preview"*) ok "a name it did not publish gets the router's 404" ;; *) bad "an unknown name got: $(out_first)" ;; esac
  if run 120 "${ON_HOST[@]}" "$JS_WS" "$host" "$ROUTER"; then
    [ "$(out_first)" = "101 cl-phase4-ping" ] && ok "a WebSocket upgrade goes through the router and back (hot reload uses it)" || bad "WebSocket: $(out_first)"
  else bad "WebSocket through the router: $(out_first)"; fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 6: a crash restarts the service
# ---------------------------------------------------------------------------------------------
check6() {
  begin 6 "A crashed service is started again inside the lane"
  run 120 "${BY_NAME[@]}" "$JS_GET" "http://$A_NAME:$WEB_PORT/"
  local before after i
  before="$(out_first | sed -n 's/.*pid=\([0-9]*\).*/\1/p')"
  [ -n "$before" ] || { bad "could not read the server's pid: $(out_first)"; finish; return; }
  run 60 "${BY_NAME[@]}" "$JS_GET" "http://$A_NAME:$WEB_PORT/crash"
  line "crashed pid $before; waiting for it to come back"
  after=""
  for i in $(seq 1 30); do
    sleep 1
    run 60 "${BY_NAME[@]}" "$JS_GET" "http://$A_NAME:$WEB_PORT/" || continue
    after="$(out_first | sed -n 's/.*pid=\([0-9]*\).*/\1/p')"
    [ -n "$after" ] && [ "$after" != "$before" ] && break
  done
  [ -n "$after" ] && [ "$after" != "$before" ] && ok "it answers again as pid $after after ${i}s" || bad "the service did not come back after the crash"
  wait_state "$A_ID" web healthy 30 && ok "app status says healthy again" || bad "web is $(service_field "$A_ID" web 's.state') after the crash"
  run_split 30 "$TMPD/logs2.json" "${CL[@]}" logs web "$A_ID" --json -n 50
  [ "$(jsq 'd.filter(l => l.text.includes("cl-phase4 listening")).length' <"$TMPD/logs2.json")" -ge 2 ] && ok "the logs show it started twice" || info "the logs show $(jsq 'd.filter(l => l.text.includes("cl-phase4 listening")).length' <"$TMPD/logs2.json") start(s)"
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 7: a second lane runs the same port at the same time
# ---------------------------------------------------------------------------------------------
check7() {
  begin 7 "A second lane runs the same port at the same time"
  new_lane B "$TASK second lane" || { finish; return; }
  place_files B || { finish; return; }
  # The same bytes, so the approval given for lane A covers it.
  if ! run_split 120 "$TMPD/startb.json" "${CL[@]}" app start "$B_ID" web --json; then bad "app start in lane B failed (exit $?)"; show_tail; finish; return; fi
  [ "$(jsq '(d.services.find(s => s.name === "web") || {}).state + " " + (d.services.find(s => s.name === "web") || {}).port' <"$TMPD/startb.json")" = "healthy $WEB_PORT" ] && ok "lane B's web is healthy on port $WEB_PORT too (the same approval covers the same bytes)" || bad "lane B: $(cat "$TMPD/startb.json")"
  run 120 "${BY_NAME[@]}" "$JS_GET" "http://$A_NAME:$WEB_PORT/"; local a; a="$(out_first)"
  run 120 "${BY_NAME[@]}" "$JS_GET" "http://$B_NAME:$WEB_PORT/"; local b; b="$(out_first)"
  case "$a" in *"lane=$A_ID"*) ok "$A_NAME:$WEB_PORT answers for $A_ID" ;; *) bad "$A_NAME:$WEB_PORT: $a" ;; esac
  case "$b" in *"lane=$B_ID"*) ok "$B_NAME:$WEB_PORT answers for $B_ID" ;; *) bad "$B_NAME:$WEB_PORT: $b" ;; esac
  run_split 30 "$TMPD/urlb.json" "${CL[@]}" url web "$B_ID" --json
  local hb; hb="$(jsq 'new URL(d.url).hostname' <"$TMPD/urlb.json")"
  run 120 "${ON_HOST[@]}" "$JS_ROUTER" "$hb" / "$ROUTER"
  case "$(out_first)" in *"lane=$B_ID"*) ok "the router sends $hb to lane B" ;; *) bad "the router for $hb: $(out_first)" ;; esac
  run 15 docker port "$B_NAME"
  [ -s "$OUT" ] && bad "lane B publishes ports" || ok "nothing published on $B_NAME"
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 8: a recipe changed after approval is refused
# ---------------------------------------------------------------------------------------------
check8() {
  begin 8 "A recipe changed after approval is refused again (exit 4)"
  { cat "$TMPD/recipe.json"; echo " "; } >"$TMPD/recipe-changed.json"
  put A "$TMPD/recipe-changed.json" "$RECIPE_FILE" || { bad "could not change the recipe"; finish; return; }
  run_split 120 "$TMPD/restart.json" "${CL[@]}" app restart "$A_ID" web --json; local rc=$?
  [ "$rc" -eq 4 ] && grep -q recipe_unapproved "$OUT" && ok "one added space: app restart exits 4 (recipe_unapproved)" || bad "the changed recipe was not refused (exit $rc)"
  put A "$TMPD/recipe.json" "$RECIPE_FILE" || bad "could not put the recipe back"
  if run_split 120 "$TMPD/start2.json" "${CL[@]}" app start "$A_ID" web --json; then ok "the approved bytes back: app start works again"
  else bad "app start with the approved recipe back failed"; show_tail; fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 9: a loopback-only server is reported as such; doctor
# ---------------------------------------------------------------------------------------------
check9() {
  begin 9 "A server that listens only on 127.0.0.1 is reported plainly; doctor"
  run_split 120 "$TMPD/lo.json" "${CL[@]}" app start "$A_ID" lo --json; local rc=$?
  [ "$rc" -eq 1 ] && ok "app start lo exits 1" || bad "app start lo exited $rc"
  local detail; detail="$(service_field "$A_ID" lo 's.state + ": " + s.detail')"
  line "lo: $detail"
  case "$detail" in *"listens only on 127.0.0.1:$LO_PORT inside the lane"*) ok "app status says it listens only on 127.0.0.1:$LO_PORT and how to fix it" ;; *) bad "app status does not name loopback: $detail" ;; esac
  if run_split 180 "$TMPD/doctor.json" "${CL[@]}" doctor --json || [ -s "$TMPD/doctor.json" ]; then
    local id
    for id in app-links loopback recipes proxy chain; do
      line "doctor $id: $(jsq '(c => c ? c.state + ": " + c.found : "not run")(d.checks.find(c => c.id === a[0]))' "$id" <"$TMPD/doctor.json")"
    done
    [ "$(jsq '(d.checks.find(c => c.id === "loopback") || {}).state' <"$TMPD/doctor.json")" = warn ] && ok "doctor warns about the loopback-only service" || bad "doctor loopback is not warn"
    [ "$(jsq '(d.checks.find(c => c.id === "app-links") || {}).state' <"$TMPD/doctor.json")" = ok ] && ok "doctor reaches the healthy services by name and through the router" || bad "doctor app-links is not ok"
  else bad "doctor --json gave nothing"; show_tail; fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 10: app stop
# ---------------------------------------------------------------------------------------------
check10() {
  begin 10 "app stop: the services end and their links go"
  local host
  host="$(jsq 'new URL(d.url).hostname' <"$TMPD/url.json")"
  for which in A B; do
    local id; if [ "$which" = A ]; then id="$A_ID"; else id="$B_ID"; fi
    [ -n "$id" ] || continue
    if run_split 60 "$TMPD/stop-$which.json" "${CL[@]}" app stop "$id" --json; then
      [ "$(jsq 'd.services.every(s => s.state === "stopped" && s.url === null) ? "yes" : "no"' <"$TMPD/stop-$which.json")" = yes ] && ok "every service of $id is stopped" || bad "$id after stop: $(cat "$TMPD/stop-$which.json")"
    else bad "app stop $id failed"; show_tail; fi
  done
  run 60 "${BY_NAME[@]}" "$JS_GET" "http://$A_NAME:$WEB_PORT/"
  case "$(out_first)" in "error "*) ok "nothing answers on $A_NAME:$WEB_PORT any more ($(out_first))" ;; *) bad "something still answers on $A_NAME:$WEB_PORT: $(out_first)" ;; esac
  run 60 "${ON_HOST[@]}" "$JS_ROUTER" "$host" / "$ROUTER"
  case "$(out_first)" in "404 ContextLanes: no running preview"*) ok "the router no longer answers for $host" ;; *) bad "the router for $host: $(out_first)" ;; esac
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 11: the files go, the lanes are deleted, and the repository is as it was
# ---------------------------------------------------------------------------------------------
check11() {
  begin 11 "Files removed, lanes deleted, and the repository is as it was"
  local which id name wt branch
  for which in A B; do
    if [ "$which" = A ]; then id="$A_ID" name="$A_NAME" wt="$A_WT" branch="$A_BRANCH"; else id="$B_ID" name="$B_NAME" wt="$B_WT" branch="$B_BRANCH"; fi
    [ -n "$id" ] || continue
    remove_files "$which"
    if run 15 docker exec "$name" sh -c 'test -e "$1/$2" && echo present || echo absent' sh "$wt" "$SERVER_FILE" && [ "$(out_first)" = absent ]; then ok "$SERVER_FILE removed from lane $which"; else bad "$SERVER_FILE is still in lane $which"; fi
    if run_split 300 "$TMPD/del-$which.json" "${CL[@]}" delete "$id" --force --delete-branch --json; then ok "deleted $id"; else bad "deleting $id failed"; show_tail; continue; fi
    docker inspect --type container "$name" >/dev/null 2>&1 && bad "container $name is still there" || ok "container $name is gone"
    [ -e "$wt" ] && bad "$wt is still on the host" || ok "the checkout $wt is gone"
    git -C "$P" rev-parse --verify --quiet "refs/heads/$branch" >/dev/null && bad "branch $branch is still there" || ok "branch $branch is deleted"
  done
  sleep 2
  local left
  left="$(docker ps -a --filter "label=$HELPER_LABEL" --format '{{.Names}} {{.Status}}')"
  [ -z "$left" ] && ok "no helper containers left" || bad "helper containers left: $(echo "$left" | tr '\n' ';')"
  left="$(docker ps -a --filter "label=$CHECK_LABEL" --format '{{.Names}}')"
  [ -z "$left" ] && ok "no check containers left" || bad "check containers left: $(echo "$left" | tr '\n' ';')"
  snapshot "$TMPD/after"; logonly "--- after:"; cat "$TMPD/after" >>"$LOG"
  if cmp -s "$TMPD/before" "$TMPD/after"; then ok "git status, HEAD, refs, worktrees and stashes are the same as before"
  else bad "the repository changed:"; diff "$TMPD/before" "$TMPD/after" | head -n 20 | sed 's/^/      | /' | tee -a "$LOG"; fi
  finish
}

# ---------------------------------------------------------------------------------------------
# CHECK 12: through your proxy, with a real dev server (manual)
# ---------------------------------------------------------------------------------------------
check12() {
  begin 12 "Open a link through your proxy, and hot reload (manual)"
  local q; q="$(printf '%q' "$P")"
  line "Not automated. Doctor's 'proxy' line above says which of the two ways this machine allows (docs/PROXY.md):"
  line "  (a) docker network connect $NET <proxy container>, and the wildcard entry forwards to contextlanes:$ROUTER"
  line "  (b) \"$ROUTER:$ROUTER\" instead of \"127.0.0.1:$ROUTER:$ROUTER\" in compose.yaml, then docker compose up -d"
  line "Then, with [previews] domain set in $STACK/data/config.toml and the stack restarted:"
  say "      cd $q && contextlanes new --no-agent \"$TASK hot reload\""
  say "      contextlanes open <lane>      # in the lane: write a .contextlanes.json for your dev server (Vite: --host \$HOST --port \$PORT)"
  say "      contextlanes approve <lane> && contextlanes app start <lane> && contextlanes url web <lane>"
  line "Open the link on another device, change a file in the lane, and see the page update."
  line "Clean up: contextlanes delete <lane> --force --delete-branch, or: $0 --cleanup $q"
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
  if run_split 60 "$TMPD/all.json" docker exec -i "$CONTAINER" contextlanes list --json; then
    for id in $(jsq 'd.filter(l => l.task.startsWith(a[0])).map(l => l.id).join(" ")' "$TASK" <"$TMPD/all.json"); do
      if run 300 docker exec -i "$CONTAINER" contextlanes delete "$id" --force --delete-branch --json; then line "removed: lane $id (container, image, checkout with the check's files, lane branch)"
      else line "left: lane $id: delete failed (see the log)"; fi
    done
  fi
  if [ -e "$STATE/project-added" ] && run_split 30 "$TMPD/projects.json" docker exec -i "$CONTAINER" contextlanes projects --json; then
    local pid; pid="$(jsq '(d.find(p => p.path === a[0]) || {}).id || ""' "$P" <"$TMPD/projects.json")"
    [ -n "$pid" ] && run 30 docker exec -i "$CONTAINER" contextlanes remove "$pid" && line "removed: project $pid from ContextLanes (the folder is untouched)"
  fi
  if [ -e "$STATE/lanes-folder-made" ] && [ -d "$P.lanes" ] && [ -z "$(ls -A "$P.lanes" 2>/dev/null)" ]; then
    rmdir "$P.lanes" && line "removed: empty $P.lanes"
  fi
  rm -f "$STATE/lanes" "$STATE/project-added" "$STATE/lanes-folder-made"
  rmdir "$STATE" 2>/dev/null || true
  line "left: the stack (running), $STACK/data, the image $IMAGE, and volumes this check did not make"
}

# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------
say "ContextLanes v4 phase 4 check ($MODE) $(date -Is)"
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
if passed 2; then check3; else skip_check 3 "A lane's recipe" "the control service is not ready"; fi
if [ -n "$A_NAME" ] && passed 3; then
  check4
  if passed 4; then check5; check6; check7; check8; check9; else for n in 5 6 7 8 9; do skip_check "$n" "(needs a running service from check 4)" "app start failed"; done; fi
  check10
else
  for n in 4 5 6 7 8 9 10; do skip_check "$n" "(needs the approved lane from check 3)" "no lane"; done
fi
check11
check12

say ""
say "== Summary =="
say "$(printf '%-6s %-70s %6s  %s' CHECK TITLE TIME RESULT)"
fails=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  say "$(printf '%-6s %-70s %5ss  %s' "$i" "${C_TITLE[$i]:-}" "${C_TIME[$i]:-0}" "${C_RESULT[$i]:-not run}")"
  case "${C_RESULT[$i]:-}" in PASS|MANUAL|SKIP*) ;; *) fails=$((fails + 1)) ;; esac
done
say ""
say "The stack is left running. If anything was left, clean up with: $0 --cleanup $(printf '%q' "$P")"
say "Paste the summary above and attach $LOG_NAME"
[ "$fails" -eq 0 ]
