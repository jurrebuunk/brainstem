# Built-in Plugins

Brainstem ships local plugins under `plugins/`.

## Input plugins

| Plugin | Module | Purpose | Docs |
| --- | --- | --- | --- |
| GitHub Issues | `./plugins/github-issues/index.mjs` | Poll open GitHub issues and emit issue observations. | [GitHub Issues](plugins/github-issues.md) |
| HTTP Health | `./plugins/http-health/index.mjs` | Poll HTTP endpoints and emit health check observations. | [HTTP Health](http-health.md) |
| TLS Certificate | `./plugins/tls-certificate/index.mjs` | Check TLS certificate validity and expiry. | [TLS Certificate](tls-certificate.md) |
| Static Observations | `./plugins/static-observations/index.mjs` | Emit configured observations for smoke tests. | [Static Observations](plugins/static-observations.md) |

## Destination plugins

| Plugin | Module | Purpose | Docs |
| --- | --- | --- | --- |
| Log Decisions | `./plugins/log-decisions/index.mjs` | Print matching decisions to stdout. | [Log Decisions](plugins/log-decisions.md) |
| Matrix | `./plugins/matrix/index.mjs` | Send matching decisions to a Matrix room. | [Matrix](matrix-destination.md) |

## Plugin APIs

- [Input plugin API](input-plugins.md)
- [Destination adapter API](destination-adapters.md)

## Configuration

Plugins are configured in `brainstem.config.mjs`:

```js
inputs: [
  {
    id: "api-health",
    module: "./plugins/http-health/index.mjs",
    input: "check",
    config: { ... }
  }
],

destinations: [
  {
    module: "./plugins/log-decisions/index.mjs",
    destination: "default",
    decisions: ["queue", "dispatch", "escalate"],
    config: { ... }
  }
]
```

See [Configuration](configuration.md).
