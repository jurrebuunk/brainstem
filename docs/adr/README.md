# Architecture Decision Records

An Architecture Decision Record (ADR) captures one significant architectural decision: the context that forced it, what was decided, the alternatives that were rejected, and the consequences. ADRs are kept in the repository so they are versioned with the code and reviewed like it.

The records here use the [Michael Nygard format](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions): Status, Context, Decision, Alternatives considered, Consequences. The 2.0 decisions originate from §7 of the [Brainstem 2.0 roadmap](../roadmap-2.0.md).

## Adding an ADR

1. Copy [template.md](template.md) to `NNNN-short-title.md`, using the next free four-digit number.
2. Fill in Context, Decision, Alternatives considered and Consequences. Keep it short.
3. Set the status and add a row to the index below.

Status values:

- **Proposed** — under discussion, not yet binding.
- **Accepted** — binding; implementation should follow it.
- **Superseded** — replaced by a later ADR. Do not edit the old decision; set its status to `Superseded by [ADR-NNNN](...)` and link back from the new one.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-postgres-only-cluster-mode.md) | Cluster mode uses Postgres only; no message broker | Accepted |
| [0002](0002-lease-based-input-scheduling.md) | Lease-based input scheduling; no elected scheduler | Accepted |
| [0003](0003-kysely-and-in-house-queue.md) | Kysely for the DB layer, with an in-house queue | Accepted |
| [0004](0004-destination-plugin-sdk-v2.md) | Destination plugin SDK v2 with a v1 shim through 2.x | Accepted |
| [0005](0005-config-as-versioned-data.md) | Config as versioned, JSON-Schema-validated data | Accepted |
| [0006](0006-model-distribution-oci-image.md) | Laya model ships as a separate `brainstem-models` OCI image | Accepted |
