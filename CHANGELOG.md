# Changelog

## Unreleased

Kubernetes and operations (roadmap Phase 4): a Helm chart for single-node and cluster deployments, Prometheus metrics, OpenTelemetry traces across cores, a Compose file for cluster mode, and signed multi-arch images. See [Kubernetes](docs/kubernetes.md) and [Observability](docs/observability.md).

Upgrading:

- No migrations. `GET /metrics` is on by default on the API port and the core health port. Keep it off public ingresses, set `BRAINSTEM_METRICS_TOKEN`, or turn it off with `BRAINSTEM_METRICS=false`.
- Job payloads gain an optional `trace` (W3C `traceparent`) when tracing is on. Older cores ignore it.

Changes:

- **Helm chart** (`charts/brainstem`, published as `oci://ghcr.io/<owner>/charts/brainstem` on release):
  - modes: `mode: single` (one `role all` pod, SQLite on a kept PVC or Postgres) and `mode: cluster` (api, web and core worker groups from `cores.groups`, each running chosen stages);
  - autoscaling: KEDA `ScaledObject`s on due jobs and oldest-job age (PostgreSQL or Prometheus trigger), an HPA for the API and poll-only groups;
  - database: CloudNativePG `Cluster` or an external Postgres;
  - migrations as a pre-install/pre-upgrade hook (a regular Job with CloudNativePG), config seeded with `config import --if-empty`;
  - the model mounted from the `brainstem-models` image (init container or image volume);
  - availability and security: PDBs, topology spread, preStop + drain, default-deny NetworkPolicies, non-root read-only pods without service account tokens;
  - monitoring and access: ServiceMonitor, PrometheusRule alerts (no healthy core, API down, queue backlog, delivery failures, dead jobs, overdue inputs, event-loop lag), a Grafana dashboard ConfigMap, ingress with SSE-friendly defaults;
  - safety nets: `values.schema.json`, and a `helm test` smoke test.
- **Prometheus metrics** on `GET /metrics`:
  - per core: polls, poll duration, observations, lease lag, decisions, job duration and failures, deliveries by destination and outcome, in-flight jobs;
  - cluster-wide from the API: queue depth, delayed, running and dead jobs, oldest-job age, cores per status and queue, input states and schedule lag, the delivery log;
  - process metrics, including event-loop lag.

  An in-house registry, no dependencies ([ADR-0009](docs/adr/0009-in-house-metrics-and-tracing.md)).
- **OpenTelemetry tracing:** `poll → decide → deliver` spans form one trace per envelope across cores, continued through `traceparent` stored in job payloads (handoffs included). Spans are exported as OTLP/HTTP JSON, configured by the standard `OTEL_*` variables; off without an endpoint. JSON log lines inside a span carry `trace_id`/`span_id`. Destinations get `ctx.traceparent`, and `http-json` forwards it as a `traceparent` header.
- **`docker-compose.cluster.yml`:** Postgres, migrate + config seed, the model volume, API, Web UI and one core per stage. `--profile observability` adds Prometheus and Jaeger.
- **CI:**
  - chart: `helm lint`, helm-unittest, `ct lint`, kubeconform against several Kubernetes versions with CRD schemas, and `ct install` on kind with CloudNativePG and KEDA;
  - images: multi-arch (amd64, arm64), cosign keyless signatures, SBOM and provenance, and Trivy scans (pull requests fail on fixable critical and high findings).
- `brainstem config import --if-empty` seeds the config store only while it is empty.
- `BRAINSTEM_SCHEMA_WAIT_MS`: core and API processes wait for migrations (or the database) instead of exiting.
- `BRAINSTEM_TELEMETRY_URL` / `BRAINSTEM_TELEMETRY_TOKEN`: cores without a config file send telemetry to the API.
- The Dockerfile builds the Web UI once on the build platform, and installs native dependencies per target platform.

## 2.0.0-beta.1 — 2026-11-03

Multi-core (roadmap Phase 3). Brainstem runs as several processes on one Postgres database: input polling, decisions and deliveries are shared across cores, a lost core loses nothing, and config is versioned data that every core hot-reloads. Single-node mode (`--role all`, SQLite) works as before. See [Cluster mode](docs/cluster.md).

Upgrading (breaking):

- **The API no longer writes or executes the config file.** `PUT /api/config` returns 409 with `configSource: file` (the default), and the Web UI shows the file read-only. To edit config in the UI, run `brainstem config import` and set `BRAINSTEM_CONFIG_SOURCE=database`. Mount the config file read-only.
- Inputs are scheduled by leases in the database when the pipeline uses the database transport (the default). The schedule survives restarts, so a restart no longer polls every input immediately; it polls when the input is next due. Set `runtime.inputs.scheduling: "timer"` for the 1.x behavior.
- `--role core` and `--role api` never migrate. Run `brainstem migrate` once per upgrade, or set `BRAINSTEM_MIGRATE=true`. `--role all` (the default) and `brainstem-api.mjs` still migrate on start.
- `GET /api/pipeline` reports `transport: "postgres"` on Postgres.
- Migration `0005_cluster` adds `inputs`, `config_versions`, `active_config` and `cores.config_version`.

Changes:

- **Roles and queues:** `brainstem --role all|core|api|web` and `--queues poll,decide,deliver` (`BRAINSTEM_ROLE`, `BRAINSTEM_QUEUES`). Only `decide` cores load the Laya model. Cores register their role, queues and config version.
- **Postgres cluster driver:** `LISTEN/NOTIFY` wakeups for jobs, inputs, config and telemetry (`src/db/notifier.mjs`); claims keep `FOR UPDATE SKIP LOCKED`. `runtime.queue.transport: "postgres"` requires Postgres.
- **Lease-based input scheduling with fencing epochs:** each input is polled by one core at a time, and its checkpoint commit is refused once another core holds the lease. Leases of stopped or lost cores are taken over at once. Inputs get `ctx.lease`. `GET /api/inputs` shows the schedule and lease owners.
- **Advisory-lock singletons** for delivery-log pruning and API maintenance (`src/db/locks.mjs`). New `inputs.prune` maintenance task.
- **Laya worker pool:** `runtime.laya.workers` / `BRAINSTEM_LAYA_WORKERS` / `--decide-concurrency` evaluates observations in parallel in worker threads, off the event loop. `BRAINSTEM_LAYA_MODEL_DIR` uses a mounted model. The model is published as the `brainstem-models` OCI image (`Dockerfile.models`, CI).
- **Config as versioned data:** `config_versions` validated against a JSON Schema (`GET /api/config/schema`); saves guarded by `If-Match`; rollback by activating an older version; `brainstem config import|export|list|show|activate|validate`. Cores reload the active version without a restart and keep the previous one when a new one fails to load.
- **SSE across API replicas:** telemetry is announced by id and streamed by every replica. Events carry ids, and reconnecting clients resume from `Last-Event-ID` on any replica.
- **Graceful drain on SIGTERM:** readiness fails, claiming stops, in-flight polls and jobs finish (`runtime.shutdown.timeoutMs`, `--drain-timeout`), and leases are released. The API ends SSE streams and closes.
- **Probes on every role:** `/livez`, `/readyz` and `/startupz` (core: `--health-port`, default 8081; API: its own port).
- Web UI: versioned config editor with history and rollback; the Cores panel shows each core's config version.
- Topology merges cores that run different queues and is consistent when running cores share a config version.
- Failed input polls emit `brainstem.input.poll.failed` and count as input node errors.
- Jobs held by a core that stopped or missed 3 heartbeats are reclaimed at once, like its input leases, instead of after the job lease expires.
- The multi-core acceptance tests pass (no longer `todo`) on SQLite and Postgres, including killing a core mid-run.

## 1.4.0 — 2026-11-02

Small agent tasks and the groundwork for multi-core: a generic agentOS runner for cheap, bounded agent work, destinations that hand results back to the core, a log file input, telemetry and a core registry that identify cores and destinations, and a Web UI flow built on them.

Upgrading:

- Migrations `0003_cores` and `0004_node_stats` run automatically on start.
- The Docker image omits optional dependencies (the agentOS VM runtime). Build with `--build-arg INSTALL_OPTIONAL=true` to use `agentos-runner` in Docker.
- Handed-off observations no longer pretend to come from an input named `destination:<id>`: their `input` is empty and `origin` names the destination. Consumers of telemetry or output envelopes that relied on that input id should read `origin`.
- Web UI destination nodes show `delivered` instead of `outputs`. Per-node totals start counting from the upgrade; earlier history isn't backfilled.

Changes:

- Per-node totals: the API counts polls, observations, decisions, completed deliveries, handoffs, errors and the last event time per flow node in a new `stat_nodes` table (migration `0004_node_stats`) as telemetry arrives, and returns them as `nodes` in `GET /api/stats`. The Flow page shows these totals, so node counters no longer reset when events leave the 2000-event window. Destination nodes now show `delivered` (completed deliveries) instead of `outputs`, which only ever counted the HTTP JSON destination's output events.

- `agentos-runner` fails fast and clearly: a missing model API key is reported before a VM boots, and a sidecar that can't start (`EPIPE` and similar) becomes a permanent, readable error ("the agentOS sidecar could not start … on NixOS enable programs.nix-ld") instead of retried pipe errors. On NixOS, nix-ld is now the recommended setup; the real-VM test runs whenever nix-ld (or `AGENTOS_SIDECAR_BIN`) is available.
- Fix: `npm run check` now fails on syntax errors (it used `find -exec`, which ignored them) and also checks `brainstem-api.mjs` and the Web UI flow model.

- Web UI Flow page brought up to date with the runtime: structure from `/api/topology` (one node per configured id, so tasks of the same plugin are no longer merged), a core pool node and a Cores panel from the core registry, handoffs shown only while they happen (a short-lived "handing off" pill node linked to the destination) instead of fake `destination:<id>` input nodes, and an inspector that matches destinations by id and shows each decision's origin and core. Falls back to snapshot events against an older backend. The graph logic moved into a pure, unit-tested `web/src/flow/model.js`.

- Core registry and `GET /api/topology`: each runtime registers in a new `cores` table (migration `0003_cores`) with its role, queues, version and loaded topology, heartbeats every `runtime.cores.heartbeatMs` (default 10 s) and marks itself stopped on shutdown. Cores that miss 3 heartbeats are reported as `lost`, and rows unseen for 24 h are pruned. `/api/topology` serves the cores plus the inputs and destinations (with ids) from the freshest running core, and flags running cores that loaded different configs. The Web UI no longer has to derive structure from snapshot events.

- Telemetry identity fields for multi-core and handoffs: every event carries `coreId` (`runtime.coreId` / `BRAINSTEM_CORE_ID`, also the job worker id); decisions and output envelopes carry `origin` (`{ kind: "input", id }` or `{ kind: "destination", id, depth, lineage }`); the snapshot and destination plugin logs carry destination `id`s; a new `brainstem.destination.emitted` event marks each handoff. A handed-off observation no longer pretends to come from an input named `destination:<id>`. Its `input` is empty and `origin` names the destination. Jobs queued by the previous version are still understood.

- Destinations can hand observations back to the core with `ctx.emit(observation)`. They are enqueued in the same transaction that marks the delivery delivered, never routed back to a destination already in their chain, and limited by `runtime.handoff.maxDepth` (default 2) and `maxPerDelivery` (default 5).
- `agentos-runner` gains `handoff`: a successful run's report becomes an `agent_report` observation (with `facts.minimum_decision`) that Matrix or a bigger agent can pick up.
- New `log-file` input: watches a log file and emits new matching lines (default `ERROR|FATAL|CRITICAL|PANIC`) as one bounded observation per poll, with offset checkpoints and truncation/rotation handling.
- Fix: the agentOS prompt and docs used `observation.summary`, which doesn't exist; they now use `title`, `message` and `source.type`/`source.name`.

- New `agentos-runner` destination: runs a configured task in a [Rivet agentOS](https://rivet.dev/agent-os) VM for each matching decision. One plugin serves many tasks; each destination entry has its own filters, `command` (or agent `prompt`), network allowlist, read-only mounts, env, and host-side tools. Tools are validated, limited by `maxCalls`, can be `required`, and are replayed instead of repeated when a delivery is retried. `runOnce: "revision"` skips re-emitted observations by default. See `docs/plugins/agentos-runner.md`.
- `prompt` tasks run a host-side agent loop against any OpenAI-compatible endpoint (`model: { baseUrl, name, apiKeyEnv }`). The model gets `run_command` (inside the VM) plus the entry's tools. Every run is bounded by `limits` (turns, output tokens, commands, tool output size, prompt size, conversation size, request spacing), duplicate calls are refused, and a delivery that already talked to the model fails permanently instead of being retried (`maxAgentAttempts: 1`).
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
