# Brainstem

[![Release](https://img.shields.io/github/v/release/jurrebuunk/brainstem?include_prereleases&label=release)](https://github.com/jurrebuunk/brainstem/releases/tag/v0.1.0-alpha.0)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](package.json)
[![Status](https://img.shields.io/badge/status-alpha-orange.svg)](CHANGELOG.md)
[![Plugin API](https://img.shields.io/badge/plugin%20API-inputs%20%7C%20destinations-purple.svg)](docs/input-plugins.md)

> Alpha: `0.1.0-alpha.0`. Brainstem is ready for local experimentation. APIs and plugin contracts may still change.

Brainstem is a lightweight decision and orchestration layer for autonomous AI agents.

It watches external systems, normalizes what it sees into observations, uses a small local Laya decision model to decide whether the observation matters, and only then routes actionable decisions to destinations such as logs, Matrix rooms, webhooks, or future agent runners.

```text
Inputs                Brainstem Core                 Destinations
------                --------------                 ------------
GitHub issues ─┐      dedupe/cache ─┐                console log
HTTP health ───┼──▶   Laya signals  ├──▶ decision ─▶ Matrix room
logs/chats ────┘      policy/route  ┘                agent/webhook later
```

The goal is simple:

> Keep expensive agents asleep until something actually needs attention.

## What Brainstem does

- Polls configured input plugins.
- Converts source data into standardized observations.
- Deduplicates observations with durable SQLite records.
- Uses [Laya](https://github.com/receptron/laya) for bounded local decisions.
- Produces decision envelopes: `ignore`, `queue`, `dispatch`, or `escalate`.
- Routes decisions by decision level, route, source, and type.
- Sends matching decisions to destination plugins.

## Current plugins

Input plugins:

- `github-issues` — polls GitHub issues.
- `http-health` — polls HTTP endpoints.
- `static-observations` — local smoke-test input.

Destination plugins:

- `log-decisions` — logs decisions to stdout.
- `matrix` — sends decisions to a Matrix room.

## Requirements

- Node.js `>=24`
- npm

Brainstem uses Node's built-in SQLite support for durable core records. Node may print an experimental SQLite warning.

## Quick start from source

```sh
git clone https://github.com/jurrebuunk/brainstem.git
cd brainstem
npm install
cp brainstem.config.example.mjs brainstem.config.mjs
cp .env.example .env
npm run start:once
```

`brainstem.config.mjs`, `.env`, and `data/` are local runtime files and are ignored by git.

## CLI

```sh
npm start              # run continuously
npm run start:once     # poll each input once and exit
npm run start:once:all # poll once and also print ignored decisions through log destinations
```

Direct CLI usage:

```sh
node brainstem.mjs --config ./brainstem.config.mjs --once
```

Installed package usage:

```sh
npx @jurrebuunk/brainstem --help
```

See [`docs/cli.md`](docs/cli.md) for more details.

## Example config

A minimal config that checks an HTTP endpoint and logs actionable decisions:

```js
export default {
  inputs: [
    {
      id: "api-health",
      module: "./plugins/http-health/index.mjs",
      input: "check",
      config: {
        name: "api",
        url: "https://example.com/health",
        timeoutMs: 10_000,
        expectedStatuses: [[200, 399]],
        minimumDecisionOnFailure: "dispatch"
      }
    }
  ],

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
  ],

  runtime: {
    records: {
      type: "sqlite",
      path: "data/brainstem.sqlite",
      pruneAfterDays: 90
    },

    checkpoints: {
      type: "json",
      path: "data/checkpoints.json"
    }
  }
};
```

See [`brainstem.config.example.mjs`](brainstem.config.example.mjs) for a fuller example with GitHub, HTTP health, logging, and Matrix.

## Matrix notifications

Configure the Matrix destination:

```js
destinations: [
  {
    module: "./plugins/matrix/index.mjs",
    destination: "room",
    decisions: "all",
    sources: ["http"],
    types: ["health_check"],
    config: {
      homeserver: "https://matrix.example.org",
      roomId: "!roomid:example.org",
      tokenEnv: "MATRIX_ACCESS_TOKEN",
      notify: {
        repeatAfterMs: 60 * 60 * 1000,
        onRecovery: true
      }
    }
  }
]
```

Put tokens in `.env`, not in committed config:

```sh
MATRIX_ACCESS_TOKEN=...
GITHUB_TOKEN=...
```

See [`docs/matrix-destination.md`](docs/matrix-destination.md).

## Decision model

Brainstem asks Laya bounded questions such as:

- Does this observation deserve attention?
- Is it actionable by a technical agent?
- How severe is it?
- Which abstract route owns it?

Default routes:

- `infrastructure`
- `coding`
- `security`
- `general`

The core returns a decision envelope like:

```js
{
  kind: "decision",
  payload: {
    observation_id: "http-health:api",
    decision: "dispatch",
    route: "infrastructure",
    reason: "Observation requires immediate investigation"
  }
}
```

## Durable state

Brainstem keeps two kinds of state:

1. **Core records** in SQLite — latest fingerprint and decision per observation ID.
2. **Input checkpoints** — small adapter cursors such as `lastSeenAt` or `lastMessageId`.

This keeps repeated polling cheap while avoiding unbounded event history by default.

See [`docs/state.md`](docs/state.md).

## Writing plugins

Input plugins emit observations:

```js
import { defineInputPlugin } from "../../src/sdk/index.mjs";

export default defineInputPlugin({
  apiVersion: "brainstem.input/v1",
  name: "my-input",
  inputs: {
    default: {
      mode: "poll",
      async *poll(ctx) {
        yield ctx.observation({
          id: "example:1",
          source: { type: "example", name: "demo" },
          type: "status",
          state: "open",
          title: "Example observation",
          message: "Something happened"
        });
      }
    }
  }
});
```

Destination plugins receive decisions:

```js
import { defineDestinationPlugin } from "../../src/sdk/index.mjs";

export default defineDestinationPlugin({
  apiVersion: "brainstem.destination/v1",
  name: "my-destination",
  destinations: {
    default: {
      async handle(ctx, event) {
        console.dir(event.decision, { depth: null });
      }
    }
  }
});
```

Docs:

- [`docs/input-plugins.md`](docs/input-plugins.md)
- [`docs/destination-adapters.md`](docs/destination-adapters.md)

## Project layout

```text
src/core/                 decision engine and record stores
src/runtime/              plugin loading, routing, checkpoints
src/sdk/                  adapter author helpers
plugins/<name>/index.mjs  plugin entrypoints
plugins/<name>/*.mjs      plugin implementation modules
docs/                     user and plugin documentation
```

## Development

```sh
npm run check
npm test
npm run plugin:test
npm pack --dry-run
```

## Release

See [`docs/release.md`](docs/release.md).

## License

ISC
