# 0007. Destinations hand observations back to the core

- Status: Accepted
- Date: 2026-11-02

## Context

Small agent tasks (the `agentos-runner` destination) produce results such as a log-triage report or an issue summary. Those results should reach people (Matrix) or a bigger agent (opencode-runner) through the normal decision and routing path: the core should decide what happens next, not each destination.

Destinations had no way to feed anything back. A destination plugin received a `brainstem.output` envelope and could only act on the outside world (ADR-0004). Wiring an agent's report into Matrix or another agent would have meant per-plugin glue, with its own retries and no decision step.

The risk is loops: a destination whose output reaches itself again, or a chain of destinations feeding each other, could spend model budget or spam a room indefinitely.

## Decision

A v2 destination can call `ctx.emit(observation)` to hand an observation back to the core. The observation goes through the normal decide stage: policy, `facts.minimum_decision`, destination filters.

- **Committed with the delivery.** Emitted observations are collected during `handle()` and enqueued as decide jobs in the same transaction that marks the delivery delivered (`src/runtime/runtime.mjs`, `#deliver`). A failed or retried delivery emits nothing, so nothing is emitted twice.
- **Explicit origin.** A handed-off observation has no input. Its decide job, decision telemetry and output envelope carry `origin: { kind: "destination", id, plugin, name, depth, lineage }`. Observations from inputs carry `origin: { kind: "input", id }`.
- **No loops by construction.**
  - `lineage` lists the destinations the observation passed through, and it is never delivered to any of them (`#decide` filters on `origin.lineage`).
  - `runtime.handoff.maxDepth` (default 2) bounds the chain length; `ctx.emit` throws past it.
  - `runtime.handoff.maxPerDelivery` (default 5) bounds the fan-out per delivery.
- **Visible.** A `brainstem.destination.emitted` telemetry event marks each committed handoff. The Web UI shows it on the emitting destination only while it happens.

The agentOS runner uses this through its `handoff` option: a successful run's report becomes an `agent_report` observation with a configurable minimum decision.

## Alternatives considered

- **Destinations call other destinations directly** (for example an agent tool that posts to Matrix). Rejected: it bypasses the decision step and routing, duplicates retry and idempotency logic per tool, and couples plugins to each other.
- **A separate "results" input that polls a shared table or file.** Rejected: an extra moving part with its own checkpoint, and no transactional link to the delivery, so a retried delivery could produce a result twice.
- **Reuse the `input` field** (an input id like `destination:<id>`). This was the first implementation. Rejected: everything reading `input` treated the handoff as an input (stats, the Web UI drew a fake input node). Replaced by `origin` (see Consequences).

## Consequences

Positive:

- The core decides what happens to an agent's result, like any other observation. Routing a report to Matrix or to a bigger agent is configuration, not code.
- Exactly-once emission relative to the delivery, using the existing job transaction.
- Loops are impossible within a chain, and chains are short and bounded.

Negative:

- Destination contexts gain a capability: plugin authors must understand that emitted observations are decided again and can trigger other destinations.
- A handed-off observation may be routed back into a destination outside its lineage that emits again. That is bounded by `maxDepth`, but needs care in configuration.

Follow-ups:

- The Web UI renders handoffs from `origin` and `brainstem.destination.emitted` (done).
- Runtimes before `origin` recorded handoffs as input `destination:<id>`. Readers map that form (`eventOrigin` in `src/telemetry/events.mjs`) and can drop it after 3.0.
