# Changelog

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
