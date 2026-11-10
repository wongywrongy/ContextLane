#!/bin/sh
# Runs cl inside the container from the folder the host command was run in. Folders are mounted at the
# same path inside and out, so "the project here" means the same thing in both. A folder the container
# cannot see is passed on by name, so cl can say so instead of acting on the wrong folder.
export HOME="${CONTEXTLANES_DATA:-/data}/home"
if [ -n "${CL_CWD:-}" ] && cd "$CL_CWD" 2>/dev/null; then :; else
  [ -n "${CL_CWD:-}" ] && export CONTEXTLANES_UNMOUNTED="$CL_CWD"
  cd "$HOME"
fi
unset CL_CWD
exec cl "$@"
