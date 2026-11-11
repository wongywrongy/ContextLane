#!/bin/sh
# The docker driver's unit helper (apps/daemon/src/supervisor/docker.ts). Run inside a lane container as
#   sh -c "$(cat unit.sh)" contextlanes-unit <action> ...
# so nothing has to be installed in the image. POSIX sh only.
# UNVERIFIED: setsid (util-linux) and GNU date -r are in every glibc image a project uses; Debian and Ubuntu images have both.
# shellcheck disable=SC2086  # set -- $r splits /proc/<pid>/stat into fields on purpose
set -u
U="$CL_UNITS"
action="$1"; shift
starttime() { s=$(cat "/proc/$1/stat" 2>/dev/null) || return 1; r=${s##*\) }; set -- $r; shift 19; echo "$1"; }
running() { [ -n "$1" ] && [ "$(starttime "$1")" = "$2" ]; }
members() { pg="$1"; for d in /proc/[0-9]*; do s=$(cat "$d/stat" 2>/dev/null) || continue; r=${s##*\) }; set -- $r; [ "$3" = "$pg" ] && echo "${d#/proc/}"; done; return 0; }
current() { pid=""; st=""; [ -r "$1/pid" ] && read -r pid st < "$1/pid"; return 0; }
case "$action" in
start)
  unit="$1"; restart="$2"; shift 2
  d="$U/$unit"; mkdir -p "$d" || exit 1
  rm -f "$d/stopping"
  if [ "$restart" = 1 ]; then : > "$d/restart"; else rm -f "$d/restart"; fi
  echo "$$ $(starttime $$)" > "$d/loop"
  while [ -d "$d" ] && [ ! -f "$d/stopping" ]; do
    if [ -f "$d/log" ] && [ "$(wc -c < "$d/log")" -gt 5242880 ]; then mv -f "$d/log" "$d/log.1"; fi
    setsid "$@" >> "$d/log" 2>&1 < /dev/null &
    pid=$!
    echo "$pid $(starttime "$pid")" > "$d/pid.new" && mv -f "$d/pid.new" "$d/pid"
    wait "$pid"
    [ -f "$d/restart" ] && [ ! -f "$d/stopping" ] || break
    sleep 2
  done
  rm -f "$d/pid" "$d/loop" ;;
stop)
  d="$U/$1"; [ -d "$d" ] || exit 0
  : > "$d/stopping"; rm -f "$d/restart"
  current "$d"
  if running "$pid" "$st"; then
    kill -s TERM -- "-$pid" 2>/dev/null
    i=0; while [ "$i" -lt 50 ] && [ -n "$(members "$pid")" ]; do sleep 0.1; i=$((i + 1)); done
    kill -s KILL -- "-$pid" 2>/dev/null
  fi
  rm -rf -- "$d" ;;
status)
  d="$U/$1"; current "$d"
  if running "$pid" "$st"; then echo active; members "$pid"
  elif [ -r "$d/loop" ] && read -r lp lst < "$d/loop" && running "$lp" "$lst"; then echo restarting
  else echo inactive; fi ;;
logs)
  d="$U/$1"; [ -f "$d/log" ] || exit 0
  date -r "$d/log" +%s; tail -n "$2" "$d/log" ;;
list)
  [ -d "$U" ] && ls -1 "$U"; exit 0 ;;
oneshot)
  t="$1"; shift
  out=$(mktemp) || exit 1
  setsid "$@" > "$out" 2>&1 < /dev/null &
  pid=$!
  ( sleep "$t"; : > "$out.timeout"; kill -s KILL -- "-$pid" 2>/dev/null ) > /dev/null 2>&1 < /dev/null &
  w=$!
  wait "$pid"; code=$?
  kill "$w" 2>/dev/null
  kill -s KILL -- "-$pid" 2>/dev/null
  tail -c 8000 "$out"
  if [ -f "$out.timeout" ]; then printf '\nStopped after %s seconds.\n' "$t"; code=124; fi
  rm -f -- "$out" "$out.timeout"
  exit "$code" ;;
listeners)
  for p in "$@"; do for f in /proc/"$p"/fd/*; do l=$(readlink "$f" 2>/dev/null) || continue; case "$l" in socket:*) echo "$l" ;; esac; done; done
  echo ---
  cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; exit 0 ;;
*) echo "unknown action $action" >&2; exit 2 ;;
esac
