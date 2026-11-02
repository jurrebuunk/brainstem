# Changelog

## Unreleased

- New `agentos-runner` destination: runs a configured task in a [Rivet agentOS](https://rivet.dev/agent-os) VM for each matching decision. One plugin serves many tasks; each destination entry has its own filters, `command` (or agent `prompt`), network allowlist, read-only mounts, env, and host-side tools. Tools are validated, limited by `maxCalls`, can be `required`, and are replayed instead of repeated when a delivery is retried. `runOnce: "revision"` skips re-emitted observations by default. Agent sessions for `prompt` tasks are not implemented yet. See `docs/plugins/agentos-runner.md`.
- `@rivet-dev/agentos-core` is an optional dependency. The Docker image omits optional dependencies unless built with `--build-arg INSTALL_OPTIONAL=true`.

## 1.3.0 — 2026-11-02

First release on the way to 2.0: one database for all state (SQLite or Postgres) and a durable decide/deliver pipeline. Includes the unreleased 2.0 Phase 0 and Phase 1 work. See "Behaviour changes" below before upgrading.

Brainstem 2.0 Phase 0 (safety net), see `docs/roadmap-2.0.md`:

- CI workflow running the syntax check, unit/integration tests, and acceptance tests on every PR and push to `main`.
- Tests for the runtime polling loop, shutdown and abort handling, poll-retry re-delivery (1.x behaviour), per-ID ordering and decision caching in the core, config saves, and the SSE stream.
- Multi-core acceptance harness (`npm run test:acceptance`) that runs several real core processes against shared state. The 2.0 cluster guarantees are tracked as `todo` tests until Phase 3.
- Architecture decision records for the 2.0 design in `docs/adr/`.

Brainstem 2.0 Phase 1 (storage abstraction):

- One database for all state, via Kysely: SQLite (default, `sqlite:data/brainstem.sqlite`) or Postgres (`BRAINSTEM_DATABASE_URL=postgres://...`). The runtime and the embedded API share one connection.
- Records, checkpoints, telemetry, stats, and auth stores are async and database-backed. Checkpoints are read from the database on every poll, with no per-process cache.
- New `ctx.state` plugin API for durable plugin state. The Matrix destination keeps its suppression state there, claiming a notification before sending so two processes can't both send it.
- Record writes check the expected revision (groundwork for multi-core).
- Safe first-admin creation under concurrent setup requests; login rate limiting stored in the database and keyed by client IP behind trusted proxies (`BRAINSTEM_TRUSTED_PROXIES`); retention pruning moved to a periodic maintenance job.
- `brainstem migrate`, `migrate status`, `migrate import-v1`, and `migrate copy` / `sqlite-to-pg` commands.
- 1.x state (`web-stats.sqlite`, `checkpoints.json`, `matrix-notifications.json`) is imported automatically on first start; legacy files are never modified.
- CI runs every storage test against both SQLite and Postgres 17.
- Behaviour change: with no `records`/`checkpoints` config, state now persists to the database (previously records were in memory and checkpoints in JSON). Explicit `memory`, `json`, and `sqlite` types still work.

Brainstem 2.0 Phase 2 (durable pipeline), see `docs/delivery-pipeline.md`:

- The runtime is split into `poll`, `decide` and `deliver` stages connected by jobs in the new `jobs` table. Each stage commits its outputs and the next stage's jobs in one transaction. Checkpoints advance in the same transaction that stores the polled observations.
- One deliver job per (decision, destination). A failing destination is retried on its own with exponential backoff and jitter (`runtime.queue.deliver.retry`, or `retry` per destination). It no longer re-triggers other destinations, the decision or the poll, and a slow destination no longer stalls polling.
- Jobs that run out of attempts become dead jobs. The new **Deliveries** page in the Web UI shows queue depth, the delivery log and dead jobs, with redrive and discard. API: `GET /api/pipeline`, `GET /api/jobs`, `GET /api/deliveries`, `POST /api/jobs/redrive`, `POST /api/jobs/discard`.
- Delivery log (`deliveries` table) keyed by an idempotency key, which is checked before sending. Delivered rows are pruned after `runtime.deliveries.pruneAfterDays` (14).
- Decide jobs are serialized per observation ID through the queue (`queue_key`), and record writes are compare-and-set on the revision.
- Jobs hold renewable leases. Jobs from crashed processes are reclaimed, and jobs interrupted by shutdown are handed back without using up an attempt.
- **Destination plugin SDK v2** (`brainstem.destination/v2`): `handle(ctx, output)` receives the serializable `brainstem.output` envelope, plus `ctx.idempotencyKey` and `ctx.attempt`. v1 destinations keep working through an adapter, which logs a deprecation warning, until 3.0.
- Built-in destinations are on v2:
  - `http-json` sends an `Idempotency-Key` header.
  - Matrix uses the key as `txnId`, replacing the random id per attempt.
  - opencode-runner resumes the session of a retried delivery instead of starting a new one.
  - log-decisions is migrated.
- Migration `0002_pipeline` adds the `jobs` and `deliveries` tables. `migrate copy` includes them.
- New telemetry: `brainstem.core.failed`. `brainstem.destination.failed` now carries `attempt`, `dead` and `retryInMs`. New metrics: `decisions.failed`, `decisions.dead` and `destinations.dead`.
- Behaviour changes:
  - `runtime.destinations.blockInputOnFailure` is ignored, with a warning.
  - A failing decision no longer holds back the input checkpoint. It stays queued and is retried.
  - `--once` runs every due job after polling, and exits non-zero if any poll or job failed.
  - Config callbacks of the built-in destinations (`notificationKey`, `titleForEvent`, `promptTemplate`) receive `output.payload`.
  - Give destinations an `id`: it is part of the idempotency key.

## 0.1.0

First stable release of Brainstem as a local-first headless decision runtime with a protected operations UI.

Includes:

- Persistent authentication with first-run administrator onboarding and no default credentials.
- Argon2id password hashing via the standard `argon2` npm package.
- SQLite-backed users, roles, sessions, CSRF tokens, telemetry, event history, and stats.
- Backend-enforced RBAC for events, SSE, stats, config, users, and roles.
- Built-in Administrator, Operator, and Viewer roles, plus custom role creation/deletion.
- User creation, disabling/enabling, deletion, and last-active-admin protections.
- Protected backend APIs and SSE with browser sessions; machine telemetry ingestion can still use `BRAINSTEM_API_TOKEN`.
- React first-run onboarding, login, settings, users, and roles UI.
- Web UI proxy fixes for multiple `Set-Cookie` headers.
- Updated Docker, README, docs, and screenshots for the non-alpha release.

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
