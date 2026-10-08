# OpenCode Runner Destination

Runs [opencode](https://opencode.ai/) for each matching Brainstem decision and waits until the agent process exits.

This destination is intended as a first agent-runner output plugin. It keeps Brainstem core separate from agent execution while still surfacing agent activity through destination/plugin logs and runtime telemetry.

## Module

```js
"./plugins/opencode-runner/index.mjs"
```

## Example

Start an opencode server if you want to use server attach mode:

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
      attach: "http://127.0.0.1:4096",
      model: "anthropic/claude-sonnet-4-20250514",
      systemPrompt: "You are working in this repository. Prefer small, tested changes. Do not commit unless asked.",
      timeoutMs: 30 * 60 * 1000
    }
  }
]
```

Without `attach`, the plugin runs `opencode run ...` locally and lets opencode manage its own server/session behavior.

## Options

```js
executable                  // default: "opencode"
baseArgs                    // optional args before "run", useful for wrappers/tests
attach                      // optional opencode server URL
model                       // optional provider/model
agent                       // optional opencode agent name
dir                         // optional working directory for opencode
cwd                         // process cwd for spawning opencode; default process.cwd()
title                       // optional session title
username                    // optional server basic auth username
password                    // optional server basic auth password
passwordEnv                 // env var for server password; default OPENCODE_SERVER_PASSWORD
env                         // extra environment variables
systemPrompt                // context instructions prepended to the agent prompt
promptTemplate(event)       // optional function returning the complete prompt
timeoutMs                   // optional kill timeout
dangerouslySkipPermissions  // passes --dangerously-skip-permissions when true
extraArgs                   // optional args appended at the end
```

## Prompt

By default the plugin builds a prompt containing:

- `systemPrompt` as context/instructions, when configured
- the Brainstem decision envelope
- the observation envelope

If `promptTemplate(event)` is provided, it replaces the default prompt builder.

## Logging and Web UI

The plugin logs:

- `opencode runner started`
- `opencode event` for parsed JSON events from `opencode run --format json`
- `opencode stdout` / `opencode stderr` for non-JSON output
- `opencode runner completed`
- `opencode runner failed`

When runtime telemetry is enabled, these logs appear under the OpenCode destination node in the Web UI.

## Failure behavior

A non-zero opencode exit code throws from the destination. By default Brainstem logs destination failures but does not block input checkpoints. Set `runtime.destinations.blockInputOnFailure: true` only if you want agent-runner failure to prevent input checkpoint commits.
