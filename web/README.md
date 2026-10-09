# Brainstem Web

Minimal Brainstem live view and operations panel.

It runs separately from the Brainstem runtime and receives events over HTTP:

- runtime telemetry such as `brainstem.input.poll.started`, `brainstem.core.decision`, and destination lifecycle events
- destination envelopes: `brainstem.output`
- scoped plugin logs: `brainstem.plugin.log`

Pages:

- **Flow** — React Flow graph of inputs → core → destinations, with node logs and JSON detail modal.
- **Stats** — persisted counters and small charts backed by SQLite.
- **Config** — CodeMirror editor for `brainstem.config.mjs`; saves are syntax-checked, backed up, and written atomically.

## Run from source

```sh
npm --prefix web install
npm run web
```

Open:

```text
http://127.0.0.1:5173
```

In another terminal run Brainstem:

```sh
npm start
```

Configure Brainstem telemetry/output destinations to send to:

```text
http://127.0.0.1:5173/api/events
```

## Run from Docker image

The main Brainstem image includes the production Web UI server:

```sh
docker run --rm \
  -p 127.0.0.1:5173:5173 \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -e BRAINSTEM_CONFIG=/app/brainstem.config.mjs \
  -e WEB_STATS_DB=/app/data/web-stats.sqlite \
  -v "$PWD/brainstem.config.mjs:/app/brainstem.config.mjs" \
  -v brainstem-data:/app/data \
  ghcr.io/jurrebuunk/brainstem:v0.1.0-alpha.2 \
  node web/server.mjs
```

## Safety note

The Config page can edit the live config file. Keep the Web UI bound to localhost or put it behind authentication/TLS before exposing it on a network.
