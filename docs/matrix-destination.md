# Matrix Destination

The Matrix destination sends Brainstem decisions to a Matrix room using the Matrix Client-Server API.

## Config

```js
destinations: [
  {
    module: "./plugins/matrix/index.mjs",
    destination: "room",
    decisions: ["dispatch", "escalate"],
    routes: "all",
    config: {
      homeserver: "https://matrix.org",
      roomId: "!roomid:matrix.org",
      tokenEnv: "MATRIX_ACCESS_TOKEN"
    }
  }
]
```

Run with:

```sh
MATRIX_ACCESS_TOKEN=... node brainstem.mjs
```

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

Send only HTTP health dispatches to Matrix:

```js
destinations: [
  {
    module: "./plugins/matrix/index.mjs",
    destination: "room",
    decisions: ["dispatch", "escalate"],
    routes: ["infrastructure"],
    sources: ["http"],
    types: ["health_check"],
    config: {
      homeserver: "https://matrix.org",
      roomId: "!roomid:matrix.org",
      tokenEnv: "MATRIX_ACCESS_TOKEN"
    }
  }
]
```
