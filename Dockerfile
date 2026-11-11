# ContextLanes v4 control service (docs/V4.md section 3.1). Built by compose.yaml: docker compose up -d --build
#
# One image for three jobs: the control service (daemon, CLI, web page), the helper containers that run
# git on one project folder at a time, and the source of the tools volume that lanes mount read-only.
# Versions below are the ones scripts/v4-spike/v4-spike.sh proved on a real machine (docs/V4.md 8b).
ARG NODE_IMAGE=node:24-bookworm
ARG ALPINE_IMAGE=alpine:3.22

# ---- static tmux, for lanes whose image has none ----
FROM ${ALPINE_IMAGE} AS tmux
ARG TMUX_VERSION=3.6a
RUN apk add --no-cache build-base bison curl file pkgconf \
      libevent-dev libevent-static ncurses-dev ncurses-static ncurses-terminfo-base
WORKDIR /src
RUN curl -fsSL -o tmux.tar.gz "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz" \
 && tar -xzf tmux.tar.gz \
 && cd "tmux-${TMUX_VERSION}" \
 && ./configure --enable-static --prefix=/opt/tmux \
 && make -j"$(nproc)" \
 && make install \
 && file -b /opt/tmux/bin/tmux | grep -Eq 'statically linked|static-pie linked'
RUN mkdir -p /opt/terminfo \
 && for d in /etc/terminfo /usr/share/terminfo; do if [ -d "$d" ]; then cp -a "$d/." /opt/terminfo/; fi; done

# ---- the ContextLanes workspace, built ----
FROM ${NODE_IMAGE} AS app
# UNVERIFIED: the workspace build has not been run in this exact image; the steps are the v3 Dockerfile's.
ARG PNPM_VERSION=10.28.0
WORKDIR /opt/contextlanes
COPY . .
RUN npm exec --yes --package=pnpm@${PNPM_VERSION} -- pnpm install --frozen-lockfile --ignore-scripts \
 && npm exec --yes --package=pnpm@${PNPM_VERSION} -- pnpm -r rebuild esbuild \
 && npm exec --yes --package=pnpm@${PNPM_VERSION} -- pnpm build \
 && rm -rf /root/.npm /root/.cache

# ---- the control image ----
FROM ${NODE_IMAGE}
ARG DOCKER_APT_SUITE=bookworm
ARG DEVCONTAINERS_CLI_VERSION=0.90.0
ARG CLAUDE_CODE_VERSION=2.1.314
ARG CODEX_VERSION=0.166.0
ARG TMUX_VERSION=3.6a
ARG CONTEXTLANES_VERSION=docker

# git for the helpers; the Docker CLI (with buildx and compose, which the Dev Container CLI uses) to talk
# to the host's Docker through the socket.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg git file \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${DOCKER_APT_SUITE} stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@devcontainers/cli@${DEVCONTAINERS_CLI_VERSION}" && devcontainer --version && npm cache clean --force

# The tools lanes get (docs/V4.md 3.3): static tmux, a Node runtime, Claude Code and Codex. Copied into the
# contextlanes-tools volume at start; the marker says which versions are inside.
RUN mkdir -p /opt/contextlanes-tools/bin /opt/contextlanes-tools/libexec /opt/contextlanes-tools/node/bin /opt/contextlanes-tools/share \
 && cp /usr/local/bin/node /opt/contextlanes-tools/node/bin/node
COPY --from=tmux /opt/tmux/bin/tmux /opt/contextlanes-tools/libexec/tmux
COPY --from=tmux /opt/terminfo /opt/contextlanes-tools/share/terminfo
RUN npm install --global --prefix /opt/contextlanes-tools/agents "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force
COPY image/mkwrappers.sh /usr/local/lib/contextlanes/mkwrappers.sh
RUN sh /usr/local/lib/contextlanes/mkwrappers.sh /opt/contextlanes-tools \
 && printf 'tmux=%s node=%s claude-code=%s codex=%s layout=1\n' "${TMUX_VERSION}" "$(node --version)" "${CLAUDE_CODE_VERSION}" "${CODEX_VERSION}" > /opt/contextlanes-tools/.version \
 && cat /opt/contextlanes-tools/.version

COPY --from=app /opt/contextlanes /opt/contextlanes
COPY image/entrypoint.sh /usr/local/lib/contextlanes/entrypoint.sh
RUN printf '#!/bin/sh\nexec node /opt/contextlanes/apps/cli/dist/main.js "$@"\n' > /usr/local/bin/contextlanes \
 && chmod 755 /usr/local/bin/contextlanes /usr/local/lib/contextlanes/entrypoint.sh

# CONTEXTLANES_RUNTIME=docker is what makes the daemon the v4 control service (apps/daemon/src/config.ts).
ENV CONTEXTLANES_RUNTIME=docker \
    CONTEXTLANES_CONFIG=/data/config.toml \
    CONTEXTLANES_VERSION=${CONTEXTLANES_VERSION} \
    HOME=/data/home
WORKDIR /
EXPOSE 4601
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4600/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/local/lib/contextlanes/entrypoint.sh"]
