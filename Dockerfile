FROM node:24-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

COPY web ./web
RUN npm --prefix web run build

FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=5173

COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY brainstem.mjs brainstem.config.example.mjs .env.example README.md LICENSE CHANGELOG.md ./
COPY src ./src
COPY plugins ./plugins
COPY docs ./docs
COPY web/server.mjs web/package.json ./web/
COPY --from=build /app/web/dist ./web/dist

RUN mkdir -p /app/data \
  && chown -R node:node /app \
  && chmod +x /app/brainstem.mjs

USER node

VOLUME ["/app/data"]
EXPOSE 5173

CMD ["node", "brainstem.mjs"]
