# Static Observations Input

Emits configured observations. This is mainly for smoke tests and demos.

## Module

```js
"@brainstem-dev/plugin-static-observations"
```

## Config

```js
inputs: [
  {
    id: "static-test",
    module: "@brainstem-dev/plugin-static-observations",
    input: "default",
    config: {
      observations: [
        {
          id: "test:1",
          source: { type: "test", name: "demo" },
          type: "status",
          state: "open",
          title: "Production API is failing",
          message: "The API has returned HTTP 500 for the last 5 checks."
        }
      ]
    }
  }
]
```

The plugin wraps each entry with `ctx.observation()`, so timestamps and observation envelopes are created consistently.

## Use cases

- verifying the runtime
- testing destinations
- producing deterministic observations without external APIs
