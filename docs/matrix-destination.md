# Matrix Destination

The Matrix destination sends Brainstem decisions to a Matrix room using the Matrix Client-Server API.

It includes notification policy, repeat suppression, recovery messages, delivery retries, optional Matrix threads, and persistent delivery state.

## Config

```js
destinations: [
  {
    module: "./plugins/matrix/index.mjs",
    destination: "room",

    // Use "all" when recovery notifications are enabled,
    // because recovery usually arrives as an ignore decision.
    decisions: "all",

    routes: "all",
    sources: ["http"],
    types: ["health_check"],

    config: {
      homeserver: "https://matrix.org",
      roomId: "!roomid:matrix.org",
      tokenEnv: "MATRIX_ACCESS_TOKEN",

      notify: {
        repeatAfterMs: 60 * 60 * 1000,
        onRecovery: true,
        statePath: "data/matrix-notifications.json"
      },

      retry: {
        attempts: 3,
        minDelayMs: 1000,
        maxDelayMs: 30000,
        factor: 2
      },

      message: {
        format: "text"
      },

      threading: true
    }
  }
]
```

Run with:

```sh
MATRIX_ACCESS_TOKEN=... node brainstem.mjs
```

## Notification behavior

By default the Matrix destination sends:

- first actionable alert
- reminder after `repeatAfterMs` while the same incident is still active
- recovery message when a previously active incident becomes non-actionable

Default actionable decisions are:

```js
["dispatch", "escalate"]
```

Configure them with:

```js
notify: {
  actionableDecisions: ["dispatch", "escalate"],
  repeatAfterMs: 60 * 60 * 1000,
  onRecovery: true,
  statePath: "data/matrix-notifications.json"
}
```

Set `repeatAfterMs: null` to disable reminders.

Set `statePath: false` to use in-memory notification state. Persistent state is recommended for real monitoring so Brainstem does not resend ongoing alerts after restart.

## Rate limits and retries

Matrix delivery retries transient errors:

- HTTP `429` rate limits
- HTTP `5xx` server errors
- network errors

For `429`, Brainstem respects Matrix `retry_after_ms` when present.

```js
retry: {
  attempts: 3,
  minDelayMs: 1000,
  maxDelayMs: 30000,
  factor: 2
}
```

## Message formatting

Plain text is the default. Messages are written for humans and include a clear alert type, short explanation, decision, route, source, reason, and URL when available.

Example:

```text
🚨 Brainstem alert: api is unhealthy

This observation should be investigated now.

Decision: DISPATCH
Route: infrastructure
State: unhealthy
Source: http/api
Type: health_check
Observation: http-health:api
Reason: Observation requires immediate investigation

URL: https://example.com/health
```

Configure text output:

```js
message: {
  format: "text",
  compact: false
}
```

Set `compact: true` for shorter room messages.

HTML formatting is also supported:

```js
message: {
  format: "html"
}
```

For advanced use, provide a config template function in local config:

```js
template(event) {
  return `Brainstem ${event.decision.payload.decision}: ${event.observation.payload.title}`;
}
```

## Threading

Matrix threading is enabled by default:

```js
threading: true
```

When Matrix returns an `event_id`, repeats and recoveries are sent as thread replies to the previous alert. Set `threading: false` to disable this.

## Token options

Preferred:

```js
tokenEnv: "MATRIX_ACCESS_TOKEN"
```

Also supported:

```js
token: { env: "MATRIX_ACCESS_TOKEN" }
```

or, for local testing only:

```js
accessToken: "..."
```

Do not commit access tokens.

## Routing example

Send HTTP health alerts and recoveries to Matrix:

```js
destinations: [
  {
    module: "./plugins/matrix/index.mjs",
    destination: "room",
    decisions: "all",
    routes: "all",
    sources: ["http"],
    types: ["health_check"],
    config: {
      homeserver: "https://matrix.org",
      roomId: "!roomid:matrix.org",
      tokenEnv: "MATRIX_ACCESS_TOKEN",
      notify: {
        repeatAfterMs: 60 * 60 * 1000,
        onRecovery: true,
        statePath: "data/matrix-notifications.json"
      }
    }
  }
]
```
