# Input Plugins

Input plugins are source adapters. A plugin talks to one external system and emits standardized Brainstem observations.

Plugins do not receive the Brainstem core instance. They only produce observations; the runtime owns scheduling, validation, retries, and decision processing.

## Minimal plugin

```js
import { defineInputPlugin } from "../../src/sdk/index.mjs";

export default defineInputPlugin({
  apiVersion: "brainstem.input/v1",
  name: "my-input",

  inputs: {
    default: {
      mode: "poll",
      defaultIntervalMs: 60_000,

      async *poll(ctx) {
        yield ctx.observation({
          id: "example:demo:status:main",
          source: { type: "example", name: "demo" },
          type: "status",
          state: "open",
          title: "Example event",
          message: "Something happened"
        });
      }
    }
  }
});
```

Phase 1 supports polling inputs only.

## Context

`poll(ctx)` receives:

```js
ctx.config       // plugin entry config from brainstem.config.mjs
ctx.signal       // AbortSignal for shutdown/cancellation
ctx.logger       // logger, usually console
ctx.observation  // helper around createObservation()
ctx.checkpoint   // scoped checkpoint API for this configured input
```

## Source-side deduplication

Input plugins should emit only observations that are new or meaningfully changed at the source. The core has a decision cache, but that cache is a safety net; plugins should avoid sending unchanged source data into the core in the first place.

Default behavior for polling plugins should be:

- new source item/entity: emit once
- changed source item/entity: emit again
- unchanged source item/entity: do not emit
- intentional reminders/repeats: opt in with config such as `repeatAfterMs`

Examples:

- GitHub issues: store issue number plus a fingerprint or `updated_at`; emit only new or updated issues.
- Logs: store file offset, journal cursor, or timestamp; emit only new log lines.
- Health checks: emit state transitions and optionally repeated failures after `repeatAfterMs`.
- TLS certificates: emit validity/expiry state changes and optionally reminders after `repeatAfterMs`.

This keeps Laya calls, destination deliveries, agent spawns, and future Web UI history bounded.

## Checkpoints

Adapters should use checkpoints to avoid repeatedly fetching or emitting old data such as issues, chat messages, emails, logs, or unchanged status checks.

Adapters do not access storage directly. The runtime provides a scoped API:

```js
const checkpoint = await ctx.checkpoint.get();

const items = await fetchNewItems({
  since: checkpoint?.lastSeenAt
});

for (const item of items) {
  yield ctx.observation(...);
}

ctx.checkpoint.defer({
  lastSeenAt: items.at(-1)?.timestamp ?? checkpoint?.lastSeenAt
});
```

`defer()` does not write immediately. The runtime commits the deferred checkpoint only after the adapter finishes polling and all emitted observations have been processed successfully. If the process crashes before then, the checkpoint is not advanced and the next poll may safely refetch overlapping items.

For entity-style sources, checkpoint the last fingerprint per entity:

```js
const checkpoint = await ctx.checkpoint.get() ?? {};
const previous = checkpoint.items?.[item.id];
const fingerprint = stableFingerprint(item);

if (previous?.fingerprint !== fingerprint) {
  yield ctx.observation(...);
}

ctx.checkpoint.defer({
  items: {
    ...(checkpoint.items ?? {}),
    [item.id]: {
      fingerprint,
      updatedAt: item.updatedAt
    }
  }
});
```

If a plugin supports `startFromNow`, the first poll should checkpoint current source state without emitting it.

Checkpoint values must be JSON-only. Use `null` to clear a checkpoint.

Use stable input IDs so checkpoint ownership survives config reordering:

```js
inputs: [
  {
    id: "matrix-main-room",
    module: "./plugins/matrix/index.mjs",
    input: "messages"
  }
]
```

## Observation IDs

Observation IDs must be stable for the same logical thing over time:

```text
<source-type>:<source-name>:<entity-type>:<native-id>
```

Examples:

```text
github:owner/repo:issue:42
http:api.example.com:health:main
kubernetes:prod:pod:default/api-123
```

Stable IDs allow Brainstem to deduplicate unchanged observations and increment revisions only when meaningful content changes.

## Avoid volatile data

Brainstem fingerprints all meaningful observation fields except the top-level timestamp. Avoid putting noisy values into `data`, `title`, `message`, or `facts` unless a change should trigger reevaluation.

Avoid:

```js
data: {
  fetched_at: new Date().toISOString(),
  request_id: response.headers.get("x-request-id")
}
```

Prefer top-level `timestamp`, which `ctx.observation()` sets automatically when omitted.

## Deterministic minimum decisions

Adapters can set a deterministic floor without making the semantic decision themselves:

```js
facts: {
  minimum_decision: "dispatch"
}
```

Allowed decisions are:

```text
ignore < queue < dispatch < escalate
```

The core may raise the decision further, but will not lower it below `minimum_decision`.

## Tokens and secrets

Do not commit tokens in `brainstem.config.mjs`.

Preferred:

```js
config: {
  repo: "owner/repo",
  tokenEnv: "GITHUB_TOKEN"
}
```

Then run:

```sh
GITHUB_TOKEN=... node brainstem.mjs --once
```

Plugins may also support object references:

```js
token: { env: "GITHUB_TOKEN" }
```

## Testing

Poll once and print actionable decisions:

```sh
node brainstem.mjs --once
```

Print ignored decisions too:

```sh
node brainstem.mjs --once --all
```

Run the static smoke test:

```sh
npm run plugin:test
```

## Retry/backoff

Retries can be configured globally:

```js
runtime: {
  retry: {
    attempts: 3,
    minDelayMs: 1000,
    maxDelayMs: 30000,
    factor: 2
  }
}
```

Or per input:

```js
inputs: [
  {
    module: "./plugins/github-issues/index.mjs",
    input: "issues",
    retry: {
      attempts: 5,
      minDelayMs: 500,
      maxDelayMs: 10000,
      factor: 2
    },
    config: { repo: "owner/repo" }
  }
]
```
