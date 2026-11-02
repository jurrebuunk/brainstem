# Built-in Plugins

Brainstem ships local plugins under `plugins/`.

## Input plugins

| Plugin | Module | Purpose | Docs |
| --- | --- | --- | --- |
| GitHub Issues | `./plugins/github-issues/index.mjs` | Poll GitHub issues and emit only new/changed issue observations. | [GitHub Issues](plugins/github-issues.md) |
| Email IMAP | `./plugins/email-imap/index.mjs` | Poll an IMAP inbox and emit new email observations. | [Email IMAP](email-imap.md) |
| HTTP Health | `./plugins/http-health/index.mjs` | Poll HTTP endpoints and emit health state changes. | [HTTP Health](http-health.md) |
| TLS Certificate | `./plugins/tls-certificate/index.mjs` | Check TLS certificate validity/expiry and emit certificate state changes. | [TLS Certificate](tls-certificate.md) |
| Static Observations | `./plugins/static-observations/index.mjs` | Emit configured observations for smoke tests. | [Static Observations](plugins/static-observations.md) |

## Destination plugins

| Plugin | Module | Purpose | Docs |
| --- | --- | --- | --- |
| Log Decisions | `./plugins/log-decisions/index.mjs` | Print matching decisions to stdout. | [Log Decisions](plugins/log-decisions.md) |
| Matrix | `./plugins/matrix/index.mjs` | Send matching decisions to a Matrix room. | [Matrix](matrix-destination.md) |
| HTTP JSON | `./plugins/http-json/index.mjs` | POST output envelopes to an HTTP endpoint. | [HTTP JSON](plugins/http-json.md) |
| OpenCode Runner | `./plugins/opencode-runner/index.mjs` | Run opencode for matching decisions and stream runner logs. | [OpenCode Runner](plugins/opencode-runner.md) |

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

## Plugin state (`ctx.state`)

Input and destination contexts carry a small key/value store for plugin state
such as suppression state, cursors or caches. It is additive to
`brainstem.input/v1` and `brainstem.destination/v1`.

```js
await ctx.state.get(key);            // value, or undefined when absent
await ctx.state.set(key, value);     // store a JSON-serializable value
await ctx.state.delete(key);         // true when a value was removed
await ctx.state.update(key, fn);     // atomic read-modify-write, returns the new value
```

- Keys are non-empty strings; values must be JSON-serializable.
- `update(key, current => next)` runs inside a database transaction
  (`BEGIN IMMEDIATE` on SQLite, `SELECT ... FOR UPDATE` on Postgres), so two
  Brainstem processes sharing a database cannot lose each other's writes.
  `current` is `undefined` when the key is absent. Return `undefined` to leave
  the value unchanged. `fn` may run more than once if a concurrent writer wins
  a race, so compute only from its argument and keep it short.
- State is namespaced per plugin entry: `destination:<plugin>:<destination>`
  or `input:<plugin>:<input>`, followed by `:<id>` when the config entry has an
  `id` (inputs without an `id` use their checkpoint key). Two destination
  entries for the same plugin should get distinct `id`s if they must not share
  state.
- The runtime stores state in the `plugin_state` table of the Brainstem
  database when it is given a database-backed store (`pluginState` runtime
  option). Without one, state is kept in memory and lost on restart.
  Contexts created directly with `createInputContext()` /
  `createDestinationContext()` and no `stateStore` share a process-local
  memory store.
