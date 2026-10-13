# Brainstem 2.0 — Scale-out architecture & roadmap

Status: **accepted** (all decisions in §7 are final) · Target: `v2.0.0` · Baseline: `v0.1.0` (single Node process + SQLite)

## 1. Goal

Run Brainstem as a modular stack on Kubernetes that scales horizontally with load:

- N stateless **core** replicas on different nodes/servers, any of which can do any piece of work.
- **HA**: losing a pod or node loses no observations and causes no permanent gap in polling.
- **Load balancing** of envelope work (polls, decisions, deliveries) across cores via a shared queue.
- **Autoscaling** on real load (queue depth / lag), not guesswork.

Non-goals / constraints:

- **Single-node stays first-class.** `docker run` with SQLite and zero extra infra must keep working (`--role=all`). Hobby users must never be forced to run Postgres, Redis or NATS. (Lesson from n8n "no SQLite in queue mode" vs. Inngest's embedded default.)
- No mandatory broker. Postgres is the only extra dependency in cluster mode.
- No global ordering guarantee — ordering is per observation/source key only.

## 2. What blocks scaling today

Evidence from a code review of `src/` (file:line refs are against `7fc4fda`):

| Severity | Blocker | Where |
|---|---|---|
| Critical | No work queue — every replica polls every input, evaluates every observation, delivers every decision (N× everything) | `src/runtime/runtime.mjs:153,354-379` |
| Critical | Timer-based polling (`sleep(intervalMs)` loop per input), no lease / leader | `runtime.mjs:354` |
| Critical | Checkpoints in `data/checkpoints.json`, loaded once and cached, last-write-wins | `src/runtime/checkpoints.mjs:76-98` |
| Critical | Non-idempotent delivery: poll-level retry re-delivers to already-successful destinations; Matrix uses a random `txnId` per attempt; opencode creates a new session per event; no delivery records | `runtime.mjs:945-953`, `plugins/matrix/client.mjs:31`, `plugins/opencode-runner/index.mjs:26` |
| Critical | Record store is local `DatabaseSync` SQLite, no `busy_timeout`; per-ID ordering (`locks` Map) and read-then-write `revision` are process-local only | `src/core/record-stores.mjs`, `src/core/brainstem.mjs:40,226` |
| High | One serialized Laya evaluation queue per process + ~1.9 GB model cache downloaded on first start | `core/brainstem.mjs:52,322`, `data/laya-cache/` |
| High | Matrix suppression state in a local JSON file + module-level Maps | `plugins/matrix/notify.mjs:12-22,179-185` |
| High | API: in-memory SSE client set, in-memory login rate limit (keyed by socket IP — broken behind a proxy), per-event write txn with 2 prune DELETEs, non-atomic first-admin creation | `src/backend/sse.mjs:4`, `api-server.mjs:52,387`, `telemetry-store.mjs:147-166`, `auth-store.mjs:30-44` |
| High | Config is an executable `.mjs` file written by the API (`PUT /api/config`), no versioning, no hot reload, RCE surface | `src/backend/config-store.mjs` |
| Medium | Destinations run sequentially inside the poll loop (slow destination stalls ingest); fire-and-forget telemetry with no backpressure; UI topology from latest `brainstem.snapshot` (flaps with >1 runtime); `pollId` not globally unique | various |

Good news — the seams already exist:

- `CheckpointStore {get,set,close}` (`src/runtime/stores.mjs:35`) and `RecordStore {get,put,touch,prune,close}` are pluggable interfaces.
- `Brainstem.process(observation) → decision` is a near-pure function apart from the record store.
- Observation and decision envelopes are already versioned, validated JSON (`sdk/index.mjs:145`, `core/brainstem.mjs:236-277`).
- `brainstem.output` in `plugins/http-json/index.mjs:43-66` is already a serializable delivery payload.
- API (`brainstem-api.mjs`) and web (`web/server.mjs`) are already separate processes; sessions/CSRF are already DB-backed.

## 3. How others do it (summary)

| System | Pattern we copy |
|---|---|
| **n8n queue mode** | Split pollers (singleton per input) from execution (scaled workers). Avoid: sticky sessions, mandatory Redis, no SQLite. |
| **Windmill** | Stateless servers + workers that talk *only* to Postgres; job queue via `SKIP LOCKED`; worker groups by tag. Proof that Postgres-as-queue scales far. |
| **Kestra 2.0** | Single engine + pluggable queue abstraction; JDBC/Postgres queue in OSS. Validates the Transport interface. |
| **Vector / Benthos** | Ack the source (advance checkpoint) only after the envelope is durably stored. |
| **Alertmanager HA** | Check a shared notification log before sending; prefer a duplicate over a missed alert. |
| **StackStorm / Grafana** | Anti-patterns: timers in every replica → duplicates; inputs pinned to nodes by hand. |
| **Inngest** | SQLite + embedded default, Postgres optional — exactly our single-node/cluster split. |

Sources: n8n scaling docs, windmill.dev HA & worker-group docs, kestra.io architecture + 2.0 blog, vector.dev end-to-end acks, prometheus.io alerting HA, docs.stackstorm.com HA/sensor partitioning, inngest.com self-hosting, worker.graphile.org, github.com/timgit/pg-boss, keda.sh PostgreSQL scaler.

## 4. Target architecture

### 4.1 Process roles (one image, one binary)

```
brainstem --role=all|api|core|web     (env: BRAINSTEM_ROLE)
          --queues=poll,decide,deliver (core only; default: all)
```

| Role | Responsibility | State | Scales on |
|---|---|---|---|
| `web` | Static SPA + `/api` proxy (exists today) | none | fixed 2 |
| `api` | REST, SSE, auth, config versions, webhook ingress (`/hooks/*` → verify → enqueue → 202) | none (DB) | HPA CPU |
| `core` | Claims due inputs by lease and polls; runs decisions; performs deliveries | none (DB) | KEDA queue depth / lag |
| `all` | Everything in one process — today's UX, SQLite transport | SQLite | n/a |

No dedicated scheduler role: scheduling is *data* (see 4.3), so any core picks up due work and there is no leader on the hot path. True singletons (pruning, retention, stats rollups) run under a Postgres advisory lock inside whichever core holds it.

`--queues` gives Windmill-style **worker groups** without new code paths: e.g. run a `core-decide` Deployment on big-memory nodes with the Laya model, and a cheap `core-deliver` Deployment for slow destinations like `opencode-runner`, each with its own KEDA scaler.

### 4.2 Pipeline as durable jobs

```
           ┌──────────── one DB transaction ────────────┐
input lease ─▶ poll ─▶ observations + checkpoint(epoch) + decide jobs
                                                         │
decide job ─▶ Brainstem.process ─▶ record CAS(revision) + decision + deliver jobs (1 per matching destination)
                                                         │
deliver job ─▶ destination.handle(ctx, output) ─▶ deliveries row (ok / retry / dead)
```

- Each arrow is a job in the `jobs` table; each stage commits its outputs and the next stage's jobs **in the same transaction** (transactional outbox — the job table *is* the outbox).
- Checkpoints advance only when the observations are committed (Vector rule).
- `decide` jobs are serialized per `observation_id` via a `queue_key` (graphile-worker style), replacing the in-process `locks` Map. Different keys run in parallel across all cores.
- Record writes become compare-and-set on `revision`.
- One `deliver` job per (decision, destination) — a failing Matrix delivery no longer re-triggers the webhook or the poll.

### 4.3 Scheduling without double-firing

```sql
UPDATE inputs SET lease_owner=$me, lease_until=now()+$ttl, lease_epoch=lease_epoch+1
WHERE id IN (
  SELECT id FROM inputs
  WHERE enabled AND next_due_at <= now() AND (lease_until IS NULL OR lease_until < now())
  ORDER BY next_due_at LIMIT $n FOR UPDATE SKIP LOCKED)
RETURNING *;
```

- Load balances automatically across cores; a dead core's leases expire and are reclaimed.
- **Fencing:** the checkpoint commit checks `lease_epoch`; a stale poller (GC pause, partition) cannot commit.
- Jitter on `next_due_at` to avoid thundering herds.
- Long-lived inputs (IMAP IDLE, future streaming inputs) hold and renew the same lease.

### 4.4 Delivery semantics

- **At-least-once everywhere, exactly-once *effect* via idempotency keys:**
  - observation key: `source + external id / content hash` (UNIQUE)
  - decision key: `observation_id:revision`
  - delivery key: `observation_id:revision:destination` (UNIQUE in `deliveries`), passed to plugins as `ctx.idempotencyKey`
- Plugins use it: `http-json` sends `Idempotency-Key`; Matrix uses it as `txnId` (fixes the random-txnId bug); opencode-runner keys its session on it.
- Before sending, check the `deliveries` log (Alertmanager pattern). On ambiguous failure, retry — duplicates beat missed escalations.
- Exponential backoff with jitter, max attempts, terminal `dead` state; **DLQ view + redrive in the UI**.
- Visibility timeout on claimed jobs; stalled jobs are reclaimed. Never mark a job done at claim time.

### 4.5 Transport & storage

- **`Transport` interface:** `enqueue`, `claim(queues, n, leaseMs)`, `ack`, `nack(backoff)`, `extend`, `notify/subscribe`.
  - `sqlite` driver (default, `role=all`): same schema, `BEGIN IMMEDIATE`, in-process EventEmitter for notifications.
  - `postgres` driver (cluster): `FOR UPDATE SKIP LOCKED`, `LISTEN/NOTIFY` wakeups.
  - No broker driver ships in 2.0 (see D1). The interface leaves room for a NATS JetStream driver in a later release if Postgres throughput (~1–10k jobs/s) ever becomes the bottleneck.
- **DB layer: Kysely** (core SQLite + Postgres dialects, built-in migrator). Store timestamps as epoch ms / ISO, JSON as `jsonb`/`TEXT`, use `ON CONFLICT` + `RETURNING` (both dialects).
- All stores become **async** (`RecordStore`, `CheckpointStore`, telemetry, auth). `DatabaseSync` is retired from hot paths.
- Migration tool: `brainstem migrate` (schema) and `brainstem migrate sqlite-to-pg` (data export/import).

Core tables: `inputs` (schedule + lease), `checkpoints`, `observations`, `records`, `jobs`, `deliveries`, `events` (telemetry, partitioned/pruned by a singleton), `stat_*`, `auth_*`, `config_versions`, `plugin_state` (replaces Matrix JSON file & module Maps).

### 4.6 Config as versioned data

- `config_versions(id, created_at, author, spec jsonb, schema_version, comment)` + `active_config` pointer.
- UI saves a new version with optimistic concurrency (`If-Match`), validated by **JSON Schema** (no more executing user-submitted JS).
- All pods hot-reload on `config_changed` notification; rollback = re-point to an older version.
- `brainstem.config.mjs` stays as a seed / GitOps format: `brainstem config import|export`; `configSource: file` makes the UI read-only.
- Secrets stay as env indirection (`passwordEnv`, `tokenEnv`) → Kubernetes Secrets.

### 4.7 Real-time UI across replicas

- Every `api` pod subscribes (LISTEN/NOTIFY with IDs only — 8 KB limit; batch, keep NOTIFY out of hot transactions) and fans out to its SSE clients.
- `Last-Event-ID` resume from the `events` table → no sticky sessions.
- Topology comes from the DB (config + per-core heartbeats in a `cores` table), not from the latest snapshot event.
- Login rate limit moves to the DB, keyed by `X-Forwarded-For` from trusted proxies.

### 4.8 Multi-core inside a pod

- Scale with **more pods**, one event loop each (~1 vCPU); no `node:cluster`.
- Laya is the CPU/latency bottleneck: run it in a **`worker_threads` pool** (size = `--decide-concurrency`) instead of the single global queue, sharing one loaded model per pod.
- 1.9 GB model (see D6): shipped as a versioned `brainstem-models` OCI image. On Kubernetes ≥1.31 it is mounted as an image volume; on older clusters an init container copies it into an `emptyDir`. No per-pod download on cold start (critical for autoscaling speed). `role=all` / Docker keeps the download-on-first-start cache in `data/laya-cache/`.

## 5. Kubernetes deployment

```
                  [Ingress]  TLS · SSE timeouts · /hooks rate limit
               /      |        \
           web ×2   api ×2-6     /hooks → api
                      │ HPA cpu
                      │
   core-decide ×2-N ──┼── core-deliver ×2-N      (KEDA: queue depth + oldest-job age)
                      │
          Postgres (CloudNativePG ×3 + PgBouncer pooler, or managed)
   OTel collector → traces · Prometheus (ServiceMonitor) · logs (JSON stdout)
```

- **Helm chart** (`charts/brainstem`, published as OCI to GHCR) with `mode: single|cluster`; templates for each role, `ScaledObject`, HPA, PDBs, NetworkPolicies, ServiceMonitor, migration Job, optional CNPG `Cluster`; `postgres.external.url` for managed DBs.
- **Workloads:** all roles are Deployments (no StatefulSets). PDB `maxUnavailable: 1`; `topologySpreadConstraints` across hostname/zone.
- **Resources:** memory request = limit; `NODE_OPTIONS=--max-old-space-size≈75%`; no / generous CPU limit; `UV_THREADPOOL_SIZE=8` on api (argon2).
- **Autoscaling:** KEDA PostgreSQL scaler, e.g. `SELECT count(*) FROM jobs WHERE queue='deliver' AND state='ready' AND run_at<=now()`; min 2 (HA), cooldown 300s. Scale-to-zero not worth it for a monitoring runtime.
- **Graceful shutdown:** `preStop` sleep ~8s → on SIGTERM readiness fails, stop claiming, finish in-flight, release leases; `terminationGracePeriodSeconds` > longest job.
- **Probes:** liveness = event loop alive (never DB); readiness = DB reachable + not draining; startup = schema version check + plugins/model loaded.
- **Migrations:** Helm `pre-install,pre-upgrade` hook Job (`brainstem migrate`); Argo CD `PreSync` documented. Never migrate from every pod.
- **Caveat:** advisory locks and LISTEN need a direct (non-PgBouncer-transaction) connection.
- **Security:** non-root uid 1000, read-only rootfs + `emptyDir /tmp`, drop ALL caps, seccomp RuntimeDefault, default-deny NetworkPolicy (core gets egress), per-role ServiceAccount with no token automount, cosign-signed multi-arch images, Trivy in CI.
- **Observability:** OTel spans `poll → decide → deliver:<dest>`, `traceparent` stored on each job so one envelope = one trace across pods. Metrics: `brainstem_queue_ready`, `brainstem_queue_oldest_age_seconds`, `brainstem_job_duration_seconds`, `brainstem_job_failures_total`, `brainstem_deliveries_total`, `brainstem_input_lease_lag_seconds`, event-loop lag. pino JSON logs with `trace_id`, `observation_id`, `role`.

## 6. Roadmap

Each phase is releasable on its own and keeps `role=all` working. Rough sizing assumes one developer.

### Phase 0 — Safety net (≈1 wk) → `1.1`
- CI workflow running `npm test` on PRs (today only the Docker build runs).
- Tests for: `start()` loop/abort, poll-retry re-delivery, per-ID ordering, config save, SSE.
- Multi-process test harness (spawn 2–3 cores against one DB, assert no duplicate deliveries) — this becomes the 2.0 acceptance test.
- Record the decisions in §7 as ADRs `docs/adr/0001`–`0006`.

### Phase 1 — Storage abstraction (≈2–3 wks) → `1.2`
- Introduce Kysely; make `RecordStore`, `CheckpointStore`, telemetry, auth stores **async**.
- Move checkpoints and Matrix state from JSON files into DB tables (`checkpoints`, `plugin_state`).
- Postgres dialect + migrations; `brainstem migrate`, `migrate sqlite-to-pg`.
- Fix quick wins: `busy_timeout`, atomic first-admin, prune via periodic job instead of per-event.

### Phase 2 — Durable pipeline (≈3–4 wks) → `1.3`
- `Transport` interface + `sqlite` driver; `jobs` and `deliveries` tables.
- Split the runtime into `poll`, `decide`, `deliver` stages connected by jobs (single process still).
- Transactional checkpoint commit; record CAS; per-key serialization.
- Idempotency keys in plugin ctx; fix Matrix `txnId`, opencode session keying, `Idempotency-Key` on http-json.
- Retries/backoff/DLQ + DLQ view and redrive in the UI.
- **Plugin SDK v2** (`brainstem.destination/v2`): `handle(ctx, output)` receives the serializable `brainstem.output` payload + `ctx.idempotencyKey` instead of live plugin objects. v1 adapter shim kept.

### Phase 3 — Multi-core (≈3–4 wks) → `2.0.0-beta`
- `postgres` transport driver (SKIP LOCKED, LISTEN/NOTIFY).
- Lease-based input scheduling with fencing epochs; `cores` heartbeat table.
- `--role` / `--queues` switches; advisory-lock singletons.
- Laya `worker_threads` pool; `brainstem-models` OCI image built and published in CI (D6).
- API: LISTEN/NOTIFY SSE fan-out, `Last-Event-ID`, DB rate limit, topology from DB.
- Config as versioned data + JSON Schema + hot reload; `config import|export`.
- Graceful drain on SIGTERM; health/readiness endpoints on every role.

### Phase 4 — Kubernetes & ops (≈2–3 wks) → `2.0.0-rc`
- Helm chart (single + cluster), KEDA/HPA, PDBs, NetworkPolicies, migration hook.
- OTel tracing, Prometheus metrics + ServiceMonitor, example Grafana dashboard and alerts (queue age, failure rate, no healthy core).
- `docker-compose.cluster.yml` (postgres + api + web + 3 cores) for parity.
- CI: `ct lint/install` on kind with CNPG + KEDA, helm-unittest, kubeconform, multi-arch buildx, cosign, Trivy.

### Phase 5 — Hardening (≈2 wks) → `2.0.0`
- Chaos tests: kill cores mid-poll / mid-delivery, Postgres failover, network partition → assert no lost observations, no duplicate effects beyond the documented window.
- Load test: target throughput and autoscale behaviour; tune claim batch size, lease TTL, KEDA thresholds.
- Docs: upgrade guide 1.x → 2.0, ops runbook, plugin v2 migration guide.

**Total: ~13–17 weeks.**

## 7. Decisions

Recorded as Architecture Decision Records: see [docs/adr/README.md](adr/README.md).

All decisions are final for 2.0.

**D1 — Cluster mode uses Postgres only; no message broker.** ([ADR-0001](adr/0001-postgres-only-cluster-mode.md))
Postgres is both the system of record and the job queue (`FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY`). Windmill and Kestra OSS prove this scales far beyond Brainstem's volume (polls and decisions, not millions of events/s). A broker would add a second stateful system to operate and back up, and would break the transactional outbox (job + result in one transaction). The `Transport` interface keeps a future NATS driver possible, but none is built for 2.0.

**D2 — Inputs are scheduled by leases on input rows; there is no elected scheduler.** ([ADR-0002](adr/0002-lease-based-input-scheduling.md))
Any core claims due inputs (§4.3). This gives automatic load balancing, no leader on the hot path and no failover gap, at roughly the same code cost as a leader. Long-lived inputs (IMAP IDLE) need leases anyway. Every claim increments `lease_epoch`, and checkpoint commits are fenced on it so a stale poller cannot write. A Postgres advisory lock is used only for true singletons: pruning, retention, stats rollups.

**D3 — Kysely for the DB layer, with an in-house queue.** ([ADR-0003](adr/0003-kysely-and-in-house-queue.md))
Brainstem needs identical queue semantics on SQLite (`role=all`) and Postgres (cluster). pg-boss and graphile-worker are Postgres-only, which would mean two queue implementations. Drizzle needs a schema file per dialect; Kysely has one schema and a built-in migrator. The queue is ~300 lines on Kysely and copies graphile-worker's design: `queue_key` for per-key serialization, `job_key` for dedupe, `LISTEN/NOTIFY` wakeups (EventEmitter on SQLite), and visibility timeouts with reclaim.

**D4 — Plugin SDK v2 is a breaking change for destinations, with a v1 shim through 2.x.** ([ADR-0004](adr/0004-destination-plugin-sdk-v2.md))
`brainstem.destination/v2`: `handle(ctx, output)` receives the serializable `brainstem.output` payload plus `ctx.idempotencyKey` instead of live plugin objects. This is required, because live objects cannot cross a queue. All built-in plugins are migrated in Phase 2. A v1 adapter keeps third-party plugins working and logs a deprecation warning. It is removed in 3.0. The input SDK stays v1; inputs gain an optional `ctx.lease` for long-lived connections.

**D5 — Config is versioned, JSON-Schema-validated data in the database; `.mjs` becomes an import/export format.** ([ADR-0005](adr/0005-config-as-versioned-data.md))
Today's API-written executable config is a code-execution surface behind `config:write`, and a shared file cannot be propagated to N pods. Config moves to `config_versions` with `If-Match` optimistic concurrency, an audit trail, rollback and hot reload via notifications. `brainstem config import|export` keeps `brainstem.config.mjs` working: the module is evaluated locally by the operator and must export plain data. `configSource: file` (Helm) / `BRAINSTEM_CONFIG_SOURCE=file` makes the UI read-only for GitOps users. Users with JS logic in their config are covered in the 1.x → 2.0 upgrade guide.

**D6 — The Laya model ships as a separate versioned `brainstem-models` OCI image.** ([ADR-0006](adr/0006-model-distribution-oci-image.md))
Downloading at startup ruins autoscaling, and ReadOnlyMany PVCs are unavailable on many clusters. An image is cached per node, pinned to a model version, and published alongside each release by the same CI pipeline. Kubernetes ≥1.31: image volume. Older clusters: an init container copies it into an `emptyDir`. `role=all` / Docker: the existing download-on-first-start cache remains the default.

## 8. Main risks

| Risk | Mitigation |
|---|---|
| Sync → async store refactor touches the core's semantics | Phase 0 tests first; do it before any distribution work |
| Postgres queue bloat / NOTIFY contention | Delete/archive done jobs, partition `events`, short claim txns, batched NOTIFY, monitor autovacuum |
| Mixed versions during rolling deploys | Versioned job payloads; migrations expand-then-contract; hook Job only |
| Laya cold start blocks autoscaling | Pre-baked model, startup probe, min replicas ≥ 2 |
| Third-party plugins break on SDK v2 | v1 shim, deprecation warnings, migration guide |
| Duplicates during failover | Documented at-least-once window, idempotency keys, delivery log check |
