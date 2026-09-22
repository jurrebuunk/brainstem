# Matrix Destination

The Matrix destination sends Brainstem decisions to a Matrix room using the Matrix Client-Server API.

It includes notification throttling so repeated polls of the same ongoing incident do not spam the room.

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
        onRecovery: true
      }
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
  onRecovery: true
}
```

Set `repeatAfterMs: null` to disable reminders.

Notification state is currently in-memory and resets when Brainstem restarts. Core decision records still prevent repeated Laya evaluations after restart.

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
        onRecovery: true
      }
    }
  }
]
```
