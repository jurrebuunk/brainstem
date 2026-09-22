# TLS Certificate Input

The TLS certificate input checks certificate validity and expiry for HTTPS/TLS endpoints.

## Module

```js
"./plugins/tls-certificate/index.mjs"
```

## Single host

```js
inputs: [
  {
    id: "example-tls",
    module: "./plugins/tls-certificate/index.mjs",
    input: "check",
    config: {
      host: "example.com",
      port: 443,
      warnDays: 14,
      criticalDays: 3,
      minimumDecisionOnWarning: "queue",
      minimumDecisionOnCritical: "dispatch"
    }
  }
]
```

## Multiple hosts

```js
inputs: [
  {
    id: "tls-sites",
    module: "./plugins/tls-certificate/index.mjs",
    input: "check",
    config: {
      warnDays: 14,
      criticalDays: 3,
      targets: [
        { host: "example.com" },
        { host: "api.example.com", servername: "api.example.com" }
      ]
    }
  }
]
```

## Options

```js
host                       // required for single target
port                       // default: 443
servername                 // default: host
timeoutMs                  // default: 10000
warnDays                   // default: 14
criticalDays               // default: 3
checkAuthorization          // default: true
emitHealthy                // default: true
minimumDecisionOnWarning   // default: queue
minimumDecisionOnCritical  // default: dispatch
targets                    // array for multiple targets
```

## Emitted observations

```js
source.type = "tls"
type = "certificate"
state = "valid" | "expiring" | "critical" | "expired" | "invalid" | "unreachable"
```

Observation ID:

```text
tls:<host>:<port>
```

## Matrix routing

To send TLS alerts and recoveries to Matrix:

```js
destinations: [
  {
    module: "./plugins/matrix/index.mjs",
    destination: "room",
    decisions: "all",
    sources: ["tls"],
    types: ["certificate"],
    config: {
      homeserver: "https://matrix.example.org",
      roomId: "!roomid:example.org",
      tokenEnv: "MATRIX_ACCESS_TOKEN"
    }
  }
]
```
