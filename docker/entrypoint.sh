#!/bin/sh
# Starts ContextLanes in the container as the user who owns your code on the host.
#   PUID / PGID   that user's ids (id -u, id -g), so files written in your folders stay yours
#   /data         everything ContextLanes keeps: settings, database, agent logins
# Settings are written to /data/config.toml on the first start only. After that the file is yours.
set -eu

DATA="${CONTEXTLANES_DATA:-/data}"
CONFIG="${CONTEXTLANES_CONFIG:-$DATA/config.toml}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
APP="${CONTEXTLANES_APP:-/opt/contextlanes}"

mkdir -p "$DATA/home" "$DATA/state"

if [ ! -f "$CONFIG" ]; then
  code="${CONTEXTLANES_CODE:?Set CONTEXTLANES_CODE in .env to the folder that holds your repositories}"
  lanes="${CONTEXTLANES_LANES:?Set CONTEXTLANES_LANES in .env to the folder lane checkouts go in}"
  case "${CONTEXTLANES_SANDBOX:-bwrap}" in bwrap|off) ;; *) echo "CONTEXTLANES_SANDBOX must be bwrap or off." >&2; exit 1 ;; esac
  {
    printf '# Written once by the container on its first start. Edit it, then: docker compose restart\n'
    printf '[host]\nname = "%s"\n\n' "${CONTEXTLANES_NAME:-docker}"
    printf '[paths]\ndata = "%s"\nlanes = "%s"\ncode = "%s"\n\n' "$DATA/state" "$lanes" "$code"
    printf '[previews]\nmode = "router"\nbind = "0.0.0.0"\nlocalPort = 4601\n'
    [ -n "${CONTEXTLANES_DOMAIN:-}" ] && printf 'domain = "%s"\n' "$CONTEXTLANES_DOMAIN"
    printf '\n[supervisor]\ndriver = "process"\n\n'
    printf '[sandbox]\nmode = "%s"\n' "${CONTEXTLANES_SANDBOX:-bwrap}"
  } > "$CONFIG"
  echo "Wrote $CONFIG"
fi

export HOME="$DATA/home" CONTEXTLANES_CONFIG="$CONFIG" CONTEXTLANES_DOCKER=1
cd "$HOME"

# Already the right user (or told to run as root): start as we are.
if [ "$(id -u)" != 0 ] || [ "$PUID" = 0 ]; then
  [ "$(id -u)" = 0 ] && echo "PUID is 0: ContextLanes and its agents run as root in this container." >&2
  exec node "$APP/apps/daemon/dist/main.js"
fi

# A user "cl" with the host's ids, so git, tmux and ssh find a name and a home for it.
if getent group cl >/dev/null; then groupmod -o -g "$PGID" cl; else groupadd -o -g "$PGID" cl; fi
if getent passwd cl >/dev/null; then usermod -o -u "$PUID" -g cl -d "$HOME" cl; else useradd -o -u "$PUID" -g cl -d "$HOME" -M -s /bin/bash cl; fi
chown cl:cl "$DATA" "$DATA/home" "$DATA/state" "$CONFIG"
[ -d "$DATA/mise" ] || { mkdir -p "$DATA/mise"; chown cl:cl "$DATA/mise"; }

exec setpriv --reuid cl --regid cl --init-groups env USER=cl LOGNAME=cl node "$APP/apps/daemon/dist/main.js"
