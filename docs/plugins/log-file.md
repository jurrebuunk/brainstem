# Log File Input

Watches a log file and emits an observation when new lines match a pattern (by default `ERROR`, `FATAL`, `CRITICAL` or `PANIC`).

## Module

```js
"@brainstem-dev/plugin-log-file"
```

## Example

```js
inputs: [
  {
    id: "app-log",
    module: "@brainstem-dev/plugin-log-file",
    input: "lines",
    intervalMs: 30000,
    config: {
      path: "/var/log/myapp/app.log",
      name: "myapp",
      minimumDecision: "queue"
    }
  }
]
```

## Behaviour

- **Only new lines.** Lines are read from the byte offset stored in the input's checkpoint. Only complete lines are read; a partially written last line waits for the next poll.
- **Start at the end.** By default the first poll starts at the end of the file, so an existing log isn't replayed. Set `startFromEnd: false` to read it from the start.
- **Truncation and rotation.** If the file shrinks or is replaced (a different inode), it's read from the start again.
- **One bounded observation per poll.** All matches from one poll become a single observation, `log:<name>:errors`. It holds the last `maxLines` matches, each cut to `maxLineChars`, and the total count. A noisy log produces one event, not hundreds.
- **Missing file.** Polls log a warning and emit nothing.

## Options

```js
path            // required; the log file
name            // default: the file name; part of the observation id
pattern         // regex source; default "\\b(ERROR|FATAL|CRITICAL|PANIC)\\b"
flags           // regex flags, e.g. "i"; default ""
startFromEnd    // default true
maxLines        // matching lines kept per observation; default 20
maxLineChars    // per line; default 300
maxReadBytes    // read per poll; default 1 MiB (the rest is read next poll)
minimumDecision // optional facts.minimum_decision: queue, dispatch or escalate
```

## Observation

```text
id       log:<name>:errors
source   { type: "log", name }
type     log_errors
state    error
title    "<n> error lines in <name>"
message  the matching lines
facts    { matches, minimum_decision? }
data     { path, lines, totalMatches, fromOffset, toOffset }
```
