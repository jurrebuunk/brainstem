# Architecture

Brainstem is split into a headless runtime plus optional presentation/operations layers:

```text
Input plugins → Runtime → Core → Destination plugins
                      │
                      └── telemetry → Web UI
```

## Input plugins

Input plugins observe external systems and emit standardized observations. They should deduplicate at the source with checkpoints so unchanged source data does not repeatedly enter the core.

Examples:

- GitHub issues
- HTTP health checks
- logs or chats in future plugins

Input plugins do not call Laya and do not wake agents directly.

## Runtime

The runtime owns operational behavior around the core:

- loading local plugin modules
- polling inputs
- retries and backoff
- input checkpoints
- validating observations
- calling the core
- routing decisions to destinations
- structured telemetry for live views, stats, and operational dashboards

## Core

The core is the decision engine:

```text
observation → fingerprint → dedupe → Laya signals → policy → decision
```

It produces decision envelopes with:

- `decision`: `ignore`, `queue`, `dispatch`, or `escalate`
- `route`: abstract technical route such as `infrastructure`, `coding`, `security`, or `general`
- signal scores
- reason
- timestamp

The core does not know about GitHub, Matrix, Hermes, webhooks, or other concrete systems.

## Destination plugins

Destination plugins react to decisions. Destination failures are isolated from input checkpoints by default, so output outages do not force inputs to reprocess old source items.

Examples:

- logging to stdout
- sending Matrix messages
- HTTP JSON/webhook output
- agent runners in the future

Destinations can be filtered by:

- decision level
- route
- observation source
- observation type

## Telemetry and Web UI

The runtime can emit structured telemetry over HTTP. The Web UI consumes this telemetry and output envelopes to show a live graph of inputs, the core, and destinations. The Web UI is a separate app under `web/`; it does not own config or run Brainstem logic.

## State

Brainstem has two durable state types:

1. Core records — durable SQLite cache of latest decision per observation ID.
2. Input checkpoints — adapter cursors or stability state.

See [State](state.md).

## Design principle

Brainstem keeps semantic judgement separate from external integrations:

```text
Core decides what something means.
Runtime decides where it goes.
Plugins decide how to talk to external systems.
```
