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
minimumDecisionOnFailure    // optional: queue, dispatch, escalate
```

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
    decisions: ["dispatch", "escalate"],
    routes: ["infrastructure"],
    sources: ["http"],
    types: ["health_check"],
    config: { ... }
  }
]
```
