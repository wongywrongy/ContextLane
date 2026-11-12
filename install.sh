#!/bin/sh
# Installs ContextLanes, or updates an existing install to the newest version.
set -eu
for command in node npm git bwrap tmux systemctl python3; do
  command -v "$command" >/dev/null 2>&1 || { echo "Install $command, then run this installer again." >&2; exit 1; }
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error("Node >=22.13 is required; Node 24 is recommended."); process.exit(1); }'
systemctl --user show-environment >/dev/null 2>&1 || { echo 'A running systemd user manager is required. Sign in through a normal user session and try again.' >&2; exit 1; }
contextlanes_repo="${CONTEXTLANES_REPO:-https://github.com/wongywrongy/ContextLane.git}"
contextlanes_branch="${CONTEXTLANES_BRANCH:-main}"
contextlanes_root="${CONTEXTLANES_INSTALL_DIR:-$HOME/.local/share/contextlanes/app}"
contextlanes_base="$(dirname "$contextlanes_root")"
case "$contextlanes_root" in
  /*/app) ;;
  *) echo 'CONTEXTLANES_INSTALL_DIR must be an absolute path ending in /app.' >&2; exit 1 ;;
esac
contextlanes_pending="$contextlanes_base/.contextlanes-installing"
# Do not infer that shared worktrees are gone during installation or update.
git_run() { git -c gc.auto=0 -c maintenance.auto=false -c gc.worktreePruneExpire=never "$@"; }
pnpm_run() { npm exec --yes --package=pnpm@10.28.0 -- pnpm "$@"; }
build_here() {
  pnpm_run install --frozen-lockfile --ignore-scripts
  pnpm_run -r rebuild esbuild
  pnpm_run build
}

if [ -e "$contextlanes_root" ]; then
  if [ -f "$contextlanes_pending" ] && [ "$(cat "$contextlanes_pending")" = "$contextlanes_root" ] && [ -e "$contextlanes_root/.git" ]; then
    [ -z "$(git_run -C "$contextlanes_root" status --porcelain --untracked-files=no)" ] || { echo 'The interrupted install has local edits. Preserve them before retrying.' >&2; exit 1; }
    echo "Resuming the interrupted install in $contextlanes_root."
  elif [ -e "$contextlanes_root/.git" ] && grep -qs '^# Installed by ContextLanes' "$HOME/.config/systemd/user/contextlanes.service"; then
    # One updater owns locking, build, backup, switch and recovery. Preserve its saved channel.
    release="$contextlanes_base/current"
    [ -e "$release" ] || release="$contextlanes_root"
    echo "ContextLanes is already installed. Running its supported updater."
    if [ -n "${CONTEXTLANES_BRANCH:-}" ]; then
      exec node "$release/apps/daemon/dist/update-main.js" --branch "$CONTEXTLANES_BRANCH"
    fi
    exec node "$release/apps/daemon/dist/update-main.js"
  else
    echo "Refusing to overwrite $contextlanes_root. For a source checkout, see docs/DEVELOPING.md." >&2
    exit 1
  fi
else
  mkdir -p "$contextlanes_base"
  git_run clone --branch "$contextlanes_branch" "$contextlanes_repo" "$contextlanes_root"
  (umask 077; printf '%s\n' "$contextlanes_root" > "$contextlanes_pending")
fi
cd "$contextlanes_root"
sha="$(git_run rev-parse HEAD)"
build_here
if [ "$(git_run rev-parse HEAD)" != "$sha" ] || [ -n "$(git_run status --porcelain --untracked-files=no)" ]; then
  echo 'The build changed tracked source or HEAD. Preserve the checkout and investigate before installing.' >&2
  exit 1
fi
printf '{"sha":"%s"}\n' "$sha" > .contextlanes-built
# A retried installation follows the branch actually cloned, even if the shell lost its override.
CONTEXTLANES_BRANCH="$(git_run symbolic-ref --short HEAD)" CONTEXTLANES_MANAGED=1 node apps/daemon/dist/install-main.js
contextlanes_attempt=0
until "$HOME/.local/bin/contextlanes" status >/dev/null 2>&1; do
  contextlanes_attempt=$((contextlanes_attempt + 1))
  [ "$contextlanes_attempt" -lt 20 ] || { echo 'Service did not start. Read: journalctl --user -u contextlanes -n 50' >&2; exit 1; }
  sleep 1
done
rm -f "$contextlanes_pending"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo 'Add ~/.local/bin to PATH in your shell profile: export PATH="$HOME/.local/bin:$PATH"' ;;
esac
if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != yes ]; then
  echo 'To keep the service running after logout: sudo loginctl enable-linger "$(id -un)"'
fi
"$HOME/.local/bin/contextlanes" setup
