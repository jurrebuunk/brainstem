# Destination Adapters

Destination adapters receive Brainstem decisions and perform side effects.

The current adapter logs decisions to the console:

```js
destinations: [
  {
    module: "./plugins/log-decisions/index.mjs",
    destination: "default",
    decisions: ["queue", "dispatch", "escalate"],
    routes: ["coding", "security"],
    sources: ["github"],
    types: ["issue"],
    config: {
      prefix: "brainstem"
    }
  }
]
```

Use `decisions: "all"` to receive ignored decisions too. The CLI does this automatically when `--all` is passed:

```sh
node brainstem.mjs --once --all
```

Use `routes` to filter by the abstract route chosen by the core:

```js
{
  module: "./plugins/log-decisions/index.mjs",
  destination: "default",
  decisions: ["queue", "dispatch"],
  routes: ["coding"],
  config: { prefix: "coding" }
}
```

Use `sources` to filter by `observation.payload.source.type`, and `types` to filter by `observation.payload.type`:

```js
{
  module: "./plugins/log-decisions/index.mjs",
  decisions: ["dispatch"],
  routes: ["security"],
  sources: ["github"],
  types: ["issue"],
  config: { prefix: "github-security-issues" }
}
```

Omit a filter or set it to `"all"` to receive every value for that field.

A destination adapter exports:

```js
import { defineDestinationPlugin } from "../../src/sdk/index.mjs";

export default defineDestinationPlugin({
  apiVersion: "brainstem.destination/v2",
  name: "my-destination",

  destinations: {
    default: {
      async handle(ctx, output) {
        await fetch("https://receiver.example/hook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": ctx.idempotencyKey
          },
          body: JSON.stringify(output),
          signal: ctx.signal
        });
      }
    }
  }
});
```

`output` is the serializable `brainstem.output` envelope:

```js
{
  version: "1",
  kind: "brainstem.output",
  payload: {
    timestamp,        // when the decision was made
    pollId,           // poll correlation id
    idempotencyKey,   // same as ctx.idempotencyKey
    decision,         // Brainstem decision envelope
    observation,      // original observation envelope
    input:       { id, plugin, name, module },
    destination: { id, plugin, name, module }
  }
}
```

`ctx` contains:

```js
ctx.config          // the destination entry's config
ctx.signal          // aborted on shutdown or when the job's lease is lost
ctx.logger          // scoped logs, shown under the destination in the Web UI
ctx.state           // durable plugin state (get / set / update / delete)
ctx.idempotencyKey  // stable across retries of this delivery
ctx.attempt         // 1 on the first try
```

Each call delivers one decision to one destination and runs as its own job (see [Delivery pipeline](delivery-pipeline.md)). Return normally when the receiver accepted it, and throw to have it retried with backoff. Throw an error with `permanent: true` to skip the retries, for example on a 4xx response that will not change.

A delivery can run more than once: a retry after an ambiguous failure, or a job whose lease expired. Pass `ctx.idempotencyKey` on to the receiving system so a repeat has no second effect. Where the receiver has no such mechanism, record progress under that key in `ctx.state` and resume from it, like opencode-runner does with its session.

Destination adapters should not change Brainstem decisions. They should only react to them.

When runtime telemetry is configured, `ctx.logger` calls are emitted as `brainstem.plugin.log` and shown under the destination node in the Web UI.

## Failure handling

Destination failures never block input checkpoints. A failing delivery is retried on its own with backoff (`runtime.queue.deliver.retry`, or `retry` on the destination entry). Other destinations, the decision and the poll are not repeated. After the last attempt the delivery is **dead**. It is listed on the Web UI's Deliveries page, where it can be redriven once the receiver is fixed.

`runtime.destinations.blockInputOnFailure` from 1.x is ignored.

## Migrating from v1

v1 destinations (`apiVersion: "brainstem.destination/v1"`) receive the 1.x event with live plugin objects:

```js
async handle(ctx, event) {
  event.decision;            // decision envelope
  event.observation;         // observation envelope
  event.pollId;
  event.input.plugin.name;   event.input.name;   event.input.entry
  event.destination.plugin;  event.destination.name;  event.destination.entry
}
```

They keep working through an adapter until 3.0. The runtime logs a deprecation warning once per plugin. `ctx.idempotencyKey` is set for them too, but a v1 plugin that ignores it gets at-least-once delivery without deduplication.

To migrate:

1. Set `apiVersion: "brainstem.destination/v2"` and rename the second argument to `output`.
2. Read `output.payload.decision`, `output.payload.observation` and `output.payload.pollId` instead of `event.*`.
3. Replace `event.input.plugin.name` / `event.input.entry.id` with `output.payload.input.plugin` / `output.payload.input.id`. Do the same for `destination`. These are plain strings now.
4. Pass `ctx.idempotencyKey` to the receiving system.

Config callbacks of the built-in destinations (Matrix `notificationKey(event)`, opencode-runner `titleForEvent(event)` and `promptTemplate(event)`) now receive `output.payload`. `decision`, `observation` and `pollId` are unchanged; `input` and `destination` are the plain objects shown above.

## Multiple routed destinations

The same destination adapter can be configured multiple times:

```js
destinations: [
  {
    module: "./plugins/log-decisions/index.mjs",
    decisions: ["queue", "dispatch"],
    routes: ["coding"],
    sources: ["github"],
    types: ["issue"],
    config: { prefix: "coding-agent" }
  },
  {
    module: "./plugins/log-decisions/index.mjs",
    decisions: ["dispatch", "escalate"],
    routes: ["security"],
    sources: "all",
    types: "all",
    config: { prefix: "security-agent" }
  }
]
```

In this setup, the core decides `payload.route`, and the runtime maps that abstract route to concrete outputs.
