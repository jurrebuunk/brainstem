# Changelog

## 0.1.0-alpha.5

Backend/Web UI decoupling and modularization release.

Includes:

- Backend API now owns telemetry ingestion, event history, stats, retention, SSE, and config management.
- Web UI is presentation-only and proxies `/api/*` to the backend via `WEB_BACKEND_URL`.
- Added standalone `brainstem-api.mjs` and `brainstem-api` binary.
- Runtime can start the backend API with `runtime.api.enabled` and automatically send telemetry to it.
- Added optional backend bearer-token auth via `BRAINSTEM_API_TOKEN` / `WEB_BACKEND_TOKEN`.
- Refactored shared telemetry selectors and metric derivation into `src/telemetry`.
- Further modularized runtime internals, Web server modules, node inspector code, and the opencode runner plugin.
- Fixed node inspector crashes for core and destination nodes.

## 0.1.0-alpha.4

Web UI node inspector and flow readability release.

Includes:

- Replaced the node click log table with a larger operational node inspector.
- Input nodes now group activity by poll with poll logs and emitted observation envelopes.
- Core nodes now show observation input envelopes alongside decision output envelopes.
- Destination nodes now show received decision/observation envelopes with destination-scoped logs and output envelopes.
- Tightened the inspector into a compact table-like layout with less duplicated metadata.
- Standardized application font-size and line-height CSS tokens for more readable UI sizing.
- Increased flow graph row spacing so stacked nodes no longer overlap.

## 0.1.0-alpha.3

Production-ready Web UI observability persistence.

Includes:

- Web UI now persists raw telemetry/output events in SQLite, so Flow/node logs survive Web UI restarts.
- `/api/events` now reads from the persisted event log and supports `limit`, `before`, `after`, `kind`, `level`, and `source` filters.
- Stats and event-log writes are committed together, keeping derived metrics aligned with stored telemetry.
- Event log retention is configurable with `WEB_EVENTS_PRUNE_AFTER_DAYS` and `WEB_EVENTS_MAX_ROWS`; either pruning mode can be disabled with `0`.
- Docker/Compose examples updated for the new release tag and event-log retention settings.

## 0.1.0-alpha.2

Docker and documentation production-template release.

Includes:

- Docker image now contains the production Web UI server and built static assets.
- Docker Compose template now runs separate runtime and Web UI containers.
- Docker docs updated with Compose service DNS, Web UI environment variables, image verification, and config-editor safety notes.
- README updated for current release and production-oriented deployment.

## 0.1.0-alpha.1

Release hardening for headless agent routing and the Web UI.

Includes:

- Source-side dedupe/checkpointing improvements for GitHub, HTTP health, and TLS inputs.
- Destination failures isolated from input checkpointing by default.
- HTTP JSON output destination and local Web UI event ingestion.
- Structured runtime telemetry and scoped plugin telemetry.
- React Flow Web UI with live flow, node logs, stats, and CodeMirror config editor.
- Persistent Web UI stats in SQLite.
- OpenCode runner destination using the OpenCode server API with output logging.
- Web server hardening for invalid JSON, request limits, atomic config saves, stats pruning, and safer static serving.
- Documentation updates for telemetry, Web UI, HTTP JSON, and OpenCode runner.

## 0.1.0-alpha.0

Initial alpha release.

Includes:

- Laya-backed Brainstem core decision engine.
- Polling input plugin runtime.
- Routed destination plugin runtime.
- Durable SQLite core record cache.
- Deferred input checkpoints.
- GitHub issues input plugin.
- HTTP health input plugin.
- Console logging destination plugin.
- Matrix room destination plugin.
- Local config and `.env` support.
