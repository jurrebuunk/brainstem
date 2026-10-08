# Web UI

Brainstem includes a minimal Web UI under `web/`.

The Web UI is intentionally separate from the headless runtime. It does not run the core or own plugin state. It receives runtime telemetry and output envelopes over HTTP, renders a live React Flow graph, stores simple stats in a local SQLite database, and includes a small config editor for `brainstem.config.mjs`.

## Run

Install web dependencies once:

```sh
npm --prefix web install
```

Start the Web UI:

```sh
npm run web
```

Open:

```text
http://127.0.0.1:5173
```

Then start Brainstem in another terminal:

```sh
npm start
```

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

Click a node to open a modal with recent events for that node. Select a row in the event table to inspect the full JSON event/envelope.

The sidebar has three pages:

- **Flow** — live inputs → core → destinations graph. Core edge handles are stacked vertically to avoid line congestion.
- **Stats** — persisted counters and small six-hour charts for polls, decisions, outputs, and errors.
- **Config** — a syntax-highlighted editor for `brainstem.config.mjs`; saves are checked with `node --check` before writing.

## Connection model

Brainstem sends structured telemetry to the Web UI:

```js
runtime: {
  telemetry: {
    url: "http://127.0.0.1:5173/api/events",
    snapshotIntervalMs: 5000
  }
}
```

The Web UI exposes:

```text
POST /api/events   ingest telemetry and output events
GET  /api/events   current in-memory event buffer
GET  /api/stream   Server-Sent Events stream for browsers
GET  /api/stats    persistent stats counters and time series
GET  /api/config   read brainstem.config.mjs
PUT  /api/config   syntax-check and write brainstem.config.mjs
GET  /api/health   health check
```

The Web UI stores events in memory only. Restarting the Web UI clears its current event buffer, but Brainstem emits periodic `brainstem.snapshot` events so the graph can repopulate while the runtime is running.

Stats are persisted in SQLite at `data/web-stats.sqlite` by default. Override with `WEB_STATS_DB=/path/to/web-stats.sqlite`. Old time-series rows are pruned after 14 days by default; override with `STATS_PRUNE_AFTER_DAYS`.

The config editor writes atomically after `node --check` validation and creates a timestamped `.bak` file next to the config before replacement. Override the editable config path with `BRAINSTEM_CONFIG=/path/to/brainstem.config.mjs`. Request bodies are capped at 1 MiB by default; override with `MAX_BODY_BYTES`.

## HTTP JSON output

To show destination output envelopes in the Web UI, configure the HTTP JSON destination:

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
      url: "http://127.0.0.1:5173/api/events"
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
