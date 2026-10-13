# 0002. Lease-based input scheduling; no elected scheduler

- Status: Accepted
- Date: 2026-10-13

## Context

Polling today is a timer loop per input: `sleep(intervalMs)` inside each runtime, with no lease and no leader (`src/runtime/runtime.mjs:354`). Checkpoints live in `data/checkpoints.json`, are loaded once, cached and written last-write-wins (`src/runtime/checkpoints.mjs:76-98`).

With more than one replica, every replica polls every input, and two pollers can overwrite each other's checkpoints. StackStorm and Grafana show the usual failure modes: timers in every replica produce duplicates, and pinning inputs to nodes by hand produces gaps when a node dies.

Some inputs are long-lived connections (IMAP IDLE, future streaming inputs). Exactly one core must own them at a time, and ownership must move when that core dies.

## Decision

Scheduling is data on the `inputs` row (`next_due_at`, `lease_owner`, `lease_until`, `lease_epoch`). Any core claims due inputs with `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)` (roadmap §4.3). There is no elected scheduler and no scheduler role.

- Every claim increments `lease_epoch`. The checkpoint commit is fenced on it, so a stale poller (GC pause, network partition) cannot write.
- A dead core's leases expire and are reclaimed by others.
- `next_due_at` gets jitter to avoid thundering herds.
- Long-lived inputs hold and renew the same lease.
- A Postgres advisory lock is used only for true singletons: pruning, retention, stats rollups.

## Alternatives considered

- **Elected scheduler (leader via advisory lock) that dispatches poll jobs** — rejected. It costs about the same code, but it puts a leader on the hot path, leaves a failover gap while a new leader takes over, and does not balance load by itself. Long-lived inputs would need leases anyway.
- **Timers in every replica (status quo)** — rejected. It does N times the polling and causes duplicates.
- **Pinning inputs to specific nodes** — rejected. It needs manual partitioning, and losing a node leaves a gap in polling.

## Consequences

Positive:

- Load is balanced automatically across cores, with no leader and no failover gap.
- Fencing epochs make checkpoint writes safe under pauses and partitions.
- One mechanism covers both interval polling and long-lived connections.

Negative:

- Lease TTL is a trade-off: short TTLs mean more renewal traffic, long TTLs mean a longer gap after a crash. It needs tuning under load.
- Every checkpoint commit must carry and check the epoch. A missed fence check is a correctness bug.

Follow-ups:

- Move checkpoints from JSON into the `checkpoints` table (Phase 1).
- Transactional checkpoint commit together with observations and decide jobs (Phase 2).
- Leases with fencing epochs, `cores` heartbeat table, advisory-lock singletons (Phase 3).
- Optional `ctx.lease` for long-lived inputs (Phase 3, see [ADR-0004](0004-destination-plugin-sdk-v2.md)).
- Tune lease TTL and claim batch size; chaos-test core kills mid-poll (Phase 5).
