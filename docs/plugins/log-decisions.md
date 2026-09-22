# Log Decisions Destination

Logs matching Brainstem decisions to stdout.

## Module

```js
"./plugins/log-decisions/index.mjs"
```

## Config

```js
destinations: [
  {
    module: "./plugins/log-decisions/index.mjs",
    destination: "default",
    decisions: ["queue", "dispatch", "escalate"],
    routes: "all",
    sources: "all",
    types: "all",
    config: {
      prefix: "brainstem",
      colors: true
    }
  }
]
```

## Options

```js
prefix   // default: brainstem
colors   // default: true
```

## Use cases

- local debugging
- smoke tests
- seeing ignored decisions with `--all`
- running Brainstem without a chat/webhook destination
