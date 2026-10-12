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
});
