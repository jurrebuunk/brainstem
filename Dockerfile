FROM node:24-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
# Optional dependencies (the agentOS runner's VM runtime) are left out
# unless built with --build-arg INSTALL_OPTIONAL=true.
ARG INSTALL_OPTIONAL=false
RUN if [ "$INSTALL_OPTIONAL" = "true" ]; then npm ci --omit=dev; else npm ci --omit=dev --omit=optional; fi

COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

COPY src ./src
COPY web ./web
RUN npm --prefix web run build

FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=5173

COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY brainstem.mjs brainstem-api.mjs brainstem.config.example.mjs .env.example README.md LICENSE CHANGELOG.md ./
COPY src ./src
COPY plugins ./plugins
COPY docs ./docs
COPY web/server.mjs web/package.json ./web/
COPY --from=build /app/web/dist ./web/dist

RUN mkdir -p /app/data \
  && chown -R node:node /app \
  && chmod +x /app/brainstem.mjs /app/brainstem-api.mjs

USER node

VOLUME ["/app/data"]
EXPOSE 5173

CMD ["node", "brainstem.mjs"]
