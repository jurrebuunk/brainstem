# OpenCode Runner Destination

Calls a running [opencode](https://opencode.ai/) server for each matching Brainstem decision.

This destination is intended as a first agent-runner output plugin. It keeps Brainstem core separate from agent execution while still surfacing agent activity through destination/plugin logs and runtime telemetry.

## Module

```js
"./plugins/opencode-runner/index.mjs"
```

## Example

Start an opencode server:

```sh
opencode serve --hostname 127.0.0.1 --port 4096
```

Configure the destination:

```js
destinations: [
  {
    module: "./plugins/opencode-runner/index.mjs",
    destination: "default",
    decisions: ["queue", "dispatch"],
    routes: ["coding"],
    sources: ["github"],
    types: ["issue"],
    config: {
      serverUrl: "http://127.0.0.1:4096",
      model: "anthropic/claude-sonnet-4-20250514",
      systemPrompt: "You are working in this repository. Prefer small, tested changes. Do not commit unless asked.",
      waitForCompletion: false,
      timeoutMs: 2 * 60 * 1000
    }
  }
]
```

The plugin uses opencode's HTTP API directly. It does not spawn a local `opencode run` process. It submits the prompt with `prompt_async`. By default it waits briefly for assistant output so the Web UI can show the agent response, but that wait is bounded by `outputTimeoutMs`.

## Options

```js
serverUrl             // default: http://127.0.0.1:4096
url                   // alias for serverUrl
attach                // alias for serverUrl, for compatibility with opencode CLI wording
model                 // optional provider/model string or { providerID, modelID }
agent                 // optional opencode agent name
dir                   // optional working directory sent as API directory query
directory             // alias for dir
workspace             // optional workspace query
title                 // optional opencode session title
username              // optional basic auth username; default opencode
password              // optional basic auth password
passwordEnv           // env var for server password; default OPENCODE_SERVER_PASSWORD
headers               // extra HTTP headers
systemPrompt          // context instructions sent as opencode message system field
promptTemplate(event) // optional function returning the complete prompt
waitForCompletion     // optional; false by default; true treats timeout as a failure
captureOutput         // optional; true by default; waits up to outputTimeoutMs and logs assistant text
outputTimeoutMs       // optional output capture timeout; defaults to timeoutMs or 2 minutes
timeoutMs             // optional request/status-wait timeout
statusPollIntervalMs  // status poll interval when waiting; default 1000
initialStatusDelayMs  // first status poll delay when waiting; default 1000
eventLogLimit         // max streamed opencode SSE events to log; default 200
outputLogMaxChars     // max assistant output chars per log; default 4000
permission            // optional opencode session permission config
```

## Prompt

By default the plugin builds a prompt containing:

- `systemPrompt` as context/instructions, when configured
- the Brainstem decision envelope
- the observation envelope

If `promptTemplate(event)` is provided, it replaces the default prompt builder.

## Logging and Web UI

The plugin logs:

- `opencode api runner started`
- `opencode session created`
- `opencode api event` for streamed opencode SSE events
- `opencode assistant output delta` for streamed assistant text chunks when available
- `opencode assistant output` with the final assistant text found in session messages
- `opencode assistant output unavailable` when OpenCode completes/returns without text parts
- `opencode api runner completed`
- API errors as destination failures

When runtime telemetry is enabled, these logs appear under the OpenCode destination node in the Web UI.

## Failure behavior

OpenCode API errors throw from the destination. By default Brainstem logs destination failures but does not block input checkpoints. Set `runtime.destinations.blockInputOnFailure: true` only if you want agent-runner failure to prevent input checkpoint commits.
