# Upgrading from 1.x to 2.0

Brainstem 2.0 keeps the 1.x single-node setup working: one process, SQLite, a `brainstem.config.mjs`. Most installs upgrade by changing the image tag. This guide lists what changes, in the order you meet it, and then how to move to cluster mode if you want to.

Read the [CHANGELOG](../CHANGELOG.md) entries from your version up to 2.0.0 for the full list.

## Before you start

1. **Back up your data.** With Docker, that's the `brainstem-data` volume (`data/` holds `brainstem.sqlite`, plus `web-stats.sqlite` and `checkpoints.json` from 1.x). With Postgres, `pg_dump`.
2. **Check your config is plain data** if you want to edit it in the Web UI later. Run `node brainstem.mjs config validate`; it reports functions, which only work with the file source (see below).
3. **Note any third-party destination plugins** (`apiVersion: "brainstem.destination/v1"`). They keep working, but see [Plugins](#destination-plugins).
4. Stop the old process or containers. Don't run 1.x and 2.0 against the same data at once.

## Upgrade single node (most installs)

```sh
# docker-compose.yml: image: ghcr.io/jurrebuunk/brainstem:v2.0.0
docker compose pull && docker compose up -d
```

or, from npm or a checkout: `npm install -g @brainstem-dev/brainstem` (2.1+; then `brainstem init` for the plugins) / `git pull && npm ci`, then start it as before.

On first start, `--role all` (the default):

- applies the database migrations (`0001`–`0005`);
- imports the 1.x state files once (`web-stats.sqlite`, `checkpoints.json`, `matrix-notifications.json`), only reading them. To do it by hand first, run `node brainstem.mjs migrate import-v1 --data-dir data`;
- keeps using your config file.

Check it with `node brainstem.mjs migrate status`, open the Web UI, and watch the first polls.

## What behaves differently

### State lives in one database

Records, checkpoints, plugin state, telemetry, stats, users, jobs and deliveries live in one database: SQLite (`sqlite:data/brainstem.sqlite`, the default) or Postgres (`BRAINSTEM_DATABASE_URL`). With no `records`/`checkpoints` config, state is now persistent: 1.x kept records in memory and checkpoints in JSON. Explicit `memory`, `json` and `sqlite` types still work. Moving SQLite to Postgres: `node brainstem.mjs migrate copy --from sqlite:data/brainstem.sqlite --to postgres://...`.

### Deliveries are jobs, retried on their own

Each decision goes to each matching destination as its own job, with its own retries and backoff (`runtime.queue.deliver.retry`, or `retry` on the destination). A failing destination no longer re-runs the poll or other destinations. Deliveries that use up their attempts become **dead**: see the Deliveries page to redrive or discard them. `runtime.destinations.blockInputOnFailure` is ignored. See [Delivery pipeline](delivery-pipeline.md).

### Inputs are scheduled in the database

When the pipeline uses the database (the default), input schedules are leases in the `inputs` table. A restart no longer polls every input at once; it polls each one when it is next due. For the 1.x behaviour, set `runtime.inputs.scheduling: "timer"`.

### The API never writes the config file

`PUT /api/config` no longer writes `brainstem.config.mjs`. With the default `configSource: "file"`, the Web UI shows the config read-only. Mount the file read-only. To edit config in the UI:

```sh
node brainstem.mjs config import --comment "from 1.x"
BRAINSTEM_CONFIG_SOURCE=database node brainstem.mjs
```

Config in the database must be plain data. Functions in a config file (for example `agentos-runner` `tools.*.run`, or custom Matrix `notificationKey`) only work with the file source. Keep using the file source if you rely on them. See [Configuration](configuration.md#versioned-config).

### Callbacks and handed-off observations

- Config callbacks of built-in destinations (Matrix `notificationKey`, opencode-runner `titleForEvent` and `promptTemplate`) receive the output payload. `decision`, `observation` and `pollId` are unchanged; `input` and `destination` are plain objects (`{ id, plugin, name, module }`) instead of live plugin objects.
- An observation a destination hands back (`ctx.emit`) has an empty `input` and an `origin` naming the destination, instead of a fake input `destination:<id>`.

### Docker image

- The image omits optional dependencies (the agentOS VM runtime). Build with `--build-arg INSTALL_OPTIONAL=true` to use `agentos-runner` in Docker.
- The runtime image has no `npm`, `npx` or `yarn`. Run one-off commands with `node brainstem.mjs <command>`.
- `GET /metrics` is on. Don't expose the API port publicly, or set `BRAINSTEM_METRICS_TOKEN`.

### Defaults that changed

| Setting | 1.x | 2.0 |
|---|---|---|
| `runtime.cores.heartbeatMs` | – (no registry) | 5000 |
| state without `records`/`checkpoints` config | memory / JSON | the database |
| input scheduling with the database pipeline | timers | leases |
| config written by the API | yes | never |

## Destination plugins

v1 destinations keep working through an adapter until 3.0 and log a deprecation warning once. They get at-least-once delivery without deduplication unless they use `ctx.idempotencyKey`. Migrate them with the [plugin v2 guide](plugin-v2-migration.md). Input plugins are unchanged; they gain an optional `ctx.lease` and durable `ctx.state`.

## Moving to cluster mode (optional)

Cluster mode runs several processes on Postgres: an API, the Web UI and cores that share inputs, decisions and deliveries. Use it for HA or when one process isn't enough. It isn't needed otherwise.

1. Move to Postgres (`migrate copy`, above) and set `BRAINSTEM_DATABASE_URL`.
2. Store the config as data: `node brainstem.mjs config import`, `BRAINSTEM_CONFIG_SOURCE=database`.
3. Run the processes: [docker-compose.cluster.yml](docker.md#cluster-mode) on one machine, or the [Helm chart](kubernetes.md) on Kubernetes. `brainstem migrate` runs once per upgrade, from a Job or by hand. Cluster processes never migrate on their own.

See [Cluster mode](cluster.md) for how work is shared, and the [ops runbook](runbook.md) for running it.

## Rolling back

An older version refuses to start on a database migrated by 2.0, because its migrator doesn't know the newer migrations. To go back:

1. Stop 2.0.
2. Restore the backup from step 1.
3. Start the old image.

Anything 2.0 wrote after the upgrade (new records, deliveries, users) is lost. Upgrade a copy first if you need to be sure.
