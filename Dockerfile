FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm_config_nodedir=/usr/local npm ci --omit=dev && npm cache clean --force

FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git iproute2 systemd util-linux && rm -rf /var/lib/apt/lists/*
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY dist ./dist
COPY deploy/serve.mjs ./deploy/serve.mjs
ARG ROOTLANE_REVISION=unknown
LABEL org.opencontainers.image.version="0.9.0" org.opencontainers.image.revision=$ROOTLANE_REVISION
USER 1000:1000
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
