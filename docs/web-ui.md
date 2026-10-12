# Web UI

Brainstem includes an optional operations Web UI under `web/`.

The Web UI is intentionally separate from the headless runtime and backend API. It does not run the core, own plugin state, or access persistence directly. It calls backend API endpoints for event history, live SSE, stats, config management, authentication, users, and roles, then renders the operational interface.

![Brainstem Flow view](assets/brainstem-flow.png)

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
  - **Users** — create users, assign roles, enable/disable accounts, and delete users.
  - **Roles** — create and delete custom roles; built-in roles are locked.

![Brainstem Stats view](assets/brainstem-stats.png)

![Brainstem Users settings](assets/brainstem-users.png)

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
POST /api/events       ingest telemetry and output events
GET  /api/events       persisted recent event log, newest-limited and returned oldest-first
GET  /api/stream       live Server-Sent Events stream for browsers
GET  /api/stats        persistent derived stats counters and time series
GET  /api/config       read brainstem.config.mjs
PUT  /api/config       syntax-check and write brainstem.config.mjs
GET  /api/auth/status  setup/auth status
POST /api/auth/setup   create the initial administrator; no default credentials exist
POST /api/auth/login   create a persistent session
GET  /api/auth/me      current user, roles, permissions, and CSRF token
POST /api/auth/logout  revoke the current session
GET  /api/users        user management
POST /api/users        create user
PUT  /api/users/:id    update/enable/disable user
DELETE /api/users/:id  delete user
GET  /api/roles        role and permission list
POST /api/roles        create role
PUT  /api/roles/:id    update role
DELETE /api/roles/:id  delete custom role
GET  /api/health       health check
```

The backend persists raw telemetry/output events and derived stats in SQLite at `data/web-stats.sqlite` by default. Override with `BRAINSTEM_API_DB=/path/to/web-stats.sqlite` or `runtime.api.telemetryDbPath`. On Web UI restart, the Flow page reloads recent events from the backend and continues with live updates from `/api/stream`.

Event log retention is controlled by `WEB_EVENTS_PRUNE_AFTER_DAYS` and `WEB_EVENTS_MAX_ROWS` (defaults: 14 days and 50,000 rows). Set either to `0` to disable that pruning mode. Old time-series rows are pruned after 14 days by default; override with `STATS_PRUNE_AFTER_DAYS` or set it to `0` to disable time-series pruning.

The backend config API writes atomically after `node --check` validation and creates a timestamped `.bak` file next to the config before replacement. Override the editable config path with `BRAINSTEM_CONFIG=/path/to/brainstem.config.mjs`. Request bodies are capped at 1 MiB by default; override with `MAX_BODY_BYTES`.

## Authentication and authorization

The first browser visit starts a guided first-run onboarding flow. It explains the security model, warns when setup is not running on localhost/HTTPS, requires a strong confirmed password, and creates the initial administrator. Brainstem ships no default credentials and the setup endpoint refuses to run again after an administrator exists.

![Brainstem first-run onboarding](assets/brainstem-onboarding.png)

Passwords are hashed with the audited `argon2` npm package using Argon2id. Sessions are persisted in SQLite, delivered with `HttpOnly` same-site cookies, and paired with CSRF tokens for state-changing requests. Set `BRAINSTEM_COOKIE_SECURE=true` when serving over HTTPS.

Built-in roles are **Administrator**, **Operator**, and **Viewer**. Custom roles can be created and deleted; built-in roles remain locked to keep a safe recovery path. Users can be disabled before deletion. Last-active-administrator protections prevent accidentally locking out the installation.

Backend routes enforce granular permissions server-side for event history/SSE, stats, config reads/writes, and user/role administration. The UI only hides controls for convenience; authorization does not depend on the frontend.

![Brainstem Roles settings](assets/brainstem-roles.png)

`BRAINSTEM_API_TOKEN` remains available for machine telemetry ingestion at `POST /api/events`. If set, runtime/web proxy calls can pass it through `WEB_BACKEND_TOKEN`, but browser reads and admin actions use authenticated sessions.

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
