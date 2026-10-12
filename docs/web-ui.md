# Web UI

Brainstem includes a minimal operations Web UI under `web/`.

The Web UI is intentionally separate from the headless runtime and backend API. It does not run the core, own plugin state, or access persistence directly. It calls backend API endpoints for event history, live SSE, stats, and config management, then renders the operational interface.

## Run

Install web dependencies once:

```sh
npm --prefix web install
```

Start the backend API, then the Web UI:

```sh
npm run api
WEB_BACKEND_URL=http://127.0.0.1:5174 npm run web
```

Open:

```text
http://127.0.0.1:5173
```

For a single runtime process that owns telemetry automatically, set `runtime.api.enabled: true` in `brainstem.config.mjs` and run `npm start`.

## What it shows

The UI renders a live graph:

```text
inputs → Brainstem Core → destinations
```

It shows:

- configured input nodes
- the core decision node
- configured destination nodes
- poll activity
- observations emitted by inputs
- core decisions
- destination running/completed/failed events
- output envelopes
- plugin logs emitted through `ctx.logger`

Click a node to open the node inspector. It groups activity by the operational unit that matters for that node: input nodes show polls with poll logs and emitted observation envelopes, the core shows observation-in/decision-out pairs, and destination nodes show received decision envelopes with destination-scoped logs and output envelopes.

The sidebar has three pages:

- **Flow** — live inputs → core → destinations graph. Core edge handles are stacked vertically to avoid line congestion.
- **Stats** — persisted counters, KPI cards, filterable metric tables, and interactive uPlot time-series charts with range controls, live pause, hover values, and drag-to-zoom.
- **Settings** — subtabs for:
  - **Appearance** — choose dark, light, or system theme.
  - **Config** — a syntax-highlighted editor for `brainstem.config.mjs`; saves are checked with `node --check` before writing.

## Connection model

The backend API owns telemetry ingestion, persistence, statistics, SSE, and config management. The Web UI proxies `/api/*` to `WEB_BACKEND_URL` and is otherwise static presentation.

Backend API config:

```js
runtime: {
  api: {
    enabled: true,
    host: "127.0.0.1",
    port: 5174,
    telemetryDbPath: "data/web-stats.sqlite"
  }
}
```

The backend API exposes:

```text
POST /api/events   ingest telemetry and output events
GET  /api/events   persisted recent event log, newest-limited and returned oldest-first
GET  /api/stream   live Server-Sent Events stream for browsers
GET  /api/stats    persistent derived stats counters and time series
GET  /api/config   read brainstem.config.mjs
PUT  /api/config   syntax-check and write brainstem.config.mjs
GET  /api/health   health check
```

The backend persists raw telemetry/output events and derived stats in SQLite at `data/web-stats.sqlite` by default. Override with `BRAINSTEM_API_DB=/path/to/web-stats.sqlite` or `runtime.api.telemetryDbPath`. On Web UI restart, the Flow page reloads recent events from the backend and continues with live updates from `/api/stream`.

Event log retention is controlled by `WEB_EVENTS_PRUNE_AFTER_DAYS` and `WEB_EVENTS_MAX_ROWS` (defaults: 14 days and 50,000 rows). Set either to `0` to disable that pruning mode. Old time-series rows are pruned after 14 days by default; override with `STATS_PRUNE_AFTER_DAYS` or set it to `0` to disable time-series pruning.

The backend config API writes atomically after `node --check` validation and creates a timestamped `.bak` file next to the config before replacement. Override the editable config path with `BRAINSTEM_CONFIG=/path/to/brainstem.config.mjs`. Request bodies are capped at 1 MiB by default; override with `MAX_BODY_BYTES`. Set `BRAINSTEM_API_TOKEN` and `WEB_BACKEND_TOKEN` when exposing the API beyond localhost.

## HTTP JSON output

To emit destination output envelopes into the backend telemetry history, configure the HTTP JSON destination:

```js
destinations: [
  {
    module: "./plugins/http-json/index.mjs",
    destination: "default",
    decisions: "all",
    routes: "all",
    sources: "all",
    types: "all",
    config: {
      url: "http://127.0.0.1:5174/api/events"
    }
  }
]
```

## Plugin logs

Plugins can emit logs through `ctx.logger`:

```js
ctx.logger.info("github issues poll result", {
  fetched,
  emitted
});
```

Those logs are forwarded as `brainstem.plugin.log` telemetry and attached to the relevant input or destination node.
