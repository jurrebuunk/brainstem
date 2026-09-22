# Brainstem

A lightweight decision and orchestration layer for autonomous AI agents.

Brainstem sits between external systems and AI agents. It continuously monitors configured sources, uses a local decision model to determine whether something requires attention, and only wakes an agent when actual reasoning or action is needed.

The goal is simple: **keep expensive agents asleep until there is something worth doing.**

## Concept

Many autonomous agents use a heartbeat to periodically wake up, inspect their environment, and determine whether anything needs attention.

This works, but means repeatedly invoking an LLM even when nothing has changed.

Brainstem moves that responsibility into a lightweight external service.

```text
GitHub ──────┐
Logs ────────┤
Metrics ─────┤
Services ────┤
Schedules ───┘
      │
      ▼
 ┌───────────┐
 │ Brainstem │
 │           │
 │ Monitors  │
 │     ↓     │
 │   Laya    │
 │     ↓     │
 │ Decision  │
 └─────┬─────┘
       │
       │ something requires attention
       ▼
 ┌───────────┐
 │   Agent   │
 │           │
 │  Hermes   │
 │    etc.   │
 └───────────┘
```

Brainstem acts as a small, always-running **brainstem** around larger AI agents.

## Why?

Instead of an agent doing this:

```text
wake up
↓
check GitHub
↓
check logs
↓
check metrics
↓
nothing happened
↓
sleep
↓
repeat
```

Brainstem continuously performs the inexpensive checks itself.

```text
monitor
monitor
monitor
↓
event detected
↓
Laya decision
↓
ignore
```

When something actually requires reasoning:

```text
monitor
↓
event detected
↓
Laya decision
↓
action required
↓
wake agent
```

The agent can then receive a specific task rather than a generic heartbeat.

## Laya

Brainstem uses [Laya](https://github.com/receptron/laya) as its lightweight decision layer.

Laya is a local typed decision model. Instead of generating arbitrary text, it answers bounded questions such as:

```text
Does this require an agent?

yes: 0.94
no:  0.06
```

or:

```text
What kind of task is this?

coding          0.81
infrastructure  0.12
security        0.05
other           0.02
```

This makes it suitable for deciding **whether** a larger generative model needs to be invoked.

## Monitors

Brainstem is intended to provide one central place for defining things an agent should care about.

Examples include:

* GitHub issues and activity
* application logs
* system logs
* infrastructure metrics
* Kubernetes events
* HTTP endpoints
* scheduled checks
* custom data sources

Monitors produce events when something changes.

```text
Monitor
   │
   ▼
 Event
   │
   ▼
 Laya
   │
   ├── ignore
   │
   └── wake agent
```

This avoids having every external system maintain its own webhook or direct integration with an agent.

## Project Layout

Brainstem is split into a small core, runtime, SDK, and directory-based plugins:

```text
src/core/                 decision engine and record stores
src/runtime/              plugin loading, routing, checkpoints
src/sdk/                  adapter author helpers
plugins/<name>/index.mjs  plugin entrypoints
```

Root files such as `core.mjs`, `runtime.mjs`, and `sdk.mjs` are compatibility re-exports.

## Input Plugins

Input plugins are loadable source adapters. They observe one external system and emit standardized Brainstem observations.

A plugin exports a small object:

```js
import { defineInputPlugin } from "./src/sdk/index.mjs";

export default defineInputPlugin({
  apiVersion: "brainstem.input/v1",
  name: "my-input",

  inputs: {
    default: {
      mode: "poll",
      defaultIntervalMs: 60_000,

      async *poll(ctx) {
        yield ctx.observation({
          id: "example:1",
          source: { type: "example", name: "demo" },
          type: "status",
          state: "open",
          title: "Example observation",
          message: "Something happened"
        });
      }
    }
  }
});
```

The runtime loads local plugin files and sends emitted observations to the core:

```js
import config from "./brainstem.config.mjs";
import { BrainstemRuntime } from "./runtime.mjs";

const runtime = new BrainstemRuntime({
  config,
  plugins: [
    {
      module: "./plugins/github-issues/index.mjs",
      input: "issues",
      config: {
        repo: "owner/repo",
        tokenEnv: "GITHUB_TOKEN"
      }
    }
  ],
  destinations: [
    {
      module: "./plugins/log-decisions/index.mjs",
      destination: "default"
    }
  ]
});

await runtime.start();
await runtime.wait();
```

Or add plugin entries to `brainstem.config.mjs` under `inputs` and run:

```sh
node brainstem.mjs
```

For adapter development, poll once and exit:

```sh
node brainstem.mjs --once
```

Print ignored decisions too:

```sh
node brainstem.mjs --once --all
```

Keep tokens in environment variables, not in committed config files:

```js
inputs: [
  {
    module: "./plugins/github-issues/index.mjs",
    input: "issues",
    config: {
      repo: "owner/repo",
      tokenEnv: "GITHUB_TOKEN",

      // Equivalent:
      // token: { env: "GITHUB_TOKEN" }
    }
  }
]
```

Then start Brainstem with:

```sh
GITHUB_TOKEN=... node brainstem.mjs
```

For a one-shot local smoke test:

```sh
node run-plugin-test.mjs
```

## HTTP Health Input

Brainstem includes a simple HTTP health input adapter:

```js
inputs: [
  {
    id: "api-health",
    module: "./plugins/http-health/index.mjs",
    input: "check",
    config: {
      url: "https://example.com/health",
      timeoutMs: 10_000,
      expectedStatuses: [[200, 399]],
      minimumDecisionOnFailure: "dispatch"
    }
  }
]
```

For multiple endpoints, use `config.checks`.

## Destination Adapters

Destination adapters receive decisions after Brainstem processes observations.

The first destination adapter simply logs non-ignored decisions:

```js
destinations: [
  {
    module: "./plugins/log-decisions/index.mjs",
    destination: "default",
    decisions: ["queue", "dispatch", "escalate"],
    routes: ["coding", "security"],
    sources: ["github"],
    types: ["issue"],
    config: {
      prefix: "brainstem"
    }
  }
]
```

Destinations can filter by decision level, the core's abstract route, observation source, and observation type. Use `"all"` or omit a filter to receive every value for that field.

Brainstem also includes a Matrix room destination:

```js
destinations: [
  {
    module: "./plugins/matrix/index.mjs",
    destination: "room",
    decisions: ["dispatch", "escalate"],
    routes: "all",
    config: {
      homeserver: "https://matrix.org",
      roomId: "!roomid:matrix.org",
      tokenEnv: "MATRIX_ACCESS_TOKEN"
    }
  }
]
```

Keep the Matrix access token in the environment:

```sh
MATRIX_ACCESS_TOKEN=... node brainstem.mjs
```

This keeps decision handling outside the core. Later adapters can wake agents, call webhooks, or enqueue tasks.

See `docs/input-plugins.md` for adapter author guidance, stable ID conventions, checkpoint handling, token handling, and retry configuration. See `docs/state.md` for persistent core records and input checkpoints.

Phase 1 intentionally supports only local file plugins and polling inputs. NPM package loading, richer secrets helpers, streaming inputs, and richer destination adapters can be added later without changing the core.

## Agents

Brainstem does not replace agents.

It decides when they should run.

The initial idea is to use Brainstem alongside [Hermes Agent](https://github.com/NousResearch/hermes-agent).

```text
Brainstem
    │
    │ task requires reasoning
    ▼
  Hermes
    │
    ▼
 investigate / act
```

Hermes can remain focused on reasoning and tool use while Brainstem handles continuous observation.

The architecture is intentionally simple enough that other agents could be connected in the future.

## State

Brainstem should keep track of events it has already processed.

For example, if a GitHub issue remains open for several hours, the agent should not be triggered every time the repository is checked.

```text
GitHub issue #42
      │
      ▼
first observation
      │
      ▼
Laya → wake agent
      │
      ▼
event remembered


next check
      │
      ▼
same issue
      │
      ▼
already processed
      │
      ▼
ignore
```

A new event or meaningful state change can cause the situation to be evaluated again.

## Philosophy

Brainstem separates an autonomous system into two levels:

```text
            BRAINSTEM
       cheap / always running
               │
               │ important event
               ▼
              AGENT
      expensive / intelligent
```

The small model watches.

The large model thinks.

## Goals

* Reduce unnecessary LLM heartbeat calls
* Keep monitoring centralized
* Run the decision layer locally
* Avoid requiring individual webhook integrations
* Provide agents with specific tasks instead of generic heartbeat prompts
* Keep monitoring independent from the agent implementation
* Make autonomous agents cheaper to leave running continuously

## Status

Brainstem is currently an experimental project exploring local decision models as an orchestration layer for autonomous agents.

The initial focus is:

* monitoring
* event normalization
* Laya-based decisions
* persistent state
* Hermes Agent triggering

## Related Projects

* [Laya](https://github.com/receptron/laya) — local typed decision models
* [Hermes Agent](https://github.com/NousResearch/hermes-agent) — autonomous AI agent

## License

License to be determined.

---

**Brainstem** — *Let small models decide when big models need to think.*

### GitHub Topics

`ai` `ai-agents` `agent-orchestration` `laya` `hermes-agent` `local-ai` `decision-models` `automation` `self-hosted` `event-driven` `llm` `agentic-ai` `monitoring`
