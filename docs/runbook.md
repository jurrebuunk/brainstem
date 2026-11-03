# Operations runbook

Running Brainstem in production, mostly cluster mode on Kubernetes ([Kubernetes](kubernetes.md)). Most of it also applies to Docker Compose and single-node installs.

## Health at a glance

| Question | Where |
|---|---|
| Are cores alive, and on which config version? | Web UI → Cores panel; `GET /api/topology`; `brainstem_cores{status}` |
| Is work piling up? | Web UI → Deliveries (queue depth, dead jobs); `brainstem_queue_ready`, `brainstem_queue_oldest_age_seconds` |
| Are inputs polled on time? | `GET /api/inputs` (lease owner, next due, last poll and error); `brainstem_input_schedule_lag_seconds` |
| Is a destination failing? | Deliveries page (filter by destination); `brainstem_deliveries_total{outcome}` |
| Where did one envelope go? | the trace for its `trace_id`, or the inspector in the Web UI |

Probes: `/livez` (event loop), `/readyz` (database reachable, not draining), `/startupz`. Alerts and the dashboard are in [Observability](observability.md).

## Delivery guarantees

The chaos suite (`npm run test:chaos`, run in CI) checks these by killing, freezing and cutting off real core processes and the database:

- **No lost observations.** A checkpoint commits in the same transaction as the decide jobs for what it polled. A core that dies mid-poll commits nothing, and another core polls the same data again.
- **No observation emitted twice.** Every input claim bumps a fencing epoch. A core frozen past its lease (GC pause, partition) can't commit when it wakes up.
- **At-least-once delivery, once per idempotency key.** A delivery repeats only when its core died, or lost the database, after the receiver acted and before the commit. It repeats under the same key, so receivers that honour `ctx.idempotencyKey` act once.
- **Failover window.** A core that disappears without shutting down counts as lost after 3 missed heartbeats (`runtime.cores.heartbeatMs`, 5 s → 15 s). Its input leases and jobs move on within about 5 s after that. A graceful shutdown (SIGTERM, drain) releases them at once.
- **Database outage or failover.** Processes stay up. Queries fail fast (10 s connect timeout, 30 s query timeout), jobs retry with backoff, and the notification listener reconnects (and pings its connection every 15 s). Polling resumes without manual action once Postgres is back.

## Common situations

### Dead deliveries

A delivery that used up its attempts is **dead** (alert `BrainstemDeadJobs`).

1. Deliveries page → filter `dead` → read `last error`.
2. Fix the cause: credentials, the receiver, or a config filter.
3. **Redrive** (one or all). It retries with fresh attempts under the same idempotency key, so receivers dedupe anything that did go through. **Discard** drops it.

Dead decide jobs mean the core couldn't decide. That usually comes from the model (out of memory, a missing model dir) or a record store error: check the decide cores' logs.

### Backlog growing (`BrainstemQueueBacklog`)

- `queue="deliver"`: a slow or failing destination.
  - Check `brainstem_deliveries_total{outcome="failed"}` and its p95 duration.
  - Add deliver replicas, or raise `runtime.queue.deliver.concurrency` for I/O-bound destinations.
  - With KEDA this scales by itself, up to `maxReplicas`.
- `queue="decide"`: decisions are slower than arrivals.
  - Add decide replicas, or raise `--decide-concurrency` (memory grows about 0.5 GB per worker).
  - Laya is CPU-bound, so give decide pods real CPU.

[Load testing](load-testing.md) shows the per-core numbers.

### No healthy core (`BrainstemNoHealthyCore`)

- `kubectl get pods -l brainstem.io/role=core`: CrashLoopBackOff? Read the logs. Common causes:
  - **schema not up to date**: run the migration Job, or wait for `BRAINSTEM_SCHEMA_WAIT_MS`;
  - **database unreachable**;
  - **model missing**: decide pods need `models.enabled` or network access to download it.
- Pods running but `/readyz` failing: the database is unreachable from the pod. Check network policies, the secret and Postgres.

### Inputs overdue (`BrainstemInputsOverdue`)

No running core with the `poll` queue claims due inputs.

1. Check that the poll Deployment has ready replicas.
2. Check `GET /api/inputs` for `lastError`.
3. An input whose `leaseOwner` is a core that doesn't exist anymore is claimable once that core counts as lost. If it stays leased, check the core registry (`brainstem_cores{status="lost"}`) and clock skew between nodes: leases and heartbeats use each core's own clock, so keep node clocks in sync (NTP).

### Config change went wrong

- Every save is a version. Roll back by activating the previous one in Web UI → Settings → Config → History, or with `brainstem config activate <id>`. Cores reload within seconds.
- A version that fails to load is logged by each core, and that core keeps running the previous version. The Cores panel shows the config version each core runs.

### Draining a node

`kubectl drain` respects the PodDisruptionBudgets: one pod per Deployment at a time. Each core finishes in-flight work (up to `drainTimeoutMs`), releases its leases and marks itself stopped. Nothing is lost if a pod is killed anyway. It takes the failover window instead.

## Upgrades

1. Read the CHANGELOG ("Upgrading").
2. Back up Postgres. CloudNativePG: a backup or a `pg_dump`.
3. `helm upgrade`. The migration hook runs `brainstem migrate` first, then pods roll one at a time.
   - Migrations only add things within a major version (expand, then contract), so old and new pods work side by side during the roll.
   - Job payloads are versionless JSON, and new fields are optional.
4. Watch: Cores panel (versions and config versions), queue depth, error rate.

Rollback within 2.x: `helm rollback`. A newer schema is fine for older 2.x pods as long as no contract migration ran; the CHANGELOG says when one does.

## Capacity

| Component | Sizing |
|---|---|
| decide core | ~1.5 GB for the model plus ~0.5 GB per Laya worker; CPU-bound |
| deliver core | 256–512 MB; scale on backlog |
| poll core | 256 MB; 2 replicas for HA, more only with many slow inputs (`runtime.inputs.concurrency`) |
| API | 256–512 MB; CPU for argon2 logins (`UV_THREADPOOL_SIZE=8`) |
| Postgres | small: Brainstem's own overhead is ~15–20 ms per job; size for connections (see below) |

Postgres connections per process: the pool (default 10, `runtime.database.pool.max`) plus one LISTEN connection. 20 pods use about 220 connections. Use a session-mode pooler, or lower `pool.max` for small pods. Transaction pooling breaks LISTEN and advisory locks.

## Housekeeping

These run on their own, under advisory locks, so one process does each:

- delivered rows pruned after `runtime.deliveries.pruneAfterDays` (14);
- telemetry and stats after `WEB_EVENTS_PRUNE_AFTER_DAYS` / `STATS_PRUNE_AFTER_DAYS` (14);
- cores unseen for 24 h and inputs undeclared for 7 days removed;
- expired sessions removed.

Keep an eye on table bloat for `jobs` and `events` on busy installs. Autovacuum handles the default load.

## Useful commands

```sh
brainstem migrate status                 # schema version
brainstem config list | show | activate  # config versions and rollback
brainstem config export --out live.mjs   # back up the active config
kubectl logs -l brainstem.io/role=core --prefix --tail=50
kubectl port-forward svc/<release>-brainstem-api 5174 && curl -s localhost:5174/metrics | grep brainstem_queue
```
