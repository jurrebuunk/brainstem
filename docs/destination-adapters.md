# Destination Adapters

Destination adapters receive Brainstem decisions and perform side effects.

The current adapter logs decisions to the console:

```js
destinations: [
  {
    module: "./plugins/log-decisions.mjs",
    destination: "default",
    decisions: ["queue", "dispatch", "escalate"],
    routes: ["coding", "security"],
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
  module: "./plugins/log-decisions.mjs",
  destination: "default",
  decisions: ["queue", "dispatch"],
  routes: ["coding"],
  config: { prefix: "coding" }
}
```

Omit `routes` or set `routes: "all"` to receive every route.

A destination adapter exports:

```js
import { defineDestinationPlugin } from "../sdk.mjs";

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
```

Destination adapters should not change Brainstem decisions. They should only react to them.

## Multiple routed destinations

The same destination adapter can be configured multiple times:

```js
destinations: [
  {
    module: "./plugins/log-decisions.mjs",
    decisions: ["queue", "dispatch"],
    routes: ["coding"],
    config: { prefix: "coding-agent" }
  },
  {
    module: "./plugins/log-decisions.mjs",
    decisions: ["dispatch", "escalate"],
    routes: ["security"],
    config: { prefix: "security-agent" }
  }
]
```

In this setup, the core decides `payload.route`, and the runtime maps that abstract route to concrete outputs.
