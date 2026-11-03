# Configuration

Brainstem uses a local JavaScript config file.

Create one from the example:

```sh
cp brainstem.config.example.mjs brainstem.config.mjs
```

`brainstem.config.mjs` is ignored by git so local URLs, room IDs, and environment references do not get committed.

Run with the default config path:

```sh
node brainstem.mjs --once
```

Or pass a config explicitly:

```sh
node brainstem.mjs --config ./my.config.mjs --once
```

## Top-level shape

```js
export default {
  inputs: [],
  destinations: [],
  runtime: {},
  policy: {},
  laya: {}
};
```

## Inputs

Inputs are configured plugin instances:

```js
inputs: [
  {
    id: "api-health",
    module: "./plugins/http-health/index.mjs",
    input: "check",
    retry: {
      attempts: 3,
      minDelayMs: 1000,
      maxDelayMs: 10000,
      factor: 2
    },
    config: {
      url: "https://example.com/health"
    }
  }
]
```

Use stable `id` values. Input checkpoints use this ID.

## Destinations

Destinations receive matching decision events:

```js
destinations: [
  {
    module: "./plugins/log-decisions/index.mjs",
    destination: "default",
    decisions: ["queue", "dispatch", "escalate"],
    routes: "all",
    sources: "all",
    types: "all",
    config: {
      prefix: "brainstem"
    }
  }
]
```

Filters:

- `decisions`: array or `"all"`
- `routes`: array or `"all"`
- `sources`: array or `"all"`
- `types`: array or `"all"`

## Runtime state

```js
runtime: {
  logging: {
    level: "info",
    format: "pretty"
  },

  database: {
    // optional; BRAINSTEM_DATABASE_URL is used when url is omitted
    url: "sqlite:data/brainstem.sqlite"
    // or url: "postgres://brainstem:secret@db:5432/brainstem"

    // Postgres connection pool, per process (defaults shown). The
    // timeouts make queries fail fast and retry during a failover or
    // network partition instead of hanging on a dead connection.
    // pool: { max: 10, connectionTimeoutMillis: 10000, queryTimeoutMs: 30000, idleTimeoutMillis: 30000 }
  },

  records: {
    pruneAfterDays: 90
  },

  retry: {
    attempts: 3,
    minDelayMs: 1000,
    maxDelayMs: 30000,
    factor: 2
  },

  startupRetry: {
    attempts: 3,
    minDelayMs: 5000,
    maxDelayMs: 60000,
    factor: 2
  },

  queue: {
    // durable decide/deliver jobs; see docs/delivery-pipeline.md
    pollIntervalMs: 1000,
    leaseMs: 60000,
    decide: { concurrency: 4, retry: { attempts: 5, minDelayMs: 1000, maxDelayMs: 60000, factor: 2 } },
    deliver: { concurrency: 4, retry: { attempts: 8, minDelayMs: 5000, maxDelayMs: 900000, factor: 3 } }
  },

  deliveries: {
    pruneAfterDays: 14
  },

  // Optional: this process's id in telemetry, the job queue and the
  // core registry. Default: BRAINSTEM_CORE_ID, else <hostname>:<pid>:<random>.
  // coreId: "core-1",

  cores: {
    // Registry heartbeat (see docs/web-ui.md#topology). Active whenever the
    // runtime uses a database; enabled: false turns it off.
    heartbeatMs: 5000
  },

  handoff: {
    // destinations handing observations back to the core (ctx.emit)
    maxDepth: 2,
    maxPerDelivery: 5
  },

  api: {
    // optional: backend-owned telemetry history, stats, SSE, and config API
    enabled: true,
    host: "127.0.0.1",
    port: 5174
  },

  telemetry: {
    // optional: send structured runtime events to a custom receiver.
    // When api.enabled is true and telemetry.url is omitted, Brainstem sends to its own backend API.
    snapshotIntervalMs: 5000
  },

  laya: {
    cacheDir: "data/laya-cache"
    // or modelDir: "data/laya-model"
  }
}
```

`runtime.database` selects the single database that holds records, checkpoints, plugin state, telemetry, stats and auth (see [State](state.md)). The URL is resolved in this order:

1. `runtime.database.url`
2. `BRAINSTEM_DATABASE_URL`
3. `runtime.database.path` (shorthand for `sqlite:<path>`)
4. `sqlite:data/brainstem.sqlite`

URL formats: `sqlite:<relative path>`, `sqlite:/absolute/path`, `postgres://user:pass@host:5432/db`. Keep Postgres passwords out of committed config by setting `BRAINSTEM_DATABASE_URL` in `.env` instead of `url`. The `brainstem migrate` commands use the same resolution; see [CLI](cli.md#database-commands).

1.x settings `runtime.records.type/path`, `runtime.checkpoints` and `runtime.api.telemetryDbPath` pointed at separate files. Since 1.3 those files are only read, once: automatically on first start, or by hand with `brainstem migrate import-v1`.

`runtime.logging` controls application/runtime logs. These are separate from the optional `log-decisions` destination.

- `level`: `debug`, `info`, `warn`, `error`, or `silent`
- `format`: `pretty` or `json`

Use `pretty` for local/Docker Compose logs and `json` when shipping logs to a collector.

`runtime.startupRetry` controls retries while starting the core. This is useful because the first startup may download the Laya model bundle and can fail on temporary network/DNS timeouts.

`runtime.retry` controls retries of a failing input poll.

`runtime.queue` configures the durable pipeline: concurrency and retry policy of the `decide` and `deliver` stages, job leases, and the transport (`database` by default, `memory` when checkpoints are not in the database). A destination entry may set its own `retry`. `runtime.deliveries.pruneAfterDays` sets how long delivered rows stay in the delivery log. See [Delivery pipeline](delivery-pipeline.md).

Give each destination entry a unique `id`. It is part of every delivery's idempotency key; without it the id depends on the entry's position in `destinations`.

`runtime.destinations.blockInputOnFailure` from 1.x is ignored. Deliveries are retried per destination and never block input checkpoints.

`runtime.telemetry` sends structured runtime events to an HTTP endpoint such as the Web UI. It emits snapshots, input poll events, observations, decisions, destination activity, failures, and plugin logs.

`runtime.laya` is passed to `Laya.load()`. Useful options:

- `cacheDir`: where downloaded Laya model files are cached
- `modelDir`: use a pre-downloaded model directory and skip network downloads (also `BRAINSTEM_LAYA_MODEL_DIR`, for example the mounted `brainstem-models` image)
- `workers`: run Laya in this many worker threads (default 0: in the main thread). Changed observations are then evaluated in parallel, up to `workers` at a time, and never block the event loop. Each worker holds its own model session, so memory grows with it. `--decide-concurrency N` sets this and `queue.decide.concurrency` together.

Graceful shutdown and input scheduling:

```js
runtime: {
  shutdown: { timeoutMs: 25000 },  // SIGTERM: let in-flight work finish this long
  inputs: { leaseMs: 30000, concurrency: 16 }  // see delivery-pipeline.md#input-scheduling
}
```

## Versioned config

By default the config is this file (`configSource: "file"`). The Web UI shows it read-only, and the API never writes or executes config files.

To edit config in the UI, or to run several cores, store it in the database:

```sh
node brainstem.mjs config import --comment "initial"
BRAINSTEM_CONFIG_SOURCE=database node brainstem.mjs
```

- Every save is a new, immutable version in `config_versions`, validated against the [JSON Schema](../src/config/schema.mjs) (`GET /api/config/schema`). One version is active.
- Saves in the UI or through `PUT /api/config` send `If-Match` with the version they edited. When someone else activated another version meanwhile, the save fails with 409 instead of overwriting their change.
- Activating a version (`brainstem config activate <id>`, or **Activate** in the UI) is a rollback. Running cores reload the active version without a restart: claiming stops, in-flight work finishes, inputs and destinations reload, and work resumes. A version that fails to load is logged, and the previous one keeps running.
- Stored config must be plain data: functions (such as agentOS `tools.*.run`) can't be stored, and `config import` reports where they are.
- Bootstrap settings stay per process, in the file or the environment: `runtime.database`, `api`, `logging`, `telemetry`, `coreId`, `role`, `queues`. They are left out on import, and a process's own values win. Without a config file, the environment covers them: `BRAINSTEM_DATABASE_URL`, `BRAINSTEM_LOG_LEVEL`/`_FORMAT`, `BRAINSTEM_TELEMETRY_URL`/`_TOKEN`, `BRAINSTEM_CORE_ID`, `BRAINSTEM_ROLE` and `BRAINSTEM_QUEUES`.
- `brainstem config export` writes a version back as a config module (GitOps, backups).
- `brainstem config import --if-empty` stores the file only while no version exists (seeding on first install).

Hot reload covers inputs, destinations, policy, Laya questions and load options, `runtime.queue` (not `transport`), `inputs` (not `scheduling`), `handoff` and `shutdown`. The other settings need a restart.

## Secrets

Do not commit tokens. Put them in `.env`:

```sh
GITHUB_TOKEN=...
MATRIX_ACCESS_TOKEN=...
```

Reference them from config:

```js
config: {
  tokenEnv: "GITHUB_TOKEN"
}
```

`brainstem.mjs` loads `.env` automatically. Existing shell environment variables take precedence.

## Policy and Laya

The `policy` section controls thresholds for `queue` and `dispatch`.

The `laya.questions` section defines the bounded local questions Brainstem asks Laya.

Most users should start from `brainstem.config.example.mjs` and only edit inputs and destinations.
