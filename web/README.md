# Brainstem Web

Brainstem Web is the optional operations UI for the local-first Brainstem runtime.

It runs separately from the headless runtime and backend API. It is presentation-only and proxies `/api/*` to `WEB_BACKEND_URL`; the backend owns event history, stats, SSE, config, users, roles, sessions, and authorization.

Pages:

- **Flow** — React Flow graph of inputs → core → destinations, backed by the backend's persisted SQLite event log, with node logs and raw JSON envelopes.
- **Stats** — persisted counters plus interactive uPlot charts with metric filtering, range controls, live pause, hover values, and drag-to-zoom.
- **Settings** — Appearance, Config editor, Users, and Roles.

Auth and admin:

- First visit creates the initial administrator.
- Passwords are Argon2id hashes stored in SQLite.
- Browser sessions use HttpOnly cookies and CSRF tokens.
- Backend RBAC protects events, SSE, stats, config, users, and roles.
- Users can be created, enabled/disabled, and deleted.
- Custom roles can be created/deleted; built-in roles are locked.

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
  ghcr.io/jurrebuunk/brainstem:v0.1.0 \
  node brainstem-api.mjs

# In another container/process:
docker run --rm \
  -p 127.0.0.1:5173:5173 \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -e WEB_BACKEND_URL=http://host.docker.internal:5174 \
  ghcr.io/jurrebuunk/brainstem:v0.1.0 \
  node web/server.mjs
```

## Safety note

Keep the API/Web UI bound to localhost for local use. If exposing remotely, serve over TLS, set `BRAINSTEM_COOKIE_SECURE=true`, and consider `BRAINSTEM_API_TOKEN` for machine telemetry ingestion.
