# Brainstem Core

## Purpose

The Brainstem core is the decision-making layer between external observations and agents.

Its purpose is to cheaply determine whether an observation deserves further action before involving a larger and more expensive agent.

The basic principle is:

**Small model watches, large model thinks.**

Brainstem does not investigate or fix problems itself. It decides whether something should be ignored, queued, dispatched to an agent, or escalated.

---

## Responsibilities

The core is responsible for:

* Receiving standardized observations.
* Detecting whether an observation has meaningfully changed.
* Avoiding repeated analysis of unchanged observations.
* Using Laya to judge observations.
* Applying generic deterministic policy.
* Routing actionable observations to a general technical domain.
* Maintaining revisions for observations.
* Producing standardized decision envelopes.

The core should remain independent of specific external systems.

It should not contain knowledge about Kubernetes, GitHub, SSH, Matrix, Hermes, monitoring systems, or other integrations.

Those concerns belong in adapters around the core.

---

## Observation Model

Brainstem receives standardized observation envelopes.

An observation represents the current known state of something.

An observation contains:

* A stable ID.
* Its source.
* Its type.
* Its current state.
* A timestamp.
* A human-readable title and message.
* Optional deterministic facts.
* Optional source-specific data.

The observation ID identifies the thing being observed over time.

Multiple observations with the same ID are therefore treated as revisions of the same logical observation.

---

## Fingerprinting

Brainstem creates a SHA-256 fingerprint from the meaningful contents of an observation.

The timestamp is intentionally excluded.

This allows a monitor to repeatedly report the same state without causing another Laya evaluation.

If the ID and fingerprint match the current stored record, Brainstem returns the existing decision.

If the ID is the same but the fingerprint changes, the observation is reevaluated and its revision increases.

A fingerprint identifies observation content, while a revision identifies a state transition in the history of an observation.

Because of this, an observation may return to an older fingerprint while still receiving a new revision.

---

## Laya

Laya provides the semantic judgement used by Brainstem.

Brainstem currently evaluates four possible signals:

### Attention

Determines whether the observation represents abnormal or problematic behavior that deserves investigation.

### Actionable

Determines whether a technical agent could usefully investigate, diagnose, fix, or otherwise act on the observation.

### Severity

Estimates the technical impact of the observation.

Severity is only evaluated when it can affect the decision.

### Route

Chooses the primary technical domain responsible for the observation.

Current routes are:

* infrastructure
* coding
* security
* general

Routing is only performed when the final decision requires further action.

---

## Lazy Evaluation

Brainstem deliberately avoids asking every Laya question for every observation.

Attention and actionable are evaluated first.

From those results, Brainstem determines whether severity is still necessary.

If the observation can already be ignored, severity and route are skipped.

If the observation already qualifies for queue or dispatch without severity, severity is skipped.

Route is only evaluated when the final decision is not `ignore`.

This significantly reduces inference time while preserving the same decision behavior.

---

## Decisions

Brainstem has four ordered decisions:

1. `ignore`
2. `queue`
3. `dispatch`
4. `escalate`

### Ignore

The observation does not currently require further action.

### Queue

The observation represents legitimate work for an agent, but does not require immediate handling.

### Dispatch

The observation should be sent to an agent for immediate investigation or action.

### Escalate

The observation requires human attention, approval, or another higher-level intervention.

The ordering is important because deterministic policy can raise a decision to a minimum level.

---

## Deterministic Minimum Decisions

Observations may contain a `minimum_decision` fact.

This allows a source adapter or other deterministic system to specify the minimum acceptable response.

Laya may cause Brainstem to choose a higher decision, but it cannot lower the decision below this minimum.

This keeps deterministic rules separate from semantic judgement.

For example, a source that already knows a particular event must always be dispatched can express that requirement without teaching the Brainstem core about that source.

---

## Policy

The current policy combines attention, actionable, and severity signals.

High attention combined with sufficient actionability results in dispatch.

Moderately actionable observations can be queued when their severity is high enough.

Highly actionable observations can also be queued without requiring severity.

Everything else is ignored unless a deterministic minimum raises the decision.

The thresholds themselves are configuration rather than fundamental core behavior.

---

## Evaluation Queue

Laya evaluation is globally serialized.

Only one changed observation uses Laya at a time.

Once evaluation of an observation begins, that observation keeps access to Laya until all required questions and routing have completed.

This prevents multiple observations from interleaving Laya questions and was found to provide substantially better inference performance.

Cached observations do not enter the Laya evaluation queue.

---

## Per-ID Ordering

Observations sharing the same ID are processed in arrival order.

This prevents concurrent updates to the same observation from overwriting each other or producing incorrect revisions.

Different observation IDs may enter Brainstem concurrently, but semantic Laya evaluation remains globally serialized.

---

## Revisions

A new observation ID begins at revision 1.

When the meaningful content for that ID changes, the revision increases.

Repeated observations with the same fingerprint do not increase the revision.

Revisions therefore describe meaningful transitions rather than polling frequency.

---

## Caching

Brainstem keeps the latest record for each observation ID in memory.

A record contains:

* The current revision.
* The current fingerprint.
* The latest observation.
* The latest decision.

When an unchanged observation arrives, the latest observation is updated so its timestamp remains current, while the existing decision is reused.

The decision revision, fingerprint, and decision timestamp remain unchanged.

---

## Mutation Isolation

Brainstem does not trust callers to leave objects unchanged.

Incoming observations are copied before asynchronous processing begins.

Stored observations and decisions are also isolated from objects returned to callers.

This prevents external code from accidentally changing Brainstem's internal state.

---

## Decision Envelope

A decision identifies the observation it belongs to and contains:

* Observation ID.
* Revision.
* Fingerprint.
* Decision.
* Route.
* Semantic signals.
* Route confidence.
* Human-readable reason.
* Decision timestamp.

Some semantic fields may be `null`.

A null value normally means the signal was intentionally not evaluated because lazy evaluation determined it could no longer affect the result.

It should not automatically be interpreted as an error.

---

## Boundaries

The core intentionally does not handle:

* Source polling.
* Scheduling.
* Transport.
* Credentials.
* Configuration file loading.
* Observation validation.
* Persistent storage.
* Agent execution.
* Notifications.
* External API communication.
* Source-specific policy.
* Destination-specific behavior.

These belong outside the core.

A source adapter converts external state into a Brainstem observation.

A destination adapter converts a Brainstem decision into an appropriate external action.

This boundary is important because it keeps the core small and allows new sources and agents to be added without modifying Brainstem's decision logic.

---

## Design Principle

Brainstem should remain a small decision engine rather than becoming an orchestration framework.

Its job is:

**Observe → deduplicate → judge → decide → route.**

Everything before observation creation and everything after decision creation should normally be handled by another component.
