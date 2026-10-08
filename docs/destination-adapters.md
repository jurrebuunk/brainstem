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

`event` contains:

```js
event.decision     // Brainstem decision envelope
event.observation  // original observation envelope
event.input        // source input metadata
event.destination  // destination metadata
event.pollId       // poll correlation id when available
```

Destination adapters should not change Brainstem decisions. They should only react to them.

Destination adapters can write scoped logs with `ctx.logger`. When runtime telemetry is configured, these logs are emitted as `brainstem.plugin.log` and shown under the destination node in the Web UI.

## Failure handling

Destination failures are isolated from input checkpoints by default. If a destination fails, the runtime logs the error and continues; the input checkpoint may still advance. This keeps output outages, such as Matrix being down, from causing inputs to reprocess the same source item repeatedly.

Destination plugins that need guaranteed delivery should persist their own work before returning, for example by writing to a queue or job table and processing it asynchronously.

If you deliberately want destination failure to block input checkpoint commits, enable:

```js
runtime: {
  destinations: {
    blockInputOnFailure: true
  }
}
```

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
