# Migrating destination plugins to v2

Brainstem 2.0 runs each delivery as a job that any core can pick up, possibly on another machine, after a retry or a crash. A v1 destination receives live plugin objects, which can't cross a queue, and has no way to recognise a repeated delivery. v2 (`brainstem.destination/v2`, [ADR-0004](adr/0004-destination-plugin-sdk-v2.md)) receives a plain, serializable output and an idempotency key.

v1 plugins keep working through an adapter until 3.0. The runtime logs a deprecation warning once per plugin. Input plugins don't change.

## Before and after

```js
// v1
export default {
  apiVersion: "brainstem.destination/v1",
  name: "acme-tickets",
  destinations: {
    default: {
      async handle(ctx, event) {
        await fetch(ctx.config.url, {
          method: "POST",
          body: JSON.stringify({
            title: event.observation.payload.title,
            decision: event.decision.payload.decision,
            from: event.input.plugin.name
          })
        });
      }
    }
  }
};
```

```js
// v2
import { defineDestinationPlugin } from "@jurrebuunk/brainstem/sdk";

export default defineDestinationPlugin({
  apiVersion: "brainstem.destination/v2",
  name: "acme-tickets",
  destinations: {
    default: {
      async handle(ctx, output) {
        const { observation, decision, input } = output.payload;

        const response = await fetch(ctx.config.url, {
          method: "POST",
          signal: ctx.signal,
          headers: {
            "content-type": "application/json",
            // The same key on every retry of this delivery.
            "idempotency-key": ctx.idempotencyKey,
            ...(ctx.traceparent ? { traceparent: ctx.traceparent } : {})
          },
          body: JSON.stringify({
            title: observation.payload.title,
            decision: decision.payload.decision,
            from: input.plugin
          })
        });

        if (response.status >= 400 && response.status < 500) {
          // Won't succeed on retry: go straight to dead deliveries.
          throw Object.assign(new Error(`rejected: ${response.status}`), { permanent: true });
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      }
    }
  }
});
```

## Step by step

1. **API version.** Set `apiVersion: "brainstem.destination/v2"`. Optionally wrap the plugin in `defineDestinationPlugin` (from `@jurrebuunk/brainstem/sdk`, or `src/sdk/index.mjs` in a checkout), which validates it at load time.
2. **Read the output.** The second argument is the `brainstem.output` envelope. Map the fields:

   | v1 `event` | v2 `output.payload` |
   |---|---|
   | `event.decision` | `decision` |
   | `event.observation` | `observation` |
   | `event.pollId` | `pollId` (null for handed-off observations) |
   | `event.input.plugin.name` | `input.plugin` |
   | `event.input.name` | `input.name` |
   | `event.input.entry.id` | `input.id` |
   | `event.destination.plugin.name` / `.name` / `.entry.id` | `destination.plugin` / `.name` / `.id` |
   | – | `origin`: `{ kind: "input", id }` or, for an observation a destination handed back, `{ kind: "destination", id, depth, lineage }` |
   | – | `idempotencyKey` (same as `ctx.idempotencyKey`) |

   Everything is plain JSON. Don't keep references to it between calls.
3. **Make repeats harmless.** A delivery can run more than once: after an ambiguous failure, or when the core running it dies after the receiver acted but before Brainstem recorded it. The [chaos tests](runbook.md#delivery-guarantees) exercise exactly this. Pass `ctx.idempotencyKey` to the receiver:
   - as an `Idempotency-Key` header;
   - as Matrix's `txnId`;
   - as an external id or a dedupe field.

   When the receiver has none, record progress in `ctx.state` under the key and resume from it:

   ```js
   const done = await ctx.state.get(`sent:${ctx.idempotencyKey}`);
   if (done) return;
   const ticket = await createTicket(...);
   await ctx.state.set(`sent:${ctx.idempotencyKey}`, { ticket: ticket.id });
   ```
4. **Fail correctly.**
   - Return normally when the receiver accepted the delivery.
   - Throw to retry with backoff (the destination entry's `retry`, or `runtime.queue.deliver.retry`).
   - Throw an error with `permanent: true` for failures that won't heal on retry.
   - Respect `ctx.signal`: it aborts on shutdown and when the job's lease is lost to another core.
5. **Keep state in `ctx.state`, not in module variables or files.** Several cores run the same plugin. Module-level maps and local files are per process and get lost on restart. `ctx.state` lives in the database, and its `update()` is atomic across cores.
6. **Use the other v2 features if you need them:**
   - `ctx.emit(observation)`: hand a result back to the core, for example an agent's report for a bigger agent. Limited by `runtime.handoff.maxDepth` and `maxPerDelivery`.
   - `ctx.attempt`: 1 on the first try.
   - `ctx.traceparent`: forward it to join the envelope's trace ([Observability](observability.md#tracing)).
   - `ctx.logger`: shown under the destination in the Web UI.
7. **Config callbacks.** If your plugin accepts callbacks in its config (like Matrix's `notificationKey(event)`), pass them `output.payload`. Note that config with functions only works with the file config source.

## Testing

```sh
node run-plugin-test.mjs        # loads every plugin in plugins/ and checks its shape
```

Run your plugin under the delivery pipeline with a static input:

```js
inputs: [{ id: "probe", module: "./plugins/static-observations/index.mjs",
  config: { observations: [{ id: "probe:1", source: { type: "test", name: "probe" }, type: "item", state: "new", title: "Probe", message: "Hello" }] } }],
destinations: [{ id: "tickets", module: "./plugins/acme-tickets/index.mjs", decisions: "all", config: { url: "http://127.0.0.1:9999" } }]
```

`node brainstem.mjs --once --all` polls once and delivers. Make the receiver fail to see retries and dead deliveries on the Deliveries page.

## The built-in plugins

All built-in destinations are v2:

- `http-json` sends `Idempotency-Key` and `traceparent`.
- `matrix` uses the key as its `txnId`.
- `opencode-runner` keys its session on it.
- `agentos-runner` keys its agent attempts and tool calls on it.

Read them in [`plugins/`](../plugins) for complete examples.
