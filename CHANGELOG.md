# Changelog

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
