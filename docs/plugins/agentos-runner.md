# agentOS Runner Destination

Runs a small task in a [Rivet agentOS](https://rivet.dev/agent-os) VM for each matching Brainstem decision. It's meant for cheap, bounded work such as searching logs, gathering evidence or summarizing an issue into a report. Big jobs such as fixes stay with a full agent runner like [opencode-runner](opencode-runner.md).

The plugin is generic. It knows nothing about Matrix, logs or GitHub. Each destination entry that uses it is one **task**, with its own:

- **trigger**: the normal destination filters (`decisions`, `routes`, `sources`, `types`)
- **work**: a `command` to run, or a `prompt` for an agent
- **permissions**: network allowlist, mounted directories, env
- **tools**: host functions the task may call. They run in Brainstem, so secrets never enter the VM.

agentOS runs in-process: each run boots a lightweight VM (WebAssembly and V8 isolates, about 100–250 ms), and the VM is disposed when the run ends.

> **Status:** `command` tasks are complete. `prompt` (agent) tasks are accepted by the config but agent sessions are not implemented yet, so a `prompt` task fails its delivery.

## Install

agentOS is an optional dependency. `npm install` installs it by default. For an install without it, use `npm install --omit=optional`. The Docker image leaves it out unless you build with `--build-arg INSTALL_OPTIONAL=true`.

```sh
npm install @rivet-dev/agentos-core
```

The plugin only loads agentOS when an `agentos-runner` entry actually runs.

### NixOS

agentOS starts a native sidecar binary built for generic Linux, which NixOS can't start directly. Point `AGENTOS_SIDECAR_BIN` at a wrapper that runs it through the Nix glibc loader, or enable `programs.nix-ld`:

```sh
#!/bin/sh
exec /nix/store/<glibc>/lib64/ld-linux-x86-64.so.2 \
  --library-path /nix/store/<libgcc>/lib:/nix/store/<glibc>/lib \
  /path/to/node_modules/@rivet-dev/agentos-runtime-sidecar-linux-x64-gnu/agentos-native-sidecar "$@"
```

Without a working sidecar, VM creation hangs. The plugin gives up after `bootTimeoutMs` and the delivery is retried.

## Module

```js
"./plugins/agentos-runner/index.mjs"
```

## Example

Two tasks from one plugin. Brainstem's filters decide which task gets a decision.

```js
import { defineAgentOsTask } from "./plugins/agentos-runner/index.mjs";
import { sendRoomMessage } from "./plugins/matrix/client.mjs";

// A tool any task can be given. It runs on the host.
const sendReport = {
  description: "Send a short markdown report to the operator",
  input: {
    title: { type: "string", maxLength: 200 },
    markdown: { type: "string", maxLength: 8000 }
  },
  required: true,
  maxCalls: 1,
  async run({ title, markdown }, ctx) {
    await sendRoomMessage({
      homeserver: "https://matrix.example.org",
      roomId: "!ops:example.org",
      token: process.env.MATRIX_ACCESS_TOKEN,
      content: { msgtype: "m.text", body: `${title}\n\n${markdown}` },
      // Stable across retries, so Matrix drops a duplicate send.
      txnId: ctx.idempotencyKey,
      retry: { attempts: 3, minDelayMs: 1000, maxDelayMs: 10000, factor: 2 }
    });
    return { sent: true };
  }
};

export default {
  // ...
  destinations: [
    {
      id: "log-triage",
      module: "./plugins/agentos-runner/index.mjs",
      decisions: ["queue", "escalate"],
      sources: ["http"],
      config: defineAgentOsTask({
        command: [
          "grep -n ERROR /mnt/logs/app.log | tail -20 > /tmp/errors",
          "agentos-tools send-report --title {{observation.summary}} --markdown \"$(cat /tmp/errors)\""
        ].join("\n"),
        mounts: [{ path: "/mnt/logs", hostPath: "/var/log/myapp" }],
        tools: { sendReport }
      })
    },
    {
      id: "issue-summary",
      module: "./plugins/agentos-runner/index.mjs",
      decisions: ["queue"],
      sources: ["github"],
      types: ["issue"],
      config: defineAgentOsTask({
        prompt: "Rewrite GitHub issue {{observation.data.title}} as a clear bug report for a coding agent, then send it with send-report.",
        allowHosts: ["api.anthropic.com"],
        tools: { sendReport }
      })
    }
  ]
};
```

Give every entry a stable `id`. It names the node in the Web UI and is part of each delivery's idempotency key.

`defineAgentOsTask` is optional. It validates the task when the config file loads, so a typo fails at startup instead of on the first matching delivery.

## What a run does

1. Skips the run if `minRouteConfidence` or `runOnce` says so. The skip is logged.
2. Boots a VM with the entry's mounts, network allowlist, software and tools.
3. Writes the full `brainstem.output` envelope to `/inbox/envelope.json`.
4. Runs the `command`, or the agent with the `prompt`.
5. Reads `/outbox/result.json`, if the task wrote one.
6. Checks that every `required` tool was called.
7. Calls `onResult`, logs the outcome and disposes the VM.

The delivery fails, and Brainstem retries it with backoff, when:
- the VM doesn't boot within `bootTimeoutMs`
- the run exceeds `timeoutMs`
- the command exits non-zero (unless `failOnExitCode: false`)
- a required tool wasn't called (unless `onMissingRequired` is set)

## Options

```js
command               // shell command (string template or (event) => string); exactly one of command/prompt
prompt                // agent task (string template or (event) => string); agent sessions not implemented yet
agent                 // agent for prompt tasks; default "pi"
allowHosts            // hosts the VM may reach, e.g. ["api.anthropic.com"]; default: none
mounts                // [{ path, hostPath, readOnly }]; readOnly defaults to true
env                   // extra environment variables for the run
software              // agentOS software, e.g. [{ registry: "ripgrep" }, { registry: "jq" }]
tools                 // host tools, see below
toolCollection        // CLI name inside the VM: agentos-<toolCollection>; default "tools"
inboxPath             // default /inbox/envelope.json
outboxPath            // default /outbox/result.json
timeoutMs             // whole run; default 120000
bootTimeoutMs         // VM boot; default 30000
failOnExitCode        // fail the delivery on a non-zero exit; default true
runOnce               // "revision" (default) or "emission", see below
minRouteConfidence    // skip decisions whose route confidence is below this (0..1)
onMissingRequired     // ({ missing, event }, ctx) => void; replaces the failure when a required tool wasn't called
onResult              // ({ result, exitCode, stdout, stderr, toolCalls, event }, ctx) => void
outputLogMaxChars     // max chars of stdout/stderr/result per log entry; default 4000
```

## Templates

String templates use `{{path}}` placeholders over the envelope, with the inner envelopes unwrapped:

```text
{{observation.id}}  {{observation.summary}}  {{observation.data.title}}
{{decision.decision}}  {{decision.route}}  {{decision.reason}}
{{input.id}}  {{destination.id}}  {{idempotencyKey}}
```

Objects are rendered as JSON, and a missing path renders as an empty string.

In a `command`, every value is **shell-quoted**, because observation data such as issue titles and email subjects is untrusted. A title like `x; rm -rf /` arrives as one harmless argument. Use placeholders as whole arguments (`--title {{observation.summary}}`), not inside your own quotes.

A function template receives the raw `brainstem.output` payload and must return the final text, with any quoting done by you.

## Tools

Tools are host functions. Inside the VM each one is a command:

```sh
agentos-tools send-report --title "Disk full" --markdown "..."
# prints {"ok":true,"result":{"sent":true}}
```

The command name is the tool key in kebab-case (`sendReport` → `send-report`; `snake_case` stays as it is).

```js
tools: {
  sendReport: {
    description: "...",          // required; the agent reads it
    input: {                     // field: "string" | "number" | "integer" | "boolean", "string?" for optional,
      title: "string",           // or { type, optional, description, maxLength, enum }
      severity: { type: "string", enum: ["low", "high"], optional: true }
    },
    required: false,             // must be called before the run ends
    maxCalls: 10,                // calls beyond this are refused
    timeoutMs: 30000,
    async run(args, ctx) { ... } // returns a JSON-serializable result
  }
}
```

The plugin enforces these rules. It doesn't rely on the task following its prompt:

- Only the tools listed on the entry exist in its VM.
- Arguments are checked against `input`: unknown fields, wrong types, `maxLength` and `enum` are rejected before `run` executes.
- Rejected and failed calls count against `maxCalls`, so a confused agent can't loop on a tool.
- `run` gets `ctx.idempotencyKey` (`<delivery key>:<tool>:<call number>`), plus `ctx.call`, `ctx.attempt`, `ctx.logger`, `ctx.signal` and `ctx.event`.

### Retries don't repeat side effects

Each completed call is recorded in plugin state under the delivery's idempotency key, the tool name and the call number. If the delivery fails later (for example the command exits non-zero) and Brainstem retries it, the retried run's matching calls return the recorded result without running the tool again. The records are deleted once the delivery succeeds.

This matches calls by order, which is exact for a `command`. An agent that takes a different path on the retry may make different calls. For external effects, also pass `ctx.idempotencyKey` on (as a Matrix `txnId` or an `Idempotency-Key` header).

## Re-emitted observations

Inputs can re-emit an unchanged observation, for example a reminder for an alert that is still firing. Each re-emission is a new delivery. With `runOnce: "revision"` (the default), a task runs once per observation revision and skips the re-emissions. A changed observation gets a new revision and runs again. Use `runOnce: "emission"` to run on every emission.

## Logging and Web UI

Logs appear under the entry's destination node:

- `agentos runner started` / `agentos runner skipped` / `agentos runner completed`
- `agentos command output`: exit code, stdout and stderr (truncated)
- `agentos tool call` / `agentos tool call replayed` / `agentos tool call failed`
- `agentos required tools not called`

## Known agentOS 0.4.6 limitations

- **Redirected `node` output is lost.** `node script.js > file`, `| ...` and `$(node ...)` produce nothing. Have node write files itself (`fs.writeFileSync`). Shell tools like `grep` and `sed` redirect normally.
- **The default VM has no `rg`, `jq` or `curl`.** It does have `grep`, `sed`, `awk`, `find`, `node` and `python`. Add more with `software`.
- **Host function timers outlive the call.** agentOS keeps each tool's timeout timer running after the call returns. This doesn't matter in a running Brainstem, but a short script exits only after `timeoutMs`.
- **Native binaries need a sandbox.** Native binaries and heavy compilation need a full Linux sandbox mounted into the VM, which this plugin doesn't configure.
