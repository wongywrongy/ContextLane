#!/bin/sh
# Installs ContextLanes, or updates an existing install to the newest version.
set -eu
for command in node npm git bwrap tmux systemctl python3; do
  command -v "$command" >/dev/null 2>&1 || { echo "Install $command, then run this installer again." >&2; exit 1; }
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error("Node >=22.13 is required; Node 24 is recommended."); process.exit(1); }'
systemctl --user show-environment >/dev/null 2>&1 || { echo 'A running systemd user manager is required. Sign in through a normal user session and try again.' >&2; exit 1; }
contextlanes_repo="${CONTEXTLANES_REPO:-https://github.com/wongywrongy/contextlane.git}"
contextlanes_branch="${CONTEXTLANES_BRANCH:-main}"
contextlanes_root="${CONTEXTLANES_INSTALL_DIR:-$HOME/.local/share/contextlanes/app}"
contextlanes_base="$(dirname "$contextlanes_root")"
pnpm_run() { npm exec --yes --package=pnpm@10.28.0 -- pnpm "$@"; }
build_here() {
  pnpm_run install --frozen-lockfile --ignore-scripts
  pnpm_run -r rebuild esbuild
  pnpm_run build
}

if [ -e "$contextlanes_root" ]; then
  if [ -e "$contextlanes_root/.git" ] && grep -qs '^# Installed by ContextLanes' "$HOME/.config/systemd/user/contextlanes.service"; then
    # An existing install: build the newest version beside it, then let the updater switch over.
    echo "ContextLanes is already installed in $contextlanes_root. Updating it; lanes keep running."
    case "$(git -C "$contextlanes_root" remote get-url origin)" in
      *wongywrongy/rootlane*) git -C "$contextlanes_root" remote set-url origin "$contextlanes_repo" ;;
    esac
    git -C "$contextlanes_root" fetch --prune --quiet origin '+refs/heads/*:refs/remotes/origin/*'
    sha="$(git -C "$contextlanes_root" rev-parse --verify "refs/remotes/origin/$contextlanes_branch")"
    release="$contextlanes_base/releases/$(printf %s "$sha" | cut -c1-12)"
    if [ ! -f "$release/.contextlanes-built" ]; then
      git -C "$contextlanes_root" worktree remove --force "$release" 2>/dev/null || true
      git -C "$contextlanes_root" worktree prune
      mkdir -p "$contextlanes_base/releases"
      git -C "$contextlanes_root" worktree add --detach --quiet "$release" "$sha"
      (cd "$release" && build_here)
      printf '{"sha":"%s"}\n' "$sha" > "$release/.contextlanes-built"
    fi
    exec node "$release/apps/daemon/dist/update-main.js" --adopt "$release"
  fi
  echo "Refusing to overwrite $contextlanes_root. Keep your existing checkout and follow README.md for a source install." >&2
  exit 1
fi
mkdir -p "$contextlanes_base"
git clone --branch "$contextlanes_branch" "$contextlanes_repo" "$contextlanes_root"
cd "$contextlanes_root"
build_here
CONTEXTLANES_MANAGED=1 node apps/daemon/dist/install-main.js
contextlanes_attempt=0
until "$HOME/.local/bin/contextlanes" status >/dev/null 2>&1; do
  contextlanes_attempt=$((contextlanes_attempt + 1))
  [ "$contextlanes_attempt" -lt 20 ] || { echo 'Service did not start. Read: journalctl --user -u contextlanes -n 50' >&2; exit 1; }
  sleep 1
done
"$HOME/.local/bin/contextlanes" setup
