# HTTP Health Input

The HTTP health input polls one or more URLs and emits Brainstem observations.

## Single URL

```js
inputs: [
  {
    id: "api-health",
    module: "./plugins/http-health/index.mjs",
    input: "check",
    config: {
      url: "https://example.com/health",
      timeoutMs: 10000,
      expectedStatuses: [[200, 399]],
      failureThreshold: 3,
      recoveryThreshold: 2,
      minimumDecisionOnFailure: "dispatch"
    }
  }
]
```

## Multiple URLs

```js
inputs: [
  {
    id: "service-health",
    module: "./plugins/http-health/index.mjs",
    input: "check",
    config: {
      checks: [
        {
          id: "http:api:health",
          name: "api",
          url: "https://api.example.com/health"
        },
        {
          id: "http:web:health",
          name: "web",
          url: "https://www.example.com/"
        }
      ]
    }
  }
]
```

## Options

```js
url                         // URL for a single check
checks                      // array for multiple checks
method                      // default: GET
timeoutMs                   // default: 10000
expectedStatuses            // default: [[200, 399]]
emitHealthy                 // default: true
failureThreshold            // default: 1; failed polls required before unhealthy
recoveryThreshold           // default: 1; healthy polls required before recovery
minimumDecisionOnFailure    // optional: queue, dispatch, escalate
```

`failureThreshold` and `recoveryThreshold` are backed by the standard input checkpoint API. This prevents one transient timeout from immediately producing an alert.

The adapter emits observations with:

```js
source.type = "http"
type = "health_check"
state = "healthy" | "unhealthy"
```

Use destination filters to route HTTP health decisions:

```js
destinations: [
  {
    module: "./plugins/matrix/index.mjs",
    destination: "room",
    decisions: "all",
    routes: ["infrastructure"],
    sources: ["http"],
    types: ["health_check"],
    config: { ... }
  }
]
```
