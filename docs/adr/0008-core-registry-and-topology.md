# 0008. Core registry with heartbeats as the source of topology

- Status: Accepted
- Date: 2026-11-02

## Context

The Web UI built its graph from the latest `brainstem.snapshot` telemetry event and from ids it happened to see in other events. With one runtime that mostly worked, but:

- With several cores (Phase 3, ADR-0001, ADR-0002), each core sends its own snapshots, so the graph would flip between them. The roadmap already flags this: "UI topology from latest snapshot flaps with >1 runtime".
- Destination nodes were keyed by plugin + destination name, so two entries of one plugin (two agentOS tasks) merged into one node.
- Nothing recorded which runtime processes exist or whether they are alive, so a crashed core was invisible.

Roadmap §4.7 plans "topology from the DB (config + per-core heartbeats in a `cores` table)".

## Decision

Each runtime process is a **core** with a stable `coreId` (`runtime.coreId`, `BRAINSTEM_CORE_ID`, or `<hostname>:<pid>:<random>`). The same id is the job worker id and is on every telemetry event.

Each core registers in a `cores` table (migration `0003_cores`) with its role, queues, version, host and pid, and **the topology it loaded**: its inputs and destinations with resolved ids and plugin names (`src/runtime/cores.mjs`).

- It registers on start, refreshes `last_seen_at` and its topology on every heartbeat (`runtime.cores.heartbeatMs`, default 10 s), and marks itself `stopped` on shutdown.
- A running core that misses 3 heartbeats is reported as `lost`. The API's maintenance task prunes rows unseen for 24 h.
- Registry errors are logged and never stop the runtime. The registry is active only when the runtime already uses a database.

`GET /api/topology` serves the cores plus the inputs and destinations from the most recently seen running core, with a `consistent` flag that is false when running cores loaded different topologies (`src/backend/api-server.mjs`). The Web UI builds its structure from it, keyed by configured id, and draws the cores as one core pool node plus a Cores panel.

## Alternatives considered

- **Keep deriving topology from snapshot events.** Rejected: flaps with several cores, depends on which events are still in the window, and has no notion of a dead core.
- **The API reads and executes the config file.** Rejected: executing JavaScript config in the API is what ADR-0005 moves away from, and the config file says what *should* run, not what a core actually loaded (plugin names and fallback ids are only known after loading).
- **Wait for config as versioned data (ADR-0005) and serve topology from `config_versions`.** Rejected for now: that is Phase 3 work, and the topology a core actually loaded remains useful once it exists, for example to detect cores still running an older config version.

## Consequences

Positive:

- One code path for one core today and many later: a single runtime is a registry with one row.
- The Web UI's structure no longer depends on which core spoke last, and entries of one plugin are separate nodes.
- Lost cores and config drift between cores become visible.

Negative:

- A heartbeat write every 10 s per core. That's negligible on SQLite and Postgres at the expected core counts.
- The served topology is what a core loaded, so it is empty until at least one core has started against the database.

Follow-ups:

- Phase 3: input leases and job reclaim can use `lost` cores to take over work faster than lease expiry alone.
- When config becomes versioned data (ADR-0005), record each core's config version in its row and compare it with the active version.
