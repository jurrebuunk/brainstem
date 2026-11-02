# Delivery pipeline

Brainstem moves every observation through three stages. The stages are connected by jobs stored in the database, so work survives restarts and a failing destination is retried on its own.

```
          ┌──────────── one transaction ────────────┐
input ─▶ poll ─▶ decide jobs + checkpoint
                      │
decide job ─▶ Brainstem.process ─▶ record (compare-and-set) ─▶ delivery rows + deliver jobs + ack
                                                                     │
deliver job ─▶ destination.handle(ctx, output) ─▶ delivery row: delivered / failed / dead
```

- **poll**: the input runs as before. Its observations are stored as `decide` jobs in the same transaction that advances the input checkpoint. A checkpoint never moves past an observation that is not stored, and a crash before the commit means the input is polled again.
- **decide**: runs the core on one observation. Decide jobs for the same observation ID run one at a time, in the order they were polled. The record write is a compare-and-set on its revision. The stage then creates one delivery row and one `deliver` job per matching destination. These rows and jobs commit together with the decide job's acknowledgement.
- **deliver**: calls one destination with one decision. A failure only retries that destination. Other destinations, the decision and the poll are not repeated.

Each stage commits its outputs and the next stage's jobs in one transaction, so the `jobs` table also acts as the outbox. A job is only removed when the work it describes has committed.

## Guarantees

- **At least once.** Every observation an input emits is decided, and every decision is delivered to every matching destination, unless the job runs out of attempts. Jobs that run out of attempts become dead jobs, and an operator can redrive them.
- **Exactly-once effect where the destination supports it.** Each delivery has an *idempotency key*. The key stays the same across every retry of that delivery. Built-in destinations pass it on:
  - `http-json` sends it as the `Idempotency-Key` header.
  - Matrix uses it as the `txnId`, so a retried send does not post the message twice.
  - opencode-runner keys its session on it: a retry resumes the session it already created instead of starting another agent run.
- **Delivery log check.** Before sending, the deliver stage checks the `deliveries` table. A deliver job that runs again after its delivery was recorded, for example after a lost acknowledgement, is acked without sending.
- **Ordering.** Decisions for one observation ID are made in poll order. Deliveries for one (destination, observation) pair are sent in decision order, so an alert is not overtaken by its recovery. There is no global ordering.

When it is unclear whether a send worked, for example after a timeout, Brainstem retries. A duplicate is better than a missed escalation. Destinations that honour the idempotency key drop the duplicate.

### Idempotency key

```
<destination id>:<observation id>:r<revision>:<emission id>
```

The emission id is fixed when the observation is polled. Retries of the same delivery keep the key. An input that re-emits an unchanged observation, such as a reminder for an alert that is still firing, creates a new emission, so the reminder is delivered again.

The destination id is the destination entry's `id`. Without one it is `<plugin>.<destination>.<index>`, which changes when you reorder `destinations`. **Give every destination an `id`.** Ids must be unique.

## Retries and dead jobs

A failed job is retried with exponential backoff and jitter. The delay is `minDelayMs × factor^(attempt-1)`, capped at `maxDelayMs`, and half of it is randomised. After `attempts` tries the job becomes **dead**: it stops running and waits for an operator.

| Queue | Default attempts | Default backoff |
|---|---|---|
| `decide` | 5 | 1s → 60s, ×2 |
| `deliver` | 8 | 5s → 15min, ×3 (≈ 30 min in total) |

A destination can throw an error with `permanent: true` (or `PermanentJobError` from `src/queue/index.mjs`). The job then skips its remaining attempts and goes straight to dead. Use this for errors that a retry cannot fix, such as invalid configuration or a 4xx response that will not change.

Each running job holds a lease (`leaseMs`, 60s by default), which is renewed every `leaseMs / 3`. If a process crashes, its leases expire and the jobs are retried. A job whose lease expires on its last attempt becomes dead.

On shutdown, jobs that are interrupted are handed back without counting the attempt.

### Redrive

The **Deliveries** page in the web UI shows queue depth, the delivery log and dead jobs. Users with `runtime:control` can **redrive** dead jobs, which re-queues them with fresh attempts, or **discard** them. Users with `runtime:read` can view the page.

The same actions are available over the API:

```
GET  /api/pipeline                      queue and delivery-log counts
GET  /api/jobs?state=dead&queue=deliver jobs (state: ready | running | dead)
GET  /api/deliveries?status=dead        delivery log (pending | failed | delivered | dead | discarded)
POST /api/jobs/redrive   { "ids": [12, 13] }
POST /api/jobs/discard   { "ids": [14] }
```

A redriven job is picked up on the runtime's next queue poll (`pollIntervalMs`), even when the API runs in a separate process.

## Configuration

```js
runtime: {
  queue: {
    transport: "database",   // or "memory"; see below
    pollIntervalMs: 1000,    // how often idle workers look for due jobs
    leaseMs: 60000,
    decide: {
      concurrency: 4,
      retry: { attempts: 5, minDelayMs: 1000, maxDelayMs: 60000, factor: 2 }
    },
    deliver: {
      concurrency: 4,
      retry: { attempts: 8, minDelayMs: 5000, maxDelayMs: 900000, factor: 3 }
    }
  },
  deliveries: {
    pruneAfterDays: 14       // delivered and discarded rows; dead rows are kept
  }
}
```

A destination entry can override the deliver retry policy:

```js
{ id: "pager", module: "./plugins/http-json/index.mjs", retry: { attempts: 20, maxDelayMs: 600000 } }
```

`runtime.retry` still controls retries of a failing **input poll**. It no longer covers decisions or deliveries.

### Transports

| Transport | When | Durable |
|---|---|---|
| `database` | Default when checkpoints are in the database (the default since 2.0 Phase 1). Uses the `jobs` and `deliveries` tables on SQLite or Postgres. | yes |
| `memory` | Default when checkpoints are `memory` or `json`. | no: jobs waiting for a retry are lost on exit |

The database transport works on SQLite and Postgres. Each claim is a single atomic statement, and on Postgres it uses `FOR UPDATE SKIP LOCKED`. Wakeups are in-process, and other processes are picked up on the next poll. The roadmap's Postgres cluster driver (Phase 3) adds `LISTEN/NOTIFY` and lease-based input scheduling. Until then, run **one** runtime per database. Running more makes each one poll every input; the acceptance tests in `tests/acceptance` track this.

## Handoff: destinations emitting observations

A v2 destination can hand an observation back to the core with `ctx.emit(observation)`. For example, an agent task's report can be picked up by Matrix or by a bigger agent. Emitted observations go through the normal decide stage, including the policy, `facts.minimum_decision` and the destination filters.

- **Committed with the delivery.** Emitted observations are enqueued in the same transaction that marks the delivery delivered. A delivery that fails or is retried emits nothing twice.
- **Never back to the chain.** Each emitted observation carries a lineage, the destinations it passed through. It is never delivered to a destination already in that lineage, so a destination can't trigger itself.
- **Bounded depth.** `runtime.handoff.maxDepth` (default `2`) limits how many hops a chain can take. `ctx.emit` throws past it. `runtime.handoff.maxPerDelivery` (default `5`) limits emits per delivery.
- **Origin.** An emitted observation has no input. Its decision and output envelope carry `origin: { kind: "destination", id, plugin, name, depth, lineage }` instead, and `input` fields are `null`. Observations from inputs carry `origin: { kind: "input", id }`. Telemetry adds a `brainstem.destination.emitted` event per handoff (see [Telemetry](telemetry.md#identity-fields)).

```js
runtime: {
  handoff: { maxDepth: 2, maxPerDelivery: 5 }
}
```

## Run once

`node brainstem.mjs --once` polls every input once, then runs every job that is due until none are left, including deliver jobs created by this run's decisions. Retries that are not due yet stay in the database for the next start. The command exits non-zero if any poll or job failed during the run.

## Upgrading from 1.x

- `runtime.destinations.blockInputOnFailure` is ignored and logs a warning. Destinations no longer block checkpoints; they are retried on their own instead.
- An observation whose decision fails no longer holds back the input checkpoint. It stays queued as a decide job, is retried, and can be redriven.
- Destinations run outside the poll loop, so a slow destination no longer delays polling.
- Destination plugins move to `brainstem.destination/v2`. v1 plugins keep working through an adapter until 3.0; see [Destination adapters](destination-adapters.md#migrating-from-v1).
