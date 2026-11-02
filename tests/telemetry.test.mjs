import test from "node:test";
import assert from "node:assert/strict";

import {
  eventDestinationKey,
  eventInputId,
  eventLevel,
  eventObservationId,
  eventPollId,
  eventSourceKey,
  metricsForEvent
} from "../src/telemetry/events.mjs";

test("telemetry selectors normalize runtime event shapes", () => {
  const event = {
    version: "1",
    kind: "brainstem.destination.completed",
    payload: {
      plugin: "@brainstem/http-json",
      destination: "default",
      observationId: "obs-1",
      pollId: "input-1:123",
      decision: "dispatch"
    }
  };

  assert.equal(eventObservationId(event), "obs-1");
  assert.equal(eventPollId(event), "input-1:123");
  assert.equal(eventDestinationKey(event), "@brainstem/http-json:default");
  assert.equal(eventSourceKey(event), "destination:@brainstem/http-json:default");
  assert.equal(eventLevel(event), "event");
});

test("telemetry selectors normalize output envelopes", () => {
  const event = {
    version: "1",
    kind: "brainstem.output",
    payload: {
      pollId: "input-1:123",
      input: { id: "input-1" },
      destination: { plugin: "@brainstem/http-json", name: "default" },
      observation: { payload: { id: "obs-1" } },
      decision: { payload: { decision: "dispatch" } }
    }
  };

  assert.equal(eventInputId(event), "input-1");
  assert.equal(eventObservationId(event), "obs-1");
  assert.equal(eventDestinationKey(event), "@brainstem/http-json:default");
  assert.equal(eventLevel(event), "output");
});

test("metrics are derived consistently from telemetry events", () => {
  assert.deepEqual(
    metricsForEvent({ kind: "brainstem.core.decision", payload: { decision: { payload: { decision: "queue" } } } }).sort(),
    ["decisions.queue", "decisions.total", "events.total"].sort()
  );

  assert.deepEqual(
    metricsForEvent({ kind: "brainstem.plugin.log", payload: { level: "error" } }).sort(),
    ["errors.total", "events.total", "plugin.errors"].sort()
  );

  assert.deepEqual(
    metricsForEvent({ kind: "brainstem.destination.failed", payload: { dead: false } }).sort(),
    ["destinations.failed", "errors.total", "events.total"].sort()
  );

  assert.deepEqual(
    metricsForEvent({ kind: "brainstem.destination.failed", payload: { dead: true } }).sort(),
    ["destinations.dead", "destinations.failed", "errors.total", "events.total"].sort()
  );

  assert.deepEqual(
    metricsForEvent({ kind: "brainstem.core.failed", payload: { dead: true } }).sort(),
    ["decisions.dead", "decisions.failed", "errors.total", "events.total"].sort()
  );
});

test("telemetry helpers read origins, destination ids and core ids, including older events", async () => {
  const { eventCoreId, eventDestinationId, eventOrigin, metricsForEvent } = await import("../src/telemetry/events.mjs");

  const handoff = { kind: "brainstem.core.decision", payload: { coreId: "core-a", origin: { kind: "destination", id: "log-triage", depth: 1 } } };
  assert.deepEqual(eventOrigin(handoff), { kind: "destination", id: "log-triage", depth: 1 });
  assert.equal(eventCoreId(handoff), "core-a");

  // Recorded before origins existed.
  assert.deepEqual(eventOrigin({ kind: "brainstem.core.decision", payload: { inputId: "destination:log-triage" } }), { kind: "destination", id: "log-triage" });
  assert.deepEqual(eventOrigin({ kind: "brainstem.core.decision", payload: { inputId: "api-health" } }), { kind: "input", id: "api-health" });
  assert.equal(eventOrigin({ kind: "brainstem.snapshot", payload: {} }), null);

  assert.equal(eventDestinationId({ kind: "brainstem.output", payload: { destination: { id: "ops-room" } } }), "ops-room");
  assert.equal(eventDestinationId({ kind: "brainstem.destination.failed", payload: { destinationId: "ops-room" } }), "ops-room");
  assert.ok([...metricsForEvent({ kind: "brainstem.destination.emitted", payload: {} })].includes("handoffs.emitted"));
});
