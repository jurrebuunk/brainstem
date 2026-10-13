# CLI

## Setup

Create local config and environment files:

```sh
cp brainstem.config.example.mjs brainstem.config.mjs
cp .env.example .env
```

`brainstem.config.mjs` and `.env` are local files and should not be committed.

`brainstem.mjs` loads `.env` automatically. Environment variables that are already set in the shell take precedence over values in `.env`.

## Commands

Run continuously:

```sh
npm start
```

Poll each configured input once and exit:

```sh
npm run start:once
```

Poll once and print ignored decisions through log destinations too:

```sh
npm run start:once:all
```

Use a different config file:

```sh
node brainstem.mjs --config ./my.config.mjs --once
```

Override runtime logging:

```sh
node brainstem.mjs --log-level debug --log-format json
```

Log levels: `debug`, `info`, `warn`, `error`, `silent`.

Log formats: `pretty`, `json`.

Show help:

```sh
node brainstem.mjs --help
```

## Database commands

All state lives in one database (see [State](state.md)). The URL comes from, in order:

1. `--database <url>`
2. `runtime.database.url` in the config file (`--config`, default `brainstem.config.mjs`; skipped when the file does not exist)
3. `BRAINSTEM_DATABASE_URL`
4. `sqlite:data/brainstem.sqlite`

URL formats: `sqlite:data/brainstem.sqlite` (relative to the working directory), `sqlite:/abs/path.sqlite`, `postgres://user:pass@host:5432/db`.

All commands exit non-zero on failure (`1`) or bad usage (`2`). Show help:

```sh
node brainstem.mjs migrate --help
```

### `migrate`

Apply pending schema migrations and print the ones applied:

```sh
node brainstem.mjs migrate
node brainstem.mjs migrate --database postgres://brainstem:secret@db:5432/brainstem
```

A single node (`role=all`) migrates on start. Cluster deployments run `brainstem migrate` once per upgrade (for example as a Kubernetes Job) instead of migrating from every pod.

### `migrate status`

List every migration with its applied time, or `pending`:

```sh
node brainstem.mjs migrate status
```

### `migrate import-v1`

Import Brainstem 1.x state into the 2.0 database:

```sh
node brainstem.mjs migrate import-v1 --data-dir data
```

| 1.x source | 2.0 tables |
| --- | --- |
| `<data-dir>/brainstem.sqlite` | `records` |
| `<data-dir>/web-stats.sqlite` | `web_events`, `stat_counters`, `stat_timeseries`, `auth_users`, `auth_roles`, `auth_user_roles`, `auth_sessions` |
| `<data-dir>/checkpoints.json` | `checkpoints` |

Options:

- `--data-dir` — 1.x data directory. Default: `data`
- `--records-db`, `--telemetry-db`, `--checkpoints-file` — override a single source path
- `--database` — target database

The command migrates the target first, then prints a per-table summary (`read`, `inserted`). Legacy files are opened read-only and never changed or deleted; missing files are reported and skipped.

It is safe to re-run. Keyed rows use `ON CONFLICT DO NOTHING`. `web_events` get new ids and are imported once; the run is recorded in `maintenance_runs` as task `import-v1`. Run it before 2.0 has written its own stats, because existing counters are not overwritten.

When the target is the 1.x `brainstem.sqlite` itself (the default), records are already in place and only the other tables are imported.

### `migrate copy` / `migrate sqlite-to-pg`

Copy every table from one 2.0 database to another. The main use is moving a single node from SQLite to Postgres:

```sh
node brainstem.mjs migrate sqlite-to-pg \
  --from sqlite:data/brainstem.sqlite \
  --to postgres://brainstem:secret@db:5432/brainstem
```

`sqlite-to-pg` is an alias of `copy`; any direction works (also Postgres → SQLite).

- The source must be migrated to latest; it is only read.
- The target is migrated to latest first.
- The copy refuses when any target table has rows. `--force` copies anyway and skips rows whose key already exists.
- Tables are copied parent-first, in batches (`--batch-size`, default 500), one transaction per table. Ids are kept.
- On Postgres, the `web_events` id sequence is moved past the copied ids.

Stop Brainstem while copying so no writes are lost.

## Tokens

Do not put tokens directly in committed config files. Prefer env references:

```js
config: {
  tokenEnv: "GITHUB_TOKEN"
}
```

or:

```js
config: {
  token: { env: "MATRIX_ACCESS_TOKEN" }
}
```

If a required token is missing, the relevant plugin should fail with a clear error.
