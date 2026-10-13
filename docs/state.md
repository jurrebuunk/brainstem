# State

Brainstem keeps all durable state in **one database**: SQLite for a single node (the default), Postgres for cluster deployments. Both use the same schema and migrations.

## Database URL

```text
sqlite:data/brainstem.sqlite         default; relative to the working directory
sqlite:/var/lib/brainstem/db.sqlite  absolute path
postgres://user:pass@host:5432/db    also postgresql://
```

Set it with `BRAINSTEM_DATABASE_URL` or in the config:

```js
runtime: {
  database: {
    url: "postgres://brainstem:secret@db:5432/brainstem"
  }
}
```

`runtime.database.url` wins over `BRAINSTEM_DATABASE_URL`; without either, Brainstem uses `sqlite:data/brainstem.sqlite`. See [Configuration](configuration.md).

The schema is versioned. A single node applies pending migrations on start; cluster deployments run `brainstem migrate` once per upgrade. See [CLI](cli.md#database-commands).

## Tables

| Table | Contents |
| --- | --- |
| `records` | Latest decision per observation ID (durable deduplication) |
| `checkpoints` | Input checkpoints, one JSON value per key |
| `plugin_state` | Durable plugin state by namespace and key |
| `web_events` | Telemetry event log |
| `stat_counters`, `stat_timeseries` | Dashboard counters and time series |
| `auth_users`, `auth_roles`, `auth_user_roles`, `auth_sessions` | Web UI accounts, RBAC and sessions |
| `auth_login_attempts` | Login rate limiting, shared across API replicas |
| `maintenance_runs` | Bookkeeping for singleton tasks (pruning, imports) |
| `brainstem_migrations`, `brainstem_migrations_lock` | Applied schema migrations |

Timestamps are ISO-8601 text and JSON is stored as text, so the same rows work on SQLite and Postgres.

## Core records

Core records persist the latest Brainstem decision for each observation ID.

They are used for durable deduplication:

```text
same observation ID + same fingerprint + same decision cache key
→ reuse previous decision without calling Laya
```

The store keeps one row per observation ID, not a full event history.

Stored fields:

```text
id
fingerprint
cache_key
revision
observation_json
decision_json
first_seen_at
last_seen_at
updated_at
```

`last_seen_at` is updated when the same observation is seen again. Records older than `pruneAfterDays` are removed. Set `pruneAfterDays: null` to disable pruning.

The `cache_key` is derived from the Brainstem core version, policy config, and Laya question config. If those change, Brainstem reevaluates matching observations instead of reusing stale decisions.

## Input checkpoints

Input checkpoints are tiny adapter cursors, such as:

```js
{ lastSeenAt: "2026-09-22T08:30:00Z" }
```

They are used by append-only sources like chats, logs, and email to avoid refetching old items.

Adapters access checkpoints through:

```js
ctx.checkpoint.get()
ctx.checkpoint.defer(value)
```

Deferred checkpoints are committed only after all emitted observations have been processed successfully. They are stored in the `checkpoints` table (`key`, `value_json`, `updated_at`).

Adapters should not access storage directly.

## Upgrading from 1.x

Brainstem 1.x split state across three files:

```text
data/brainstem.sqlite    records
data/web-stats.sqlite    telemetry, stats, auth
data/checkpoints.json    input checkpoints
```

To upgrade:

1. Stop Brainstem 1.x and back up `data/`.
2. Import the old state:

   ```sh
   node brainstem.mjs migrate import-v1 --data-dir data
   ```

   With the default database URL the target is `data/brainstem.sqlite` itself. Its `records` table is already compatible, so the file is upgraded in place and the other tables are added next to it. To import straight into Postgres, pass `--database postgres://...`.

3. Start Brainstem 2.0.

`import-v1` never modifies or deletes the 1.x files and can be re-run safely. Once 2.0 runs fine, `data/web-stats.sqlite` and `data/checkpoints.json` are no longer used and can be archived.

## Moving from SQLite to Postgres

```sh
node brainstem.mjs migrate sqlite-to-pg \
  --from sqlite:data/brainstem.sqlite \
  --to postgres://brainstem:secret@db:5432/brainstem
```

Then set `BRAINSTEM_DATABASE_URL` to the Postgres URL. The copy refuses to write into a non-empty database unless `--force` is given. See [CLI](cli.md#migrate-copy--migrate-sqlite-to-pg).
