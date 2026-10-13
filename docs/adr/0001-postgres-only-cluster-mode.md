# 0001. Cluster mode uses Postgres only; no message broker

- Status: Accepted
- Date: 2026-10-13

## Context

Brainstem 1.x has no work queue. Every replica polls every input, evaluates every observation and delivers every decision (`src/runtime/runtime.mjs:153,354-379`), so running N processes does N times the work and N times the deliveries. To scale out, polls, decisions and deliveries must become durable jobs that any core can claim (roadmap §4.2).

That needs a shared queue. The constraints (roadmap §1):

- Single-node `docker run` with SQLite and zero extra infrastructure must keep working (`--role=all`).
- Hobby users must never be forced to run Postgres, Redis or NATS.
- Cluster mode should add as few stateful dependencies as possible.

Each pipeline stage must commit its results and the next stage's jobs atomically (transactional outbox), and checkpoints may only advance once observations are durably stored.

## Decision

In cluster mode, Postgres is both the system of record and the job queue, using `FOR UPDATE SKIP LOCKED` for claims and `LISTEN/NOTIFY` for wakeups. No message broker ships in 2.0.

Jobs sit behind a `Transport` interface (`enqueue`, `claim`, `ack`, `nack`, `extend`, `notify/subscribe`) with a `sqlite` driver (default, `role=all`) and a `postgres` driver (cluster). The interface leaves room for a NATS JetStream driver in a later release, but none is built for 2.0.

## Alternatives considered

- **NATS JetStream** — rejected for 2.0. It adds a second stateful system to operate and back up, and the job and its result can no longer be committed in one transaction, which breaks the transactional outbox. Brainstem's volume (polls and decisions, not millions of events/s) does not need it. It stays possible later as a `Transport` driver.
- **Redis (incl. BullMQ)** — rejected for the same reasons: an extra stateful dependency outside the DB transaction. n8n's queue mode, which makes Redis mandatory and drops SQLite, is the pattern we explicitly avoid.
- **A broker in single-node mode too** — rejected. It violates the zero-extra-infrastructure constraint for `role=all`.

Windmill and Kestra OSS show that a Postgres-backed queue scales well beyond Brainstem's needs.

## Consequences

Positive:

- One stateful dependency in cluster mode: one thing to back up, monitor and fail over (CloudNativePG or managed Postgres).
- "Job done + results + next jobs" commit atomically in one transaction.
- SQLite and Postgres share the same schema and queue semantics, so `role=all` stays first-class.
- KEDA can autoscale directly on a SQL query against `jobs`.

Negative:

- Throughput ceiling of roughly 1–10k jobs/s; past that a broker driver would be needed.
- Risk of queue bloat and NOTIFY contention. Mitigations: delete or archive done jobs, short claim transactions, batched NOTIFY with IDs only, autovacuum monitoring (roadmap §8).
- `LISTEN` and advisory locks need a direct connection, not a PgBouncer transaction-mode pool.

Follow-ups:

- `Transport` interface and `sqlite` driver (Phase 2).
- `postgres` driver with SKIP LOCKED and LISTEN/NOTIFY (Phase 3).
- Load test to confirm throughput headroom; tune claim batch size (Phase 5).
