# Docker

Brainstem publishes Docker images to GitHub Container Registry:

```text
ghcr.io/jurrebuunk/brainstem
```

Current stable image:

```text
ghcr.io/jurrebuunk/brainstem:v0.1.0
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

The example compose file binds the Web UI to `127.0.0.1` only. Brainstem provides first-run admin setup, session auth, CSRF, and RBAC; if you expose it remotely, serve it over TLS and set `BRAINSTEM_COOKIE_SECURE=true`.

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
  ghcr.io/jurrebuunk/brainstem:v0.1.0 \
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
  ghcr.io/jurrebuunk/brainstem:v0.1.0
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
  ghcr.io/jurrebuunk/brainstem:v0.1.0 \
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
- `brainstem-data` — shared persistent data volume (holds the default SQLite database)
- `postgres` — optional, commented out; see [Database](#database)

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
/app/data                  SQLite database (data/brainstem.sqlite), Laya model cache
```

## Database

All state (records, checkpoints, plugin state, telemetry, stats, auth) lives in one database, selected with `BRAINSTEM_DATABASE_URL`:

```text
BRAINSTEM_DATABASE_URL     default sqlite:data/brainstem.sqlite (inside the data volume)
                           or postgres://user:pass@host:5432/db
```

The single-node default needs nothing extra. To use Postgres, uncomment the `postgres` service, `depends_on` and `postgres-data` volume in `docker-compose.example.yml`, set `POSTGRES_PASSWORD` and `BRAINSTEM_DATABASE_URL` in `.env`, then:

```sh
docker compose up -d postgres
docker compose run --rm brainstem node brainstem.mjs migrate
docker compose up -d
```

Move existing SQLite state into Postgres (with Brainstem stopped):

```sh
docker compose stop brainstem
docker compose run --rm brainstem node brainstem.mjs migrate sqlite-to-pg \
  --from sqlite:data/brainstem.sqlite \
  --to "postgres://brainstem:$POSTGRES_PASSWORD@postgres:5432/brainstem"
```

### Upgrading a 1.x volume

1.x kept state in `data/brainstem.sqlite`, `data/web-stats.sqlite` and `data/checkpoints.json`. Back up the volume, stop the old containers, then import into the 2.0 database before starting 2.0:

```sh
docker compose run --rm brainstem node brainstem.mjs migrate import-v1 --data-dir data
```

The 1.x files are only read. See [State](state.md#upgrading-from-1x).

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
BRAINSTEM_DATABASE_URL     database for all state; default sqlite:data/brainstem.sqlite
BRAINSTEM_API_TOKEN        optional bearer token for machine telemetry ingestion/proxy calls
BRAINSTEM_CONFIG           editable config path; default brainstem.config.mjs
MAX_EVENTS                 live in-memory SSE safety buffer; default 2000
MAX_BODY_BYTES             request body cap; default 1048576
STATS_PRUNE_AFTER_DAYS     stats time-series retention; default 14; set 0 to disable
WEB_EVENTS_PRUNE_AFTER_DAYS event-log retention; default 14; set 0 to disable time pruning
WEB_EVENTS_MAX_ROWS        event-log row cap; default 50000; set 0 to disable row pruning
BRAINSTEM_COOKIE_SECURE    set true when serving browser sessions over HTTPS
```

Web UI variables:

```text
HOST                       default 127.0.0.1 locally, 0.0.0.0 in Dockerfile
PORT                       default 5173
WEB_BACKEND_URL            backend API base URL; default http://127.0.0.1:5174
WEB_BACKEND_TOKEN          optional bearer token forwarded to backend API
```

Config saves are owned by the backend API, syntax-checked with `node --check`, written atomically, and backed up as timestamped `.bak` files next to the config. The first Web UI visit creates the initial administrator; no default credentials are shipped.

## Verify published image

```sh
docker manifest inspect ghcr.io/jurrebuunk/brainstem:v0.1.0
```

Pull explicitly:

```sh
docker pull ghcr.io/jurrebuunk/brainstem:v0.1.0
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
- git tags such as `v0.1.0`
- SHA tags such as `sha-...`

If the package is not visible in the GitHub UI immediately, verify with `docker manifest inspect`; GHCR package pages can lag behind successful pushes.
