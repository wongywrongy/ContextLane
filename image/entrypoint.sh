#!/bin/sh
# Starts the ContextLanes control service. Runs as root in its container: it holds the Docker socket,
# which is root-equivalent on the host anyway, and writes only to /data (the stack's ./data).
set -eu

TOOLS_IMAGE=/opt/contextlanes-tools
TOOLS_VOLUME=/var/lib/contextlanes-tools
MARKER=.version

mkdir -p /data /data/home
chmod 0700 /data

# Fill the tools volume when it is empty or holds other versions. The marker is copied last, so a start
# that is cut off halfway fills it again next time.
want=$(cat "$TOOLS_IMAGE/$MARKER")
have=$(cat "$TOOLS_VOLUME/$MARKER" 2>/dev/null || true)
if [ -d "$TOOLS_VOLUME" ] && [ "$have" != "$want" ]; then
  echo "Filling the tools volume: ${have:-empty} -> $want"
  find "$TOOLS_VOLUME" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  for entry in "$TOOLS_IMAGE"/* ; do cp -a -- "$entry" "$TOOLS_VOLUME/"; done
  cp -a -- "$TOOLS_IMAGE/$MARKER" "$TOOLS_VOLUME/$MARKER"
fi

exec node /opt/contextlanes/apps/daemon/dist/main.js
