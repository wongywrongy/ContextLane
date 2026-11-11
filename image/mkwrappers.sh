#!/bin/sh
# Writes <tools>/bin/{tmux,node,claude,codex}. Each wrapper finds its own folder at run time, so the
# tools work wherever the volume is mounted (/opt/contextlanes in a lane). From scripts/v4-spike/v4-spike.sh.
set -eu
T="$1"
# shellcheck disable=SC2016  # the header is written into the wrappers and expands when they run
HDR='#!/bin/sh
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
root=$(dirname -- "$here")
PATH="$root/bin:$PATH"; export PATH
'
write() { printf '%s%s\n' "$HDR" "$2" >"$T/bin/$1"; chmod 0755 "$T/bin/$1"; }

# shellcheck disable=SC2016
write tmux 'TERMINFO_DIRS="$root/share/terminfo${TERMINFO_DIRS:+:$TERMINFO_DIRS}:/etc/terminfo:/lib/terminfo:/usr/share/terminfo"; export TERMINFO_DIRS
exec "$root/libexec/tmux" "$@"'
# shellcheck disable=SC2016
write node 'exec "$root/node/bin/node" "$@"'

agent() {
  name="$1"; extra="$2"
  target=$(readlink -f "$T/agents/bin/$name")
  rel=${target#"$T"/}
  [ -f "$T/$rel" ] || { echo "no target for $name: $target" >&2; exit 1; }
  magic=$(od -An -c -N4 "$T/$rel" | tr -d ' \n')
  if [ "$magic" = '177ELF' ]; then
    # shellcheck disable=SC2016
    write "$name" "$extra$(printf 'exec "$root/%s" "$@"' "$rel")"
  else
    # shellcheck disable=SC2016
    write "$name" "$extra$(printf 'exec "$root/node/bin/node" "$root/%s" "$@"' "$rel")"
  fi
  echo "$name -> $rel ($magic)"
}
agent claude 'DISABLE_AUTOUPDATER=1; export DISABLE_AUTOUPDATER
'
agent codex ''
