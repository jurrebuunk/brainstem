# Docker

Brainstem publishes Docker images to GitHub Container Registry:

```text
ghcr.io/jurrebuunk/brainstem
```

Current prerelease image:

```text
ghcr.io/jurrebuunk/brainstem:v0.1.0-alpha.5
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

The example Compose file starts the runtime with the backend API enabled. The Web UI is presentation-only and proxies `/api/*` to `http://brainstem:5174`.

Start:

```sh
docker compose up -d
```

Open the Web UI locally:

```text
http://127.0.0.1:5173
```

The example compose file binds the Web UI to `127.0.0.1` only. If you expose it remotely, put it behind authentication/TLS because Settings → Config can edit `brainstem.config.mjs`.

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
  ghcr.io/jurrebuunk/brainstem:v0.1.0-alpha.5 \
  node brainstem.mjs --once
```

Run continuously with the backend API enabled:

```sh
docker run -d \
  --name brainstem \
  --restart unless-stopped \
  --env-file .env \
  -e BRAINSTEM_API=1 \
  -e BRAINSTEM_API_HOST=0.0.0.0 \
  -e BRAINSTEM_API_PORT=5174 \
  -v "$PWD/brainstem.config.mjs:/app/brainstem.config.mjs" \
  -v brainstem-data:/app/data \
  ghcr.io/jurrebuunk/brainstem:v0.1.0-alpha.5
```

Run the Web UI container separately:

```sh
docker run -d \
  --name brainstem-web \
  --restart unless-stopped \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -e PORT=5173 \
  -e WEB_BACKEND_URL=http://brainstem:5174 \
  -p 127.0.0.1:5173:5173 \
  ghcr.io/jurrebuunk/brainstem:v0.1.0-alpha.5 \
  node web/server.mjs
```

View logs:

```sh
docker logs -f brainstem
docker logs -f brainstem-web
```

## Docker Compose

The included `docker-compose.example.yml` defines:

- `brainstem` — headless runtime plus backend API, owns telemetry/history/stats/config management
- `brainstem-web` — presentation-only Web UI, proxies API calls to `brainstem`
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

## Backend API and Web UI runtime environment

Backend API variables:

```text
BRAINSTEM_API              set 1/true to start the backend API with the runtime
BRAINSTEM_API_HOST         default 127.0.0.1
BRAINSTEM_API_PORT         default 5174
BRAINSTEM_API_DB           telemetry/stats SQLite path; default data/web-stats.sqlite
BRAINSTEM_API_TOKEN        optional bearer token for API routes except /api/health
BRAINSTEM_CONFIG           editable config path; default brainstem.config.mjs
MAX_EVENTS                 live in-memory SSE safety buffer; default 2000
MAX_BODY_BYTES             request body cap; default 1048576
STATS_PRUNE_AFTER_DAYS     stats time-series retention; default 14; set 0 to disable
WEB_EVENTS_PRUNE_AFTER_DAYS event-log retention; default 14; set 0 to disable time pruning
WEB_EVENTS_MAX_ROWS        event-log row cap; default 50000; set 0 to disable row pruning
```

Web UI variables:

```text
HOST                       default 127.0.0.1 locally, 0.0.0.0 in Dockerfile
PORT                       default 5173
WEB_BACKEND_URL            backend API base URL; default http://127.0.0.1:5174
WEB_BACKEND_TOKEN          optional bearer token forwarded to backend API
```

Config saves are owned by the backend API, syntax-checked with `node --check`, written atomically, and backed up as timestamped `.bak` files next to the config.

## Verify published image

```sh
docker manifest inspect ghcr.io/jurrebuunk/brainstem:v0.1.0-alpha.5
```

Pull explicitly:

```sh
docker pull ghcr.io/jurrebuunk/brainstem:v0.1.0-alpha.5
```

## Build locally

```sh
docker build -t brainstem:local .
```

Run the runtime:

```sh
docker run --rm brainstem:local node brainstem.mjs --help
```

Run the backend API and Web UI from the local image:

```sh
docker run --rm -p 127.0.0.1:5174:5174 -e BRAINSTEM_API_HOST=0.0.0.0 brainstem:local node brainstem-api.mjs
docker run --rm -p 127.0.0.1:5173:5173 -e WEB_BACKEND_URL=http://host.docker.internal:5174 brainstem:local node web/server.mjs
```

## Published tags

The GitHub Actions workflow publishes:

- `latest` from `main`
- branch tags such as `main`
- git tags such as `v0.1.0-alpha.5`
- SHA tags such as `sha-...`

If the package is not visible in the GitHub UI immediately, verify with `docker manifest inspect`; GHCR package pages can lag behind successful pushes.
