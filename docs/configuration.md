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

  records: {
    type: "sqlite",
    path: "data/brainstem.sqlite",
    pruneAfterDays: 90
  },

  checkpoints: {
    type: "json",
    path: "data/checkpoints.json"
  },

  retry: {
    attempts: 3,
    minDelayMs: 1000,
    maxDelayMs: 30000,
    factor: 2
  }
}
```

`runtime.logging` controls application/runtime logs. These are separate from the optional `log-decisions` destination.

- `level`: `debug`, `info`, `warn`, `error`, or `silent`
- `format`: `pretty` or `json`

Use `pretty` for local/Docker Compose logs and `json` when shipping logs to a collector.

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
