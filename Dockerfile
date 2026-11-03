# The Web UI is static output: build it once on the build host, also
# for multi-arch images.
FROM --platform=$BUILDPLATFORM node:24-slim AS web

WORKDIR /app

COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

COPY src ./src
COPY web ./web
RUN npm --prefix web run build

# Runtime dependencies include native modules (argon2, onnxruntime):
# installed for the target platform.
FROM node:24-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
# Optional dependencies (the agentOS runner's VM runtime) are left out
# unless built with --build-arg INSTALL_OPTIONAL=true.
ARG INSTALL_OPTIONAL=false
RUN if [ "$INSTALL_OPTIONAL" = "true" ]; then npm ci --omit=dev; else npm ci --omit=dev --omit=optional; fi

FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=5173

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY brainstem.mjs brainstem-api.mjs brainstem.config.example.mjs .env.example README.md LICENSE CHANGELOG.md ./
COPY src ./src
COPY plugins ./plugins
COPY docs ./docs
COPY web/server.mjs web/package.json ./web/
COPY --from=web /app/web/dist ./web/dist

# The runtime never uses npm or yarn: drop them (and their vulnerable bundled
# dependencies) from the final image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

RUN mkdir -p /app/data \
  && chown -R node:node /app \
  && chmod +x /app/brainstem.mjs /app/brainstem-api.mjs

USER node

VOLUME ["/app/data"]
EXPOSE 5173

CMD ["node", "brainstem.mjs"]
