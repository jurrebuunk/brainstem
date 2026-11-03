# @brainstem-dev/sdk

The plugin API of [Brainstem](https://github.com/jurrebuunk/brainstem): build input and destination plugins, and test them without a runtime.

```sh
npm install --save-peer @brainstem-dev/sdk
```

Declare it as a **peer dependency** of your plugin (`"@brainstem-dev/sdk": "^2.0.0"`), so your plugin uses the SDK of the Brainstem it runs in.

## An input plugin

```js
import { defineInputPlugin } from "@brainstem-dev/sdk";

export default defineInputPlugin({
  apiVersion: "brainstem.input/v1",
  name: "acme-queue-depth",
  inputs: {
    default: {
      mode: "poll",
      async *poll(ctx) {
        const depth = await fetchDepth(ctx.config.url, { signal: ctx.signal });
        if (depth > ctx.config.threshold) {
          yield ctx.observation({
            id: `queue:${ctx.config.name}`,
            source: { type: "queue", name: ctx.config.name },
            type: "backlog",
            state: "high",
            title: `Queue ${ctx.config.name} is backing up`,
            message: `${depth} messages waiting`
          });
        }
      }
    }
  }
});
```

## A destination plugin

```js
import { defineDestinationPlugin } from "@brainstem-dev/sdk";

export default defineDestinationPlugin({
  apiVersion: "brainstem.destination/v2",
  name: "acme-tickets",
  destinations: {
    default: {
      async handle(ctx, output) {
        const { observation, decision } = output.payload;
        await createTicket(ctx.config.url, {
          title: observation.payload.title,
          priority: decision.payload.decision,
          idempotencyKey: ctx.idempotencyKey   // the same on every retry
        });
      }
    }
  }
});
```

## Testing

```js
import { runInput, runDestination, createTestOutput } from "@brainstem-dev/sdk/testing";

const { observations, checkpoint, logs } = await runInput(plugin, { config: { url, threshold: 10 } });
const { emitted } = await runDestination(plugin, createTestOutput({ observation: observations[0], decision: "dispatch" }), { config: { url } });
```

`runInput` validates observations like the runtime does and returns the checkpoint the input deferred. `runDestination` returns what the destination handed back with `ctx.emit` and rejects with the error it threw. Pass the same `state` (`new MemoryPluginStateStore()`) to several runs to test plugins that keep `ctx.state`.

## Packaging

In your plugin's `package.json`:

```json
{
  "name": "brainstem-plugin-acme",
  "type": "module",
  "exports": "./index.mjs",
  "keywords": ["brainstem-plugin"],
  "brainstem": { "kind": "destination" },
  "peerDependencies": { "@brainstem-dev/sdk": "^2.0.0" }
}
```

Users install it with `brainstem plugins add brainstem-plugin-acme` and use it as `module: "brainstem-plugin-acme"`.

Reference: [input plugins](https://github.com/jurrebuunk/brainstem/blob/main/docs/input-plugins.md), [destination plugins](https://github.com/jurrebuunk/brainstem/blob/main/docs/destination-adapters.md), [plugins overview](https://github.com/jurrebuunk/brainstem/blob/main/docs/plugins.md).
