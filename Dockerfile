FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY brainstem.mjs brainstem.config.example.mjs .env.example README.md LICENSE CHANGELOG.md ./
COPY src ./src
COPY plugins ./plugins
COPY docs ./docs

RUN mkdir -p /app/data \
  && chown -R node:node /app \
  && chmod +x /app/brainstem.mjs

USER node

VOLUME ["/app/data"]

CMD ["node", "brainstem.mjs"]
