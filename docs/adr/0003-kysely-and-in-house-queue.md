# 0003. Kysely for the DB layer, with an in-house queue

- Status: Accepted
- Date: 2026-10-13

## Context

The record store is a synchronous local `DatabaseSync` SQLite with no `busy_timeout`. Per-ID ordering (a `locks` Map) and the read-then-write `revision` update are process-local only (`src/core/record-stores.mjs`, `src/core/brainstem.mjs:40,226`). Checkpoints and Matrix suppression state are JSON files (`src/runtime/checkpoints.mjs`, `plugins/matrix/notify.mjs:12-22`).

2.0 needs:

- One schema running on SQLite (`role=all`) and Postgres (cluster), with migrations for both.
- Async stores (`RecordStore`, `CheckpointStore`, telemetry, auth).
- A job queue with **identical semantics on both databases**: per-key serialization (to replace the `locks` Map), dedupe, wakeups, and visibility timeouts with reclaim of stalled jobs.

The `CheckpointStore` and `RecordStore` interfaces (`src/runtime/stores.mjs:35`) already give a seam to swap the implementation behind.

## Decision

Use **Kysely** as the DB layer, with its SQLite and Postgres dialects and its built-in migrator. Timestamps are stored as epoch ms or ISO, JSON as `jsonb` / `TEXT`, and both dialects use `ON CONFLICT` + `RETURNING`.

Build the queue in-house on Kysely (~300 lines), copying graphile-worker's design:

- `queue_key` for per-key serialization (e.g. one `decide` at a time per `observation_id`)
- `job_key` for dedupe
- `LISTEN/NOTIFY` wakeups on Postgres, an in-process EventEmitter on SQLite
- visibility timeouts with reclaim; a job is never marked done at claim time

## Alternatives considered

- **pg-boss** — rejected. Postgres-only, so SQLite would need a second queue implementation with its own semantics.
- **graphile-worker** — rejected for the same reason, though its design is what we copy.
- **Drizzle** — rejected. It needs a schema file per dialect, whereas Kysely uses one schema for both.
- **Keep `DatabaseSync`** — rejected. It is synchronous, SQLite-only and blocks the event loop on hot paths.

## Consequences

Positive:

- One schema, one migrator and one queue implementation for both deployment modes.
- No ORM magic. Queries stay explicit, SQL-shaped JS, which keeps the queue's locking behaviour visible.
- `brainstem migrate` and `brainstem migrate sqlite-to-pg` build on the same migrator.

Negative:

- We own the queue code: correctness under concurrency, reclaim and backoff are ours to test and maintain.
- The sync-to-async store refactor touches the core's semantics. Phase 0 tests are the guard.
- Dialect differences (locking, `SKIP LOCKED` vs. `BEGIN IMMEDIATE`) still exist inside the drivers.

Follow-ups:

- Introduce Kysely, make stores async, add Postgres dialect and migrations, fix `busy_timeout` (Phase 1).
- Queue with `jobs` / `deliveries` tables and the `sqlite` transport driver (Phase 2).
- `postgres` transport driver (Phase 3, see [ADR-0001](0001-postgres-only-cluster-mode.md)).
