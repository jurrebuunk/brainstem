# Web UI

Brainstem includes a minimal read-only Web UI under `web/`.

The Web UI is intentionally separate from the headless runtime. It does not run the core, edit config, or own plugin state. It receives runtime telemetry and output envelopes over HTTP and renders a live React Flow graph.

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
GET  /api/health   health check
```

The Web UI stores events in memory only. Restarting the Web UI clears its current event buffer, but Brainstem emits periodic `brainstem.snapshot` events so the graph can repopulate while the runtime is running.

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
