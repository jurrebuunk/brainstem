# Architecture

Brainstem is split into four layers:

```text
Input plugins → Runtime → Core → Destination plugins
```

## Input plugins

Input plugins observe external systems and emit standardized observations.

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

Destination plugins react to decisions.

Examples:

- logging to stdout
- sending Matrix messages
- webhooks or agent runners in the future

Destinations can be filtered by:

- decision level
- route
- observation source
- observation type

## State

Brainstem has two state types:

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
