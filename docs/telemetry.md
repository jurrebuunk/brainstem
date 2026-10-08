# Runtime Telemetry

Telemetry is structured machine-readable runtime activity for the Web UI and future monitoring tools. It is separate from human console logs and from destination plugins.

Configure it with:

```js
runtime: {
  telemetry: {
    url: "http://127.0.0.1:5173/api/events",
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
    ...
  }
}
```

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

Destinations:

- `brainstem.destination.loaded`
- `brainstem.destination.running`
- `brainstem.destination.completed`
- `brainstem.destination.failed`

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
    status: "running"
  },
  destinations: [
    { plugin, destination, module, decisions, routes, sources, types }
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

Plugin log events are useful for node-level drilldown in the Web UI.
