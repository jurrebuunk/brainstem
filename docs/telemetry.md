# Runtime Telemetry

Telemetry is structured machine-readable runtime activity for the backend API, optional Web UI, and future monitoring tools. It is separate from human console logs and from destination plugins.

Preferred local configuration uses the backend API owned by the runtime:

```js
runtime: {
  api: {
    enabled: true,
    host: "127.0.0.1",
    port: 5174
  }
}
```

When `runtime.api.enabled` is true and `runtime.telemetry.url` is not set, Brainstem sends telemetry to its own backend API automatically. You can still configure an explicit telemetry URL for custom collectors:

```js
runtime: {
  telemetry: {
    url: "http://127.0.0.1:5174/api/events",
    snapshotIntervalMs: 5000
  }
}
```

`url` receives `POST` requests with JSON telemetry envelopes.

## Envelope shape

```js
{
  version: "1",
  kind: "brainstem.input.poll.started",
  payload: {
    timestamp: "2026-...",
    coreId: "host:1234:9f2c1a7b",
    ...
  }
}
```

Every event carries `coreId`, the runtime process that produced it. It's set from `runtime.coreId`, then `BRAINSTEM_CORE_ID`, otherwise `<hostname>:<pid>:<random>`, and stays the same for the process lifetime. The job runner uses the same id as its worker id. With several cores, a consumer can tell which core did what. With one core, every event shows the same id.

## Identity fields

Consumers should key on these fields, which stay stable across cores and restarts:

| Field | Meaning |
|---|---|
| `coreId` | the runtime process that emitted the event |
| `destinationId` | the configured destination entry (`id` in the config). Unlike plugin + destination name, it is unique per entry, so two tasks of one plugin are told apart |
| `inputId` | the configured input that produced the observation. `null` for an observation a destination handed back |
| `origin` | where the observation came from: `{ kind: "input", id }`, or `{ kind: "destination", id, plugin, name, depth, lineage }` for a handoff (`ctx.emit`), where `lineage` lists the destinations it passed through |
| `observationId`, `deliveryKey` | the observation and the delivery (idempotency key) |

`brainstem.core.decision` carries `origin`, and so does the `brainstem.output` envelope. The shared helpers in `src/telemetry/events.mjs` (`eventOrigin`, `eventDestinationId`, `eventCoreId`) read them, and they map events recorded before these fields existed. Those runtimes recorded a handoff as input id `destination:<id>`.

## Event kinds

Runtime lifecycle:

- `brainstem.runtime.starting`
- `brainstem.runtime.stopping`
- `brainstem.runtime.stopped`
- `brainstem.snapshot`

Inputs:

- `brainstem.input.loaded`
- `brainstem.input.poll.started`
- `brainstem.input.observation`
- `brainstem.input.poll.completed`

Core:

- `brainstem.core.decision`
- `brainstem.core.failed`: a decide job failed. `dead: true` means out of attempts; otherwise `retryInMs` says when it runs again.

Destinations:

- `brainstem.destination.loaded`
- `brainstem.destination.running`
- `brainstem.destination.completed`
- `brainstem.destination.failed`: a delivery attempt failed, with `attempt`, `attempts`, `dead` and `retryInMs`
- `brainstem.destination.emitted`: a delivery handed observations back to the core (`ctx.emit`), with `destinationId`, `observationId` (the delivered observation), `observations` (the emitted ids) and `depth`. Emitted only once the delivery has committed.

Destination events carry `deliveryKey` (the idempotency key) and `destinationId`. Each delivery attempt emits its own `running` event, so a retried delivery shows up more than once.

Plugins:

- `brainstem.plugin.log`

Destination output envelopes sent by the HTTP JSON destination use:

- `brainstem.output`

## Snapshots

`brainstem.snapshot` contains the currently known graph topology:

```js
{
  inputs: [
    { id, plugin, input, module, intervalMs }
  ],
  core: {
    id: "host:1234:9f2c1a7b",
    status: "running"
  },
  destinations: [
    { id, plugin, destination, module, decisions, routes, sources, types }
  ]
}
```

Snapshots let a Web UI reconnect or restart and rebuild the graph without waiting for every input to poll again.

## Plugin logs

Input and destination plugins receive a scoped `ctx.logger`. Calls to that logger are forwarded as `brainstem.plugin.log` telemetry and also go through the runtime logger.

```js
ctx.logger.debug("http health check result", {
  status,
  emitted
});
```

Plugin log events are useful for node-level drilldown in the Web UI. Destination plugin logs carry `destinationId`; input plugin logs carry the input `id`.
