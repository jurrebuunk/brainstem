# Docker

Brainstem publishes Docker images to GitHub Container Registry:

```text
ghcr.io/jurrebuunk/brainstem
```

Current prerelease image:

```text
ghcr.io/jurrebuunk/brainstem:v0.1.0-alpha.2
```

The image contains both:

- the headless Brainstem runtime (`node brainstem.mjs`)
- the production Web UI server (`node web/server.mjs`)

Use separate containers for runtime and Web UI in production. This keeps the decision loop isolated from the UI/config editor while still sharing the same image and data volume.

## Quick production template

Create local config and environment files:

```sh
cp brainstem.config.example.mjs brainstem.config.mjs
cp .env.example .env
cp docker-compose.example.yml docker-compose.yml
```

For Compose, configure telemetry URLs inside `brainstem.config.mjs` to use the service name, not localhost:

```js
runtime: {
  telemetry: {
    url: "http://brainstem-web:5173/api/events",
    snapshotIntervalMs: 5000
  }
}
```

If using the HTTP JSON destination for Web UI output envelopes, use:

```js
config: {
  url: "http://brainstem-web:5173/api/events"
}
```

Start:

```sh
docker compose up -d
```

Open the Web UI locally:

```text
http://127.0.0.1:5173
```

The example compose file binds the Web UI to `127.0.0.1` only. If you expose it remotely, put it behind authentication/TLS because the Config page can edit `brainstem.config.mjs`.

## Run with Docker directly

Create local config and environment files:

```sh
cp brainstem.config.example.mjs brainstem.config.mjs
cp .env.example .env
```

Run once:

```sh
docker run --rm \
  --env-file .env \
  -v "$PWD/brainstem.config.mjs:/app/brainstem.config.mjs:ro" \
  -v brainstem-data:/app/data \
  ghcr.io/jurrebuunk/brainstem:v0.1.0-alpha.2 \
  node brainstem.mjs --once
```

Run continuously:

```sh
docker run -d \
  --name brainstem \
  --restart unless-stopped \
  --env-file .env \
  -v "$PWD/brainstem.config.mjs:/app/brainstem.config.mjs:ro" \
  -v brainstem-data:/app/data \
  ghcr.io/jurrebuunk/brainstem:v0.1.0-alpha.2
```

Run the Web UI container:

```sh
docker run -d \
  --name brainstem-web \
  --restart unless-stopped \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -e PORT=5173 \
  -e BRAINSTEM_CONFIG=/app/brainstem.config.mjs \
  -e WEB_STATS_DB=/app/data/web-stats.sqlite \
  -p 127.0.0.1:5173:5173 \
  -v "$PWD/brainstem.config.mjs:/app/brainstem.config.mjs" \
  -v brainstem-data:/app/data \
  ghcr.io/jurrebuunk/brainstem:v0.1.0-alpha.2 \
  node web/server.mjs
```

View logs:

```sh
docker logs -f brainstem
docker logs -f brainstem-web
```

## Docker Compose

The included `docker-compose.example.yml` defines:

- `brainstem` — headless runtime, config mounted read-only
- `brainstem-web` — Web UI/stats/config editor, config mounted writable
- `brainstem-data` — shared persistent data volume

Commands:

```sh
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
docker compose logs -f
```

Run a one-shot poll for testing:

```sh
docker compose run --rm brainstem node brainstem.mjs --once --all
```

Stop:

```sh
docker compose down
```

## Volumes

Mount these paths:

```text
/app/brainstem.config.mjs  local config file
/app/data                  SQLite records, checkpoints, notification state, Web UI stats
```

Recommended production layout:

```text
./brainstem.config.mjs   checked locally, mounted into containers
./.env                   secrets, never committed
brainstem-data volume    runtime state
```

Do not bake secrets into the image. Use `.env`, environment variables, or your orchestrator's secret store.

## Web UI runtime environment

The Web UI server supports:

```text
HOST                       default 127.0.0.1 locally, 0.0.0.0 in Dockerfile
PORT                       default 5173
BRAINSTEM_CONFIG           editable config path; default /app/brainstem.config.mjs in Docker
WEB_STATS_DB               stats SQLite path; default data/web-stats.sqlite
MAX_EVENTS                 in-memory event buffer; default 2000
MAX_BODY_BYTES             request body cap; default 1048576
STATS_PRUNE_AFTER_DAYS     stats time-series retention; default 14
```

Config saves are syntax-checked with `node --check`, written atomically, and backed up as timestamped `.bak` files next to the config.

## Verify published image

```sh
docker manifest inspect ghcr.io/jurrebuunk/brainstem:v0.1.0-alpha.2
```

Pull explicitly:

```sh
docker pull ghcr.io/jurrebuunk/brainstem:v0.1.0-alpha.2
```

## Build locally

```sh
docker build -t brainstem:local .
```

Run the runtime:

```sh
docker run --rm brainstem:local node brainstem.mjs --help
```

Run the Web UI from the local image:

```sh
docker run --rm -p 127.0.0.1:5173:5173 brainstem:local node web/server.mjs
```

## Published tags

The GitHub Actions workflow publishes:

- `latest` from `main`
- branch tags such as `main`
- git tags such as `v0.1.0-alpha.2`
- SHA tags such as `sha-...`

If the package is not visible in the GitHub UI immediately, verify with `docker manifest inspect`; GHCR package pages can lag behind successful pushes.
