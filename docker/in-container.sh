#!/bin/sh
# Runs cl inside the container from the folder the host command was run in. Folders are mounted at the
# same path inside and out, so "the project here" means the same thing in both.
export HOME="${CONTEXTLANES_DATA:-/data}/home"
cd "${CL_CWD:-$HOME}" 2>/dev/null || cd "$HOME"
unset CL_CWD
exec cl "$@"
