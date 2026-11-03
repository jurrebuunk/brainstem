# Log Decisions Destination

Logs matching Brainstem decisions to stdout.

## Module

```js
"@brainstem-dev/plugin-log-decisions"
```

## Config

```js
destinations: [
  {
    module: "@brainstem-dev/plugin-log-decisions",
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
