# Cluster mode

Brainstem runs as one process by default (`--role all`, SQLite). Cluster mode runs the same image as several processes against one Postgres database. Any core can do any piece of work, a lost core loses no observations, and you scale the stages you need. The design is in [roadmap-2.0.md](roadmap-2.0.md) and ADRs [0001](adr/0001-postgres-only-cluster-mode.md), [0002](adr/0002-lease-based-input-scheduling.md), [0005](adr/0005-config-as-versioned-data.md) and [0006](adr/0006-model-distribution-oci-image.md).

Single-node mode is unchanged and stays first-class: nothing on this page is needed for it.

## Roles

```
node brainstem.mjs --role all|core|api|web      (env BRAINSTEM_ROLE)
                   --queues poll,decide,deliver  (env BRAINSTEM_QUEUES, core only)
```

| Role | Runs | Probes |
|---|---|---|
| `all` | everything in one process; the API when `runtime.api.enabled`; migrates on start | API port when enabled, `--health-port` when set |
| `core` | the runtime for `--queues` (default all three) | `--health-port`, default `8081` |
| `api` | REST, SSE, auth and config versions (same as `brainstem-api.mjs`) | its own port |
| `web` | the Web UI and its `/api` proxy (`web/server.mjs`, Docker image only) | – |

Queues split the pipeline into worker groups without separate code paths:

| Queue | Work | Loads |
|---|---|---|
| `poll` | claims due inputs by lease and polls them | input plugins |
| `decide` | evaluates observations with Laya | the model, destination filters |
| `deliver` | sends deliveries to destinations | destination plugins |

Only cores with `decide` load the 1.9 GB model, so a `core --queues deliver` replica for slow destinations stays small. Running fewer than all three queues needs the database transport, since the other stages run in other processes.

## Quick start (Postgres)

```sh
export BRAINSTEM_DATABASE_URL=postgres://brainstem:secret@db:5432/brainstem
export BRAINSTEM_CONFIG_SOURCE=database

node brainstem.mjs migrate                       # once per release (a deploy hook)
node brainstem.mjs config import --file brainstem.config.mjs

node brainstem.mjs --role api --port 5174 &
node brainstem.mjs --role core --queues poll,decide --decide-concurrency 2 &
node brainstem.mjs --role core --queues deliver &
```

`core` and `api` never migrate: they refuse to start while migrations are pending (`BRAINSTEM_MIGRATE=true` overrides that for small setups). Run `brainstem migrate` once per upgrade, from a Kubernetes or Helm pre-upgrade Job or by hand.

## How work is shared

- **Jobs** (decide, deliver) are claimed with `FOR UPDATE SKIP LOCKED`; a claim is a lease that the worker renews. Jobs of a crashed core return to the queue when their lease expires. See [Delivery pipeline](delivery-pipeline.md).
- **Inputs** are scheduled as data in the `inputs` table. Each core declares the inputs it loaded; any core with `poll` claims a due, unleased input, which bumps its `lease_epoch`. It polls the input while renewing the lease, and commits observations and the checkpoint in one transaction that checks the epoch is still its own (fencing). A stale poller after a GC pause or a network partition can therefore never commit. Next due times get a little jitter (up to 10 % of the interval, at most 5 s).
- **Failover**: a lease held by a core the registry reports `stopped`, or `lost` (3 missed heartbeats), is claimable at once. Otherwise it expires after `runtime.inputs.leaseMs`. Within that window delivery is at-least-once: a core killed after a destination accepted a delivery but before it committed is retried, and the idempotency key makes that harmless for destinations that honour it.
- **Wakeups** use `LISTEN/NOTIFY` on the channel `brainstem`, with one direct connection per process. New jobs, input releases, config changes and telemetry wake idle processes everywhere at once. Polling (`runtime.queue.pollIntervalMs`, `runtime.inputs.checkIntervalMs`) remains the fallback.
- **Singletons** (retention pruning, API maintenance, delivery-log pruning) run under a Postgres advisory lock, so only one process does each at a time.

`GET /api/inputs` lists every input with its lease owner, epoch, next due time and last poll. `GET /api/topology` lists the cores with their queues and config version.

## Config as data

In cluster mode the pipeline config lives in the database (`BRAINSTEM_CONFIG_SOURCE=database`): every process runs the active version and reloads it without a restart when it changes. See [Configuration](configuration.md#versioned-config). The config file, if a process has one, only supplies its bootstrap settings: `runtime.database`, `api`, `logging`, `telemetry`, `coreId`, `role` and `queues`.

## Graceful shutdown

On `SIGTERM` a core:

1. reports not ready (`/readyz` returns 503);
2. stops claiming inputs and jobs;
3. lets in-flight polls and jobs finish for up to `runtime.shutdown.timeoutMs` (default 25 s; `--drain-timeout`);
4. aborts whatever is left (those jobs go back to the queue without using an attempt), releases its input leases, and marks itself `stopped` in the registry.

A second signal aborts at once. The API fails readiness, ends SSE streams so clients reconnect to another replica, then closes. Set `terminationGracePeriodSeconds` above the drain timeout, and add a short `preStop` sleep so the load balancer notices first; `BRAINSTEM_DRAIN_DELAY_MS` does the same for the API.

## Probes

| Path | Meaning |
|---|---|
| `/livez` | the event loop is alive. Never touches the database, so a database outage doesn't restart pods. |
| `/readyz` | started, not draining, database reachable within 2 s |
| `/startupz` | started: schema checked, plugins and (for `decide`) the model loaded |

## Real-time UI across replicas

Each API replica persists the telemetry it receives, then announces the row ids on the notifier. Every replica streams those events to its own SSE clients. Events carry `id:` lines, so a reconnecting browser resumes from `Last-Event-ID` on whichever replica the load balancer picks, with no sticky sessions. The login rate limit is in the database and keyed by `X-Forwarded-For` from `BRAINSTEM_TRUSTED_PROXIES`.

## Laya workers and the model image

`--decide-concurrency N` (or `runtime.laya.workers` and `runtime.queue.decide.concurrency`) runs N decide jobs at once, each on its own Laya worker thread. Each worker holds its own ONNX session from the same model files, so memory grows with N. Evaluations never block the event loop that renews leases.

The model ships as its own image, `ghcr.io/jurrebuunk/brainstem-models:laya-<version>` ([Dockerfile.models](../Dockerfile.models)), built by the same CI pipeline. Mount it and point Brainstem at it, and nothing is downloaded at start:

```yaml
# Kubernetes >= 1.31: image volume
volumes:
  - name: laya
    image: { reference: ghcr.io/jurrebuunk/brainstem-models:laya-0.1.1 }
containers:
  - name: core
    env: [{ name: BRAINSTEM_LAYA_MODEL_DIR, value: /models }]
    volumeMounts: [{ name: laya, mountPath: /models, readOnly: true }]
```

On older clusters, copy it into an `emptyDir` with an init container (`cp -r /models/. /shared/`). Single-node Docker keeps downloading into `data/laya-cache` on first start.

## Caveats

- `LISTEN` and advisory locks need a direct Postgres connection, not a PgBouncer transaction pool. Point `BRAINSTEM_DATABASE_URL` at Postgres or a session-mode pooler.
- Config keys that need a restart rather than a hot reload: `runtime.database`, `records`, `checkpoints`, `queue.transport`, `inputs.scheduling`, `cores`, `role` and `queues`.
- Config stored in the database must be plain data. Functions in a config file (for example `agentos-runner` `tools.*.run`) only work with `configSource: file`.
- SQLite works for several processes on one host (the acceptance tests do this), but wakeups don't cross processes and there are no advisory locks. Use Postgres for anything spread across hosts.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `BRAINSTEM_ROLE` | `all` | process role |
| `BRAINSTEM_QUEUES` | all | core queues |
| `BRAINSTEM_CONFIG_SOURCE` | `file` | `file` or `database` |
| `BRAINSTEM_MIGRATE` | `true` for `all` | migrate on start |
| `BRAINSTEM_HEALTH_PORT` / `_HOST` | `8081` (core) / `0.0.0.0` | probe server |
| `BRAINSTEM_CORE_ID` | `<host>:<pid>:<random>` | core id |
| `BRAINSTEM_LAYA_WORKERS` | `0` (in-thread) | Laya worker threads |
| `BRAINSTEM_LAYA_MODEL_DIR` | – | mounted model directory |
| `BRAINSTEM_CONFIG_CHECK_MS` | `30000` | fallback check for config changes |
| `BRAINSTEM_DRAIN_DELAY_MS` | `0` | API: wait after failing readiness |
