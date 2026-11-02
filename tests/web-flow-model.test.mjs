import assert from "node:assert/strict";
import test from "node:test";

import { HANDOFF_VISIBLE_MS, buildFlowModel } from "../web/src/flow/model.js";

const NOW = Date.parse("2026-11-02T12:00:30.000Z");
const at = seconds => new Date(Date.parse("2026-11-02T12:00:00.000Z") + seconds * 1000).toISOString();

const topology = {
  cores: [
    { id: "core-a", status: "running", role: "all", queues: ["poll", "decide", "deliver"], lastSeenAt: at(25) },
    { id: "core-b", status: "lost", role: "all", queues: ["deliver"], lastSeenAt: at(-120) }
  ],
  consistent: true,
  inputs: [{ id: "test-app-log", plugin: "@brainstem/log-file", input: "lines" }],
  destinations: [
    { id: "log-triage", plugin: "@brainstem/agentos-runner", destination: "default" },
    { id: "issue-summary", plugin: "@brainstem/agentos-runner", destination: "default" },
    { id: "ops-room", plugin: "@brainstem/matrix", destination: "room" }
  ]
};

const event = (kind, payload, seconds = 20) => ({
  kind,
  receivedAt: at(seconds),
  payload: { timestamp: at(seconds), ...payload }
});

// One log-triage run that hands its report to ops-room.
const handoffRun = [
  event("brainstem.input.poll.started", { id: "test-app-log", coreId: "core-a", pollId: "p1" }, 10),
  event("brainstem.input.observation", { id: "test-app-log", pollId: "p1", observation: { payload: { id: "log:app:errors" } } }, 10),
  event("brainstem.core.decision", { observationId: "log:app:errors", inputId: "test-app-log", origin: { kind: "input", id: "test-app-log" } }, 11),
  event("brainstem.destination.running", { plugin: "@brainstem/agentos-runner", destination: "default", destinationId: "log-triage", observationId: "log:app:errors" }, 12),
  event("brainstem.destination.emitted", { plugin: "@brainstem/agentos-runner", destination: "default", destinationId: "log-triage", observations: ["agentos:log-triage:log:app:errors"], depth: 1 }, 20),
  event("brainstem.core.decision", { observationId: "agentos:log-triage:log:app:errors", inputId: null, origin: { kind: "destination", id: "log-triage", depth: 1, lineage: ["log-triage"] } }, 21),
  event("brainstem.destination.failed", { plugin: "@brainstem/matrix", destination: "room", destinationId: "ops-room", observationId: "agentos:log-triage:log:app:errors", dead: false }, 22)
];

const node = (model, id) => model.nodes.find(candidate => candidate.id === id);
const edge = (model, id) => model.edges.find(candidate => candidate.id === id);

test("the flow is built from the topology, one node per configured id", () => {
  const model = buildFlowModel({ topology, events: [], now: NOW });

  assert.equal(model.structure, "topology");
  assert.deepEqual(model.nodes.map(candidate => candidate.id), [
    "input:test-app-log",
    "core",
    "destination:log-triage",
    "destination:issue-summary",
    "destination:ops-room"
  ], "two tasks of one plugin are two nodes");
  assert.equal(node(model, "destination:issue-summary").data.label, "issue-summary");
  assert.equal(node(model, "destination:issue-summary").data.subtitle, "@brainstem/agentos-runner.default");
});

test("the core pool node summarises the registered cores", () => {
  const model = buildFlowModel({ topology, events: [], now: NOW });
  const core = node(model, "core");

  assert.equal(core.data.label, "Core pool");
  assert.equal(core.data.subtitle, "2 cores · 1 running · 1 lost");
  assert.equal(core.data.status, "degraded");
  assert.equal(model.cores.length, 2);

  const offline = buildFlowModel({ topology: { ...topology, cores: [{ id: "c", status: "stopped" }] }, events: [], now: NOW });
  assert.equal(node(offline, "core").data.status, "offline");

  const drift = buildFlowModel({ topology: { ...topology, consistent: false }, events: [], now: NOW });
  assert.equal(node(drift, "core").data.footnote, "cores loaded different configs");
});

test("a handoff shows briefly as a pill node linked to the destination, then disappears", () => {
  // The report was decided at 21 s; 4 s later the handoff is live.
  const live = buildFlowModel({ topology, events: handoffRun, now: Date.parse(at(25)) });
  const stamp = Date.parse(at(21));

  assert.ok(!live.nodes.some(candidate => candidate.id.startsWith("input:destination")), "no fake input node");

  const pill = node(live, `handoff:log-triage:${stamp}`);
  assert.equal(pill.type, "handoffPill");
  assert.equal(pill.selectable, false);
  assert.deepEqual(pill.data, { label: "↩ handing off", destinationId: "log-triage" });
  assert.ok(pill.position.x > node(live, "destination:log-triage").position.x, "right of its destination");
  assert.equal(pill.position.y, node(live, "destination:log-triage").position.y, "same y as its destination");

  const link = edge(live, `edge-handoff-log-triage-${stamp}`);
  assert.equal(link.source, "destination:log-triage");
  assert.equal(link.sourceHandle, "handoff-out");
  assert.equal(link.target, pill.id);
  assert.equal(link.targetHandle, "in");
  assert.equal(link.type, "default", "an ordinary edge");
  assert.equal(link.animated, true);

  assert.equal(node(live, "destination:log-triage").data.handingOff, true);
  assert.equal(node(live, "destination:issue-summary").data.handingOff, false);
  assert.equal(node(live, "core").data.active, true, "the core lights up as for any decision");

  // Once HANDOFF_VISIBLE_MS has passed, only the count remains.
  const later = buildFlowModel({ topology, events: handoffRun, now: stamp + HANDOFF_VISIBLE_MS + 1 });
  assert.ok(!later.nodes.some(candidate => candidate.type === "handoffPill"));
  assert.ok(!later.edges.some(candidate => candidate.id.startsWith("edge-handoff-")));
  assert.equal(node(later, "destination:log-triage").data.handingOff, false);
  assert.ok(node(later, "destination:log-triage").data.meta.some(item => item.label === "handoffs" && item.value === 1));
  assert.equal(node(later, "destination:ops-room").data.status, "retrying");
});

test("events are attributed to nodes by id", () => {
  const model = buildFlowModel({ topology, events: handoffRun, now: NOW });

  assert.deepEqual(model.nodeIdsFor(handoffRun[2]), ["input:test-app-log", "core"]);
  assert.deepEqual(model.nodeIdsFor(handoffRun[5]), ["core"], "a handed-off decision belongs to no input");
  assert.deepEqual(model.nodeIdsFor(handoffRun[4]), ["destination:log-triage"]);
  assert.deepEqual(model.nodeIdsFor(handoffRun[3]), ["destination:log-triage"], "not merged with issue-summary");
});

test("events from older runtimes map onto configured ids", () => {
  const legacy = [
    // No destinationId, but the plugin+name pair is unique: ops-room.
    event("brainstem.destination.running", { plugin: "@brainstem/matrix", destination: "room" }, 15),
    // A handoff recorded as input "destination:log-triage".
    event("brainstem.core.decision", { observationId: "agentos:log-triage:x", inputId: "destination:log-triage" }, 16),
    // Ambiguous pair (two agentos-runner entries): kept apart under its plugin key.
    event("brainstem.destination.running", { plugin: "@brainstem/agentos-runner", destination: "default" }, 17)
  ];
  const model = buildFlowModel({ topology, events: legacy, now: Date.parse(at(18)) });

  assert.deepEqual(model.nodeIdsFor(legacy[0]), ["destination:ops-room"]);
  assert.deepEqual(model.nodeIdsFor(legacy[1]), ["core"]);
  assert.equal(node(model, "destination:log-triage").data.handingOff, true, "a legacy handoff shows the same tag");
  assert.ok(!model.nodes.some(candidate => candidate.id === "input:destination:log-triage"));
  assert.deepEqual(model.nodeIdsFor(legacy[2]), ["destination:@brainstem/agentos-runner:default"]);
});

test("without a topology the flow falls back to snapshot and events", () => {
  const snapshot = event("brainstem.snapshot", {
    inputs: [{ id: "test-app-log", plugin: "@brainstem/log-file", input: "lines" }],
    destinations: [
      { id: "log-triage", plugin: "@brainstem/agentos-runner", destination: "default" },
      { plugin: "@brainstem/http-json", destination: "default" }
    ]
  }, 1);
  const model = buildFlowModel({ topology: null, events: [snapshot, ...handoffRun], now: Date.parse(at(25)) });

  assert.equal(model.structure, "events");
  assert.equal(node(model, "core").data.label, "Brainstem Core");
  assert.ok(node(model, "destination:log-triage"));
  assert.ok(node(model, "destination:@brainstem/http-json:default"), "a snapshot destination without id keeps its plugin key");
  assert.ok(node(model, "destination:ops-room"), "destinations seen only in events are added");
  assert.equal(node(model, "destination:log-triage").data.handingOff, true);
  assert.ok(!model.nodes.some(candidate => candidate.id.startsWith("input:destination")));
});

test("the polling core is shown on inputs once there are several cores", () => {
  const model = buildFlowModel({ topology, events: handoffRun, now: NOW });
  assert.equal(node(model, "input:test-app-log").data.footnote, "polled by core-a");

  const single = buildFlowModel({ topology: { ...topology, cores: [topology.cores[0]] }, events: handoffRun, now: NOW });
  assert.equal(node(single, "input:test-app-log").data.footnote, null);
});

test("a malformed event does not break the model", () => {
  const model = buildFlowModel({ topology, events: [null, { kind: 42 }, ...handoffRun], now: NOW });
  assert.equal(model.nodes.length, 5);
});
