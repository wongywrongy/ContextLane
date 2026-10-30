#!/bin/sh
set -eu
for command in node npm git tmux systemctl; do
  command -v "$command" >/dev/null 2>&1 || { echo "Install $command, then run this installer again." >&2; exit 1; }
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error("Node >=22.13 is required; Node 24 is recommended."); process.exit(1); }'
systemctl --user show-environment >/dev/null 2>&1 || { echo 'A running systemd user manager is required. Sign in through a normal user session and try again.' >&2; exit 1; }
contextlanes_root="${CONTEXTLANES_INSTALL_DIR:-$HOME/.local/share/contextlanes/app}"
if [ -e "$contextlanes_root" ]; then
  echo "Refusing to overwrite $contextlanes_root. Keep your existing checkout and follow README.md for a source install." >&2
  exit 1
fi
mkdir -p "$(dirname "$contextlanes_root")"
git clone --branch contextlanes --single-branch https://github.com/wongywrongy/rootlane.git "$contextlanes_root"
cd "$contextlanes_root"
npm exec --yes --package=pnpm@10.28.0 -- pnpm install --frozen-lockfile --ignore-scripts
npm exec --yes --package=pnpm@10.28.0 -- pnpm -r rebuild esbuild
if ! npm exec --yes --package=pnpm@10.28.0 -- pnpm --filter @contextlanes/daemon rebuild node-pty; then
  echo 'Native terminal build unavailable. The daemon can run; install C++ build tools and rebuild node-pty to enable terminals.' >&2
fi
npm exec --yes --package=pnpm@10.28.0 -- pnpm build
node apps/daemon/dist/install-main.js
contextlanes_attempt=0
until "$HOME/.local/bin/contextlanes" status >/dev/null 2>&1; do
  contextlanes_attempt=$((contextlanes_attempt + 1))
  [ "$contextlanes_attempt" -lt 20 ] || { echo 'Service did not start. Read: journalctl --user -u contextlanes -n 50' >&2; exit 1; }
  sleep 1
done
"$HOME/.local/bin/contextlanes" setup
