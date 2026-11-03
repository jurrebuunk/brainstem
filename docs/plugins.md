# Plugins

Plugins are npm packages. Inputs observe the world (health checks, issues, inboxes, logs); destinations act on decisions (notify, post, start an agent). Brainstem's own plugins are published as `@brainstem-dev/plugin-<name>`. Third-party plugins are ordinary npm packages too, and every plugin can be installed, pinned, updated and removed the same way.

## Installing plugins

```sh
npm install -g @brainstem-dev/brainstem
brainstem init                         # brainstem.config.mjs + the plugin folder with the defaults
brainstem plugins list
brainstem plugins add email-imap       # a built-in, by its short name
brainstem plugins add @brainstem-dev/plugin-matrix@2.0.0
brainstem plugins add brainstem-plugin-jira             # third party
brainstem plugins remove @brainstem-dev/plugin-matrix
brainstem plugins update
```

Plugins live in the **plugin folder**: `--plugins-dir`, `BRAINSTEM_PLUGINS_DIR`, or `./brainstem-plugins`. It is a small npm project of its own (`package.json`, `package-lock.json`, `node_modules`). `brainstem plugins add|remove|update` run npm in it, so anything npm installs works: names, `name@version`, tarballs, git URLs. You can also manage it with npm directly (`npm install --prefix brainstem-plugins ...`).

`brainstem init` installs the defaults (the core version's plugins):

- http-health
- tls-certificate
- github-issues
- log-file
- static-observations
- http-json
- log-decisions
- matrix

After that they are ordinary packages: remove the ones you don't use, pin versions, or add the optional ones (email-imap, opencode-runner, agentos-runner).

Refer to a plugin in the config by its package name:

```js
inputs: [{ id: "api-health", module: "@brainstem-dev/plugin-http-health", input: "check", config: { ... } }],
destinations: [{ id: "log", module: "@brainstem-dev/plugin-log-decisions", config: { ... } }]
```

Brainstem looks for packages in the plugin folder first, then next to the working directory, then next to itself. A local file still works (`module: "./my-plugin/index.mjs"`), and the 1.x paths of the built-ins (`./plugins/matrix/index.mjs`) map to their packages.

### Docker and Kubernetes

The Docker image contains every built-in plugin. To add others, build your own image on top of it (the runtime image has no npm):

```dockerfile
FROM node:24-slim AS plugins
WORKDIR /plugins
RUN npm init -y >/dev/null && npm install --omit=dev brainstem-plugin-jira @brainstem-dev/plugin-email-imap@2.0.0

FROM ghcr.io/jurrebuunk/brainstem:v2.1.0
COPY --from=plugins --chown=node:node /plugins /app/brainstem-plugins
```

With the Helm chart, set `image.repository` and `image.tag` to that image. Every core then runs the same plugins, which cluster mode needs.

## Built-in plugins

### Inputs

| Plugin | Package | Default | Purpose | Docs |
| --- | --- | --- | --- | --- |
| HTTP Health | `@brainstem-dev/plugin-http-health` | yes | Poll HTTP endpoints and emit health state changes. | [HTTP Health](http-health.md) |
| TLS Certificate | `@brainstem-dev/plugin-tls-certificate` | yes | Check TLS certificate validity and expiry. | [TLS Certificate](tls-certificate.md) |
| GitHub Issues | `@brainstem-dev/plugin-github-issues` | yes | Poll GitHub issues and emit only new or changed ones. | [GitHub Issues](plugins/github-issues.md) |
| Log File | `@brainstem-dev/plugin-log-file` | yes | Watch a log file and emit new error lines as one bounded observation per poll. | [Log File](plugins/log-file.md) |
| Static Observations | `@brainstem-dev/plugin-static-observations` | yes | Emit configured observations (smoke tests, demos). | [Static Observations](plugins/static-observations.md) |
| Email IMAP | `@brainstem-dev/plugin-email-imap` | | Poll an IMAP inbox and emit new email observations. | [Email IMAP](email-imap.md) |

### Destinations

| Plugin | Package | Default | Purpose | Docs |
| --- | --- | --- | --- | --- |
| Log Decisions | `@brainstem-dev/plugin-log-decisions` | yes | Print matching decisions to stdout. | [Log Decisions](plugins/log-decisions.md) |
| HTTP JSON | `@brainstem-dev/plugin-http-json` | yes | POST output envelopes to an HTTP endpoint. | [HTTP JSON](plugins/http-json.md) |
| Matrix | `@brainstem-dev/plugin-matrix` | yes | Send matching decisions to a Matrix room. | [Matrix](matrix-destination.md) |
| OpenCode Runner | `@brainstem-dev/plugin-opencode-runner` | | Run opencode for matching decisions. | [OpenCode Runner](plugins/opencode-runner.md) |
| agentOS Runner | `@brainstem-dev/plugin-agentos-runner` | | Run a small bounded task (command or agent prompt) in an agentOS VM. | [agentOS Runner](plugins/agentos-runner.md) |

## Writing a plugin

A plugin is a package whose default export is a plugin object. Build it with [`@brainstem-dev/sdk`](../packages/sdk/README.md):

```js
import { defineInputPlugin } from "@brainstem-dev/sdk";

export default defineInputPlugin({
  apiVersion: "brainstem.input/v1",
  name: "acme-queue-depth",
  inputs: { default: { mode: "poll", async *poll(ctx) { /* yield ctx.observation({...}) */ } } }
});
```

In its `package.json`:

- declare `"@brainstem-dev/sdk": "^2.0.0"` as a **peer** dependency;
- add the keyword `brainstem-plugin`;
- add `"brainstem": { "kind": "input" }` (or `"destination"`).

Test it with `@brainstem-dev/sdk/testing` (`runInput`, `runDestination`, `createTestOutput`), then `npm publish`. See the [input plugin API](input-plugins.md), the [destination API](destination-adapters.md) and the [plugins in this repository](../plugins) for complete examples.

## Plugin APIs

- [Input plugin API](input-plugins.md)
- [Destination adapter API](destination-adapters.md)

## Configuration

Plugins are configured in `brainstem.config.mjs`:

```js
inputs: [
  {
    id: "api-health",
    module: "@brainstem-dev/plugin-http-health",
    input: "check",
    config: { ... }
  }
],

destinations: [
  {
    module: "@brainstem-dev/plugin-log-decisions",
    destination: "default",
    decisions: ["queue", "dispatch", "escalate"],
    config: { ... }
  }
]
```

See [Configuration](configuration.md).

## Plugin state (`ctx.state`)

Input and destination contexts carry a small key/value store for plugin state
such as suppression state, cursors or caches. It is available to
`brainstem.input/v1` and to both `brainstem.destination/v2` and the
deprecated `brainstem.destination/v1`.

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
