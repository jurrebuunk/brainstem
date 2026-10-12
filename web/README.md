# Brainstem Web

Minimal Brainstem live view and operations panel.

It runs separately from the Brainstem runtime and backend API. It is presentation-only and proxies `/api/*` to `WEB_BACKEND_URL`.

- runtime telemetry such as `brainstem.input.poll.started`, `brainstem.core.decision`, and destination lifecycle events
- destination envelopes: `brainstem.output`
- scoped plugin logs: `brainstem.plugin.log`

Pages:

- **Flow** — React Flow graph of inputs → core → destinations, backed by the backend's persisted SQLite event log, with node logs and JSON detail modal.
- **Stats** — persisted counters plus interactive uPlot charts with metric filtering, range controls, live pause, hover values, and drag-to-zoom.
- **Settings** — Appearance theme choices and a Config editor for `brainstem.config.mjs`; saves are syntax-checked, backed up, and written atomically.

## Run from source

```sh
npm --prefix web install
npm run api
WEB_BACKEND_URL=http://127.0.0.1:5174 npm run web
```

Open:

```text
http://127.0.0.1:5173
```

Alternatively set `runtime.api.enabled: true` and run Brainstem; it will own the backend telemetry API while the Web UI connects to it.

## Run from Docker image

The main Brainstem image includes both the backend API and production Web UI server. Run them as separate processes/containers:

```sh
docker run --rm \
  -p 127.0.0.1:5174:5174 \
  -e BRAINSTEM_API_HOST=0.0.0.0 \
  -v "$PWD/brainstem.config.mjs:/app/brainstem.config.mjs" \
  -v brainstem-data:/app/data \
  ghcr.io/jurrebuunk/brainstem:v0.1.0-alpha.5 \
  node brainstem-api.mjs

# In another container/process:
docker run --rm \
  -p 127.0.0.1:5173:5173 \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -e WEB_BACKEND_URL=http://host.docker.internal:5174 \
  ghcr.io/jurrebuunk/brainstem:v0.1.0-alpha.5 \
  node web/server.mjs
```

## Safety note

The Settings → Config page calls the backend config API. Keep the API/Web UI bound to localhost or set `BRAINSTEM_API_TOKEN` plus `WEB_BACKEND_TOKEN` before exposing it on a network.
