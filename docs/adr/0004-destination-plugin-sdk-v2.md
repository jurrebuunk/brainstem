# 0004. Destination plugin SDK v2 with a v1 shim through 2.x

- Status: Accepted
- Date: 2026-10-13

## Context

Destinations run sequentially inside the poll loop and receive live plugin objects. Delivery is not idempotent (roadmap §2):

- Poll-level retry re-delivers to destinations that already succeeded (`src/runtime/runtime.mjs:945-953`).
- Matrix uses a random `txnId` per attempt (`plugins/matrix/client.mjs:31`).
- opencode-runner creates a new session per event (`plugins/opencode-runner/index.mjs:26`).
- There are no delivery records.

In 2.0, each (decision, destination) pair becomes its own `deliver` job, which may run on a different core than the one that polled ([ADR-0001](0001-postgres-only-cluster-mode.md)). Live objects cannot cross a queue. Delivery is at-least-once, so an exactly-once *effect* needs an idempotency key the plugin can pass on. The serializable `brainstem.output` payload already exists (`plugins/http-json/index.mjs:43-66`).

## Decision

Introduce `brainstem.destination/v2`: `handle(ctx, output)` receives the serializable `brainstem.output` payload plus `ctx.idempotencyKey` (`observation_id:revision:destination`) instead of live plugin objects. This is a breaking change for destinations.

- All built-in destinations are migrated: `http-json` sends `Idempotency-Key`, Matrix uses the key as `txnId`, opencode-runner keys its session on it.
- A v1 adapter keeps third-party destinations working through 2.x and logs a deprecation warning. It is removed in 3.0.
- The input SDK stays v1. Inputs gain an optional `ctx.lease` for long-lived connections ([ADR-0002](0002-lease-based-input-scheduling.md)).

## Alternatives considered

- **Keep the v1 contract with live objects** — rejected. Live objects cannot be serialized into a job, so deliveries could not move to separate jobs or cores.
- **Hard break with no shim** — rejected. It would break third-party plugins on upgrade with no migration window.
- **Also break the input SDK** — rejected as unnecessary. Inputs only need an optional lease handle, which can be added without a breaking change.

## Consequences

Positive:

- Deliveries can be queued, retried, dead-lettered and redriven per destination. A failing Matrix delivery no longer re-triggers the webhook or the poll.
- Duplicate effects are prevented at the destination via idempotency keys, plus a `deliveries` log check before sending.
- Destinations can scale separately (`--queues=deliver` worker groups).

Negative:

- Third-party destination authors must migrate before 3.0.
- The v1 shim is extra code to keep through 2.x, and v1 plugins run without idempotency keys, so they get weaker guarantees.

Follow-ups:

- SDK v2, migration of built-in plugins, idempotency keys, v1 shim (Phase 2).
- Optional `ctx.lease` for inputs (Phase 3).
- Plugin v2 migration guide (Phase 5).
