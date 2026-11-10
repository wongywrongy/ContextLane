# ContextLanes in one container: the daemon, tmux, the cl command and the agents' CLIs.
# Extend it for your own toolchains:  FROM <this image>  then RUN apt-get install … (see docs/DOCKER.md).
FROM node:24-bookworm

# What lanes need: git worktrees, tmux terminals, the sandbox, and the usual tools an agent reaches for.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git tmux python3 python3-venv bubblewrap build-essential curl ca-certificates openssh-client \
      less procps iproute2 jq ripgrep gh util-linux \
    && rm -rf /var/lib/apt/lists/* \
    # The image's own "node" user would collide with PUID 1000; the entrypoint makes the user it runs as.
    && userdel -r node

# mise reads a project's own .tool-versions, .nvmrc, .python-version or mise.toml, so a lane gets the
# versions its repository asks for without rebuilding this image. Pin with --build-arg MISE_VERSION=v…
ARG MISE_VERSION=
RUN curl -fsSL https://mise.run | MISE_VERSION="${MISE_VERSION}" MISE_INSTALL_PATH=/usr/local/bin/mise sh \
    && printf 'eval "$(mise activate bash)"\n' > /etc/profile.d/mise.sh

WORKDIR /opt/contextlanes
COPY . .
# The same steps as install.sh, so both installs run the same build.
RUN npm exec --yes --package=pnpm@10.28.0 -- pnpm install --frozen-lockfile --ignore-scripts \
    && npm exec --yes --package=pnpm@10.28.0 -- pnpm -r rebuild esbuild \
    && npm exec --yes --package=pnpm@10.28.0 -- pnpm build \
    # Claude Code and Codex at the versions this release was tested with (packages/protocol/src/agents.ts).
    && npm install --global $(node docker/agent-packages.mjs) \
    && npm cache clean --force \
    && for pair in cl:apps/cli contextlanes:apps/cli contextlanes-lanehost:apps/lanehost contextlanes-toolbox:packages/toolbox; do \
         printf '#!/bin/sh\nexec node /opt/contextlanes/%s/dist/main.js "$@"\n' "${pair#*:}" > "/usr/local/bin/${pair%%:*}"; \
         chmod 755 "/usr/local/bin/${pair%%:*}"; \
       done \
    && chmod 755 docker/entrypoint.sh docker/in-container.sh docker/cl

ARG CONTEXTLANES_VERSION=docker
ENV CONTEXTLANES_VERSION=${CONTEXTLANES_VERSION} \
    CONTEXTLANES_DOCKER=1 \
    CONTEXTLANES_CONFIG=/data/config.toml \
    MISE_DATA_DIR=/data/mise \
    PATH=/data/mise/shims:$PATH

VOLUME /data
EXPOSE 4601
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4600/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["/opt/contextlanes/docker/entrypoint.sh"]
