import {
  eventCoreId,
  eventDestinationId,
  eventOrigin,
  eventTimestamp
} from "../../../src/telemetry/events.mjs";

/*
 * Flow model: what the Flow page draws, as plain data.
 *
 *   buildFlowModel({ topology, events, now }) -> {
 *     nodes, edges,          // React Flow nodes/edges
 *     cores,                 // registered cores (from /api/topology)
 *     structure,             // "topology" | "events": where the nodes came from
 *     consistent,            // false when running cores loaded different configs
 *     nodeIdsFor(event)      // node ids an event belongs to (inspector, filters)
 *   }
 *
 * Structure comes from GET /api/topology when the backend has it
 * (nodes keyed by configured ids, independent of which core spoke
 * last). Against an older backend it falls back to the latest
 * snapshot plus the ids seen in events. Activity always comes
 * from the event stream. No React here, so it is unit tested.
 */
const FLOW_COLUMN_GAP = 420;
const FLOW_ROW_GAP = 205;
const FLOW_CORE_X = FLOW_COLUMN_GAP;
const FLOW_DESTINATION_X = FLOW_COLUMN_GAP * 2;
const ACTIVE_FOR_MS = 30_000;
// A handoff is shown briefly while it happens, then disappears.
export const HANDOFF_VISIBLE_MS = 8_000;

const COLORS = {
  input: "#3b82f6",
  destination: "#22c55e",
  handoff: "#ec4899",
  idle: "#4b5563"
};

// Destination nodes and handoff pills have the same fixed size
// in the graph, so their connection dots (at 50% height) line up
// without measuring anything.
const NODE_WIDTH = 260;
export const DESTINATION_NODE_HEIGHT = 160;
const HANDOFF_PILL_X = FLOW_DESTINATION_X + NODE_WIDTH + 90;

export function buildFlowModel({ topology = null, events = [], now = Date.now() } = {}) {
  const structure = collectStructure(topology, events);
  const resolve = createResolver(structure);
  const nodeIdsFor = event => eventNodeIds(event, resolve);

  const nodeActivity = new Map();
  const edgeActivity = new Map();
  const nodeStatus = new Map();
  const stats = new Map();
  const handoffs = new Map();
  const inputCores = new Map();

  for (const event of events) {
    try {
      const timestamp = eventTimestamp(event);
      const activityAt = activityTimestamp(event);

      for (const id of nodeIdsFor(event)) {
        touch(stats, id, event, timestamp);
        nodeActivity.set(id, activityAt);
      }

      collectActivity(event, activityAt, { resolve, edgeActivity, nodeStatus, handoffs, inputCores });
    }
    catch {
      // One malformed event must not blank the flow view.
    }
  }

  // Legacy events may name destinations the structure lacks.
  for (const id of handoffs.keys()) {
    if (!structure.destinations.has(id)) {
      structure.destinations.set(id, { id, plugin: null, destination: null });
    }
  }

  // Handoffs happening right now: shown for HANDOFF_VISIBLE_MS.
  const liveHandoffs = new Map(
    [...handoffs].filter(([, handoff]) =>
      handoff.lastAt && now - Date.parse(handoff.lastAt) < HANDOFF_VISIBLE_MS
    )
  );

  const inputs = [...structure.inputs.values()];
  const destinations = [...structure.destinations.values()];
  const cores = topology?.cores ?? [];
  const isActive = timestamp => Boolean(timestamp) && now - Date.parse(timestamp) < ACTIVE_FOR_MS;
  const activeStatus = (id, fallback) => isActive(nodeActivity.get(id)) ? nodeStatus.get(id) ?? fallback : fallback;

  const rows = Math.max(inputs.length, destinations.length, 1);
  const coreHeight = coreHeightForHandles(Math.max(inputs.length, destinations.length));
  const coreY = ((rows - 1) * FLOW_ROW_GAP) / 2 - coreHeight / 2 + 65;

  const inputHandles = inputs.map((input, index) => ({
    id: `in-${safeHandleId(input.id)}`,
    top: handleTop(index, inputs.length, coreHeight),
    active: isActive(edgeActivity.get(inputEdgeId(input.id)))
  }));
  const outputHandles = destinations.map((destination, index) => ({
    id: `out-${safeHandleId(destination.id)}`,
    top: handleTop(index, destinations.length, coreHeight),
    active: isActive(edgeActivity.get(destinationEdgeId(destination.id)))
  }));

  const nodes = [
    ...inputs.map((input, index) => {
      const id = `input:${input.id}`;
      const coreId = inputCores.get(input.id);

      return graphNode({
        id,
        nodeType: "input",
        label: input.id,
        subtitle: [input.plugin ?? input.module, input.input ?? "default"].filter(Boolean).join("."),
        status: activeStatus(id, "idle"),
        meta: compactMeta({
          polls: stats.get(id)?.polls ?? 0,
          outputs: stats.get(id)?.outputs ?? 0,
          last: relativeTime(stats.get(id)?.lastAt, now)
        }),
        footnote: coreId && cores.length > 1 ? `polled by ${coreId}` : null,
        x: 0,
        y: index * FLOW_ROW_GAP,
        active: isActive(nodeActivity.get(id)),
        handleActive: isActive(edgeActivity.get(inputEdgeId(input.id))),
        extra: { inputId: input.id }
      });
    }),
    graphNode({
      id: "core",
      nodeType: "core",
      label: cores.length > 0 ? "Core pool" : "Brainstem Core",
      subtitle: cores.length > 0 ? coreSummary(cores) : "dedupe · laya · policy · route",
      status: coreStatus(cores, activeStatus("core", "idle")),
      meta: compactMeta({
        decisions: stats.get("core")?.decisions ?? 0,
        outputs: stats.get("core")?.outputs ?? 0,
        last: relativeTime(stats.get("core")?.lastAt, now)
      }),
      footnote: topology && topology.consistent === false ? "cores loaded different configs" : null,
      x: FLOW_CORE_X,
      y: coreY,
      active: isActive(nodeActivity.get("core")),
      height: coreHeight,
      inputHandles,
      outputHandles,
      extra: { cores }
    }),
    ...destinations.map((destination, index) => {
      const id = `destination:${destination.id}`;
      const handoff = handoffs.get(destination.id);

      return graphNode({
        id,
        nodeType: "destination",
        label: destination.id,
        subtitle: [destination.plugin, destination.destination].filter(Boolean).join("."),
        status: activeStatus(id, "idle"),
        meta: compactMeta({
          outputs: stats.get(id)?.outputs ?? 0,
          errors: stats.get(id)?.errors ?? 0,
          ...(handoff?.count ? { handoffs: handoff.count } : {}),
          last: handoff?.count ? null : relativeTime(stats.get(id)?.lastAt, now)
        }),
        x: FLOW_DESTINATION_X,
        y: index * FLOW_ROW_GAP,
        nodeHeight: DESTINATION_NODE_HEIGHT,
        active: isActive(nodeActivity.get(id)),
        handleActive: isActive(edgeActivity.get(destinationEdgeId(destination.id))),
        extra: {
          destinationId: destination.id,
          handingOff: liveHandoffs.has(destination.id)
        }
      });
    })
  ];

  /*
   * While a destination hands off, a "handing off" pill node sits
   * to its right, linked by an ordinary edge. Both disappear after
   * HANDOFF_VISIBLE_MS. The core needs no marker: it lights up as
   * for any decision.
   */
  const handoffPills = destinations.flatMap((destination, index) => {
    const handoff = liveHandoffs.get(destination.id);
    if (!handoff) return [];

    const stamp = Date.parse(handoff.lastAt);

    return [{
      node: {
        id: `handoff:${destination.id}:${stamp}`,
        type: "handoffPill",
        position: { x: HANDOFF_PILL_X, y: index * FLOW_ROW_GAP },
        height: DESTINATION_NODE_HEIGHT,
        draggable: false,
        selectable: false,
        data: {
          label: "↩ handing off",
          destinationId: destination.id
        }
      },
      edge: graphEdge({
        id: `edge-handoff-${destination.id}-${stamp}`,
        source: `destination:${destination.id}`,
        sourceHandle: "handoff-out",
        target: `handoff:${destination.id}:${stamp}`,
        targetHandle: "in",
        active: true,
        color: COLORS.handoff
      })
    }];
  });

  nodes.push(...handoffPills.map(pill => pill.node));

  const edges = [
    ...inputs.map(input => graphEdge({
      id: inputEdgeId(input.id),
      source: `input:${input.id}`,
      sourceHandle: "out",
      target: "core",
      targetHandle: `in-${safeHandleId(input.id)}`,
      active: isActive(edgeActivity.get(inputEdgeId(input.id))),
      color: COLORS.input
    })),
    ...destinations.map(destination => graphEdge({
      id: destinationEdgeId(destination.id),
      source: "core",
      sourceHandle: `out-${safeHandleId(destination.id)}`,
      target: `destination:${destination.id}`,
      targetHandle: "in",
      active: isActive(edgeActivity.get(destinationEdgeId(destination.id))),
      color: COLORS.destination
    })),
    ...handoffPills.map(pill => pill.edge)
  ];

  return {
    nodes,
    edges,
    cores,
    structure: structure.source,
    consistent: topology?.consistent ?? true,
    nodeIdsFor
  };
}

/*
 * Node ids an event belongs to. Handoffs belong to the core and
 * to the destination that emitted them, never to an input.
 */
export function eventNodeIds(event, resolve = createResolver(emptyStructure())) {
  const p = event?.payload ?? {};
  const kind = String(event?.kind ?? "");
  const ids = new Set();
  const inputId = resolve.input(event);
  const destination = resolve.destination(event);

  if (inputId) ids.add(`input:${inputId}`);

  if (kind === "brainstem.output") {
    ids.add("core");
    if (destination) ids.add(`destination:${destination}`);
  }

  if (kind === "brainstem.plugin.log") {
    if (p.scope === "destination" && destination) ids.add(`destination:${destination}`);
  }

  if (kind === "brainstem.core.decision" || kind === "brainstem.core.failed") ids.add("core");

  if (kind.startsWith("brainstem.destination.") && destination) {
    ids.add(`destination:${destination}`);
  }

  if (kind === "brainstem.log") {
    if (p.message === "observation decided" || p.observationId) ids.add("core");
    if (destination) ids.add(`destination:${destination}`);
  }

  return [...ids];
}

function collectStructure(topology, events) {
  const structure = emptyStructure();
  const hasTopology = Boolean(
    topology &&
    ((topology.inputs?.length ?? 0) > 0 || (topology.destinations?.length ?? 0) > 0)
  );

  if (hasTopology) {
    structure.source = "topology";
    for (const input of topology.inputs ?? []) structure.inputs.set(input.id, input);
    for (const destination of topology.destinations ?? []) structure.destinations.set(destination.id, destination);
    return structure;
  }

  // Older backend: the latest snapshot, then ids seen in events.
  structure.source = "events";
  const snapshot = [...events].reverse().find(event => event?.kind === "brainstem.snapshot");

  for (const input of snapshot?.payload?.inputs ?? []) structure.inputs.set(input.id, input);
  for (const destination of snapshot?.payload?.destinations ?? []) {
    const id = destination.id ?? `${destination.plugin}:${destination.destination}`;
    structure.destinations.set(id, { ...destination, id });
  }

  const resolve = createResolver(structure);

  for (const event of events) {
    try {
      const p = event?.payload ?? {};
      const inputId = resolve.input(event);

      if (inputId && !structure.inputs.has(inputId)) {
        structure.inputs.set(inputId, {
          id: inputId,
          plugin: p.inputPlugin ?? p.plugin ?? p.input?.plugin ?? null,
          input: p.inputName ?? p.input?.name ?? (typeof p.input === "string" ? p.input : null)
        });
      }

      const destinationId = resolve.destination(event);

      if (destinationId && !structure.destinations.has(destinationId)) {
        const plugin = event.kind === "brainstem.output" ? p.destination?.plugin : p.plugin;
        const name = event.kind === "brainstem.output" ? p.destination?.name : p.destination;
        structure.destinations.set(destinationId, { id: destinationId, plugin: plugin ?? null, destination: name ?? null });
      }
    }
    catch {
      // ignore malformed telemetry
    }
  }

  return structure;
}

/*
 * Maps events to configured ids. Events from runtimes before
 * destination ids were reported only name plugin + destination;
 * those map to the one configured entry with that pair, or to a
 * "plugin:destination" key when the pair is ambiguous or unknown.
 */
function createResolver(structure) {
  const byPluginAndName = new Map();

  for (const destination of structure.destinations.values()) {
    if (!destination.plugin) continue;
    const key = `${destination.plugin}:${destination.destination ?? "default"}`;
    byPluginAndName.set(key, byPluginAndName.has(key) ? null : destination.id);
  }

  return {
    input(event) {
      const origin = eventOrigin(event);
      if (origin?.kind === "destination") return null;

      const p = event?.payload ?? {};
      const kind = String(event?.kind ?? "");

      if (p.scope === "input" && p.id) return p.id;
      if (kind.startsWith("brainstem.input.") && p.id) return p.id;
      if (origin?.kind === "input") return origin.id;
      return null;
    },

    destination(event) {
      const id = eventDestinationId(event);
      if (id) return id;

      const p = event?.payload ?? {};
      const plugin = event?.kind === "brainstem.output" ? p.destination?.plugin : p.plugin;
      const name = event?.kind === "brainstem.output" ? p.destination?.name : p.destination;

      if (!plugin || !name) return null;

      const key = `${plugin}:${name}`;
      return byPluginAndName.get(key) ?? key;
    }
  };
}

function collectActivity(event, timestamp, { resolve, edgeActivity, nodeStatus, handoffs, inputCores }) {
  const p = event.payload ?? {};
  const kind = event.kind;
  const origin = eventOrigin(event);
  const inputId = resolve.input(event);
  const destinationId = resolve.destination(event);

  if (kind === "brainstem.input.poll.started") {
    nodeStatus.set(`input:${p.id}`, "polling");
    if (eventCoreId(event)) inputCores.set(p.id, eventCoreId(event));
  }

  if (kind === "brainstem.input.observation" && inputId) {
    edgeActivity.set(inputEdgeId(inputId), timestamp);
  }

  if (kind === "brainstem.core.decision") {
    nodeStatus.set("core", "deciding");
    if (inputId) edgeActivity.set(inputEdgeId(inputId), timestamp);

    // A decision on a handed-off observation (also how older
    // runtimes, without the emitted event, show a handoff).
    if (origin?.kind === "destination" && origin.id) {
      const current = handoffs.get(origin.id) ?? { count: 0, lastAt: null };
      current.lastAt = latest(current.lastAt, timestamp);
      handoffs.set(origin.id, current);
    }
  }

  if (kind === "brainstem.destination.emitted" && destinationId) {
    const current = handoffs.get(destinationId) ?? { count: 0, lastAt: null };
    current.count += Array.isArray(p.observations) ? p.observations.length : 1;
    current.lastAt = latest(current.lastAt, timestamp);
    handoffs.set(destinationId, current);
  }

  if (kind === "brainstem.destination.running" && destinationId) {
    nodeStatus.set(`destination:${destinationId}`, "running");
    edgeActivity.set(destinationEdgeId(destinationId), timestamp);
  }

  if (kind === "brainstem.destination.failed" && destinationId) {
    nodeStatus.set(`destination:${destinationId}`, p.dead ? "dead" : "retrying");
  }

  if (kind === "brainstem.output") {
    if (inputId) edgeActivity.set(inputEdgeId(inputId), timestamp);
    if (destinationId) {
      edgeActivity.set(destinationEdgeId(destinationId), timestamp);
      nodeStatus.set(`destination:${destinationId}`, "running");
    }
    nodeStatus.set("core", "deciding");
  }
}

function coreSummary(cores) {
  const running = cores.filter(core => core.status === "running").length;
  const lost = cores.filter(core => core.status === "lost").length;
  const parts = [`${cores.length} core${cores.length === 1 ? "" : "s"}`, `${running} running`];
  if (lost > 0) parts.push(`${lost} lost`);
  return parts.join(" · ");
}

function coreStatus(cores, activity) {
  if (cores.length === 0) return activity;
  const running = cores.filter(core => core.status === "running").length;
  if (running === 0) return "offline";
  if (cores.some(core => core.status === "lost")) return "degraded";
  return activity;
}

function emptyStructure() {
  return { source: "events", inputs: new Map(), destinations: new Map() };
}

function graphNode({
  id,
  nodeType,
  label,
  subtitle,
  status,
  meta,
  footnote = null,
  x,
  y,
  active,
  height = null,
  inputHandles = [],
  outputHandles = [],
  handleActive = false,
  nodeHeight = null,
  extra = {}
}) {
  return {
    id,
    type: "brainstemNode",
    position: { x, y },
    ...(nodeHeight ? { width: NODE_WIDTH, height: nodeHeight } : {}),
    data: { label, subtitle, status, meta, footnote, nodeType, active, height, inputHandles, outputHandles, handleActive, ...extra }
  };
}

function graphEdge({ id, source, sourceHandle, target, targetHandle, active, color }) {
  return {
    id,
    source,
    sourceHandle,
    target,
    targetHandle,
    animated: active,
    type: "default",
    className: active ? "edge-active" : "",
    style: { stroke: active ? color : COLORS.idle, strokeWidth: active ? 2.5 : 1.5 }
  };
}

function latest(a, b) {
  if (!a) return b;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function inputEdgeId(id) {
  return `edge-input-${id}`;
}

function destinationEdgeId(id) {
  return `edge-destination-${id}`;
}

function coreHeightForHandles(count) {
  const minHeight = 130;
  const reserved = 76;
  const minGap = 18;
  return Math.max(minHeight, reserved + Math.max(0, count - 1) * minGap);
}

function handleTop(index, count, height) {
  if (count <= 1) return 50;

  const reserved = 76;
  const minGap = 18;
  const maxSpread = Math.max(0, height - reserved);
  const spread = Math.min(maxSpread, (count - 1) * minGap);
  const topPx = height / 2 - spread / 2 + (index * spread) / (count - 1);
  return (topPx / height) * 100;
}

function safeHandleId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function touch(stats, nodeId, event, timestamp) {
  const current = stats.get(nodeId) ?? { polls: 0, decisions: 0, outputs: 0, errors: 0, lastAt: null };
  const payload = event.payload ?? {};

  if (event.kind === "brainstem.log") {
    if (payload.message === "input poll started") current.polls += 1;
    if (payload.message === "observation decided") current.decisions += 1;
    if (payload.level === "error") current.errors += 1;
  }
  if (event.kind === "brainstem.input.poll.started") current.polls += 1;
  if (event.kind === "brainstem.input.observation") current.outputs += 1;
  if (event.kind === "brainstem.core.decision") current.decisions += 1;
  if (event.kind === "brainstem.output") current.outputs += 1;
  if (event.kind === "brainstem.plugin.log" && payload.level === "error") current.errors += 1;
  if (String(event.kind ?? "").includes("failed")) current.errors += 1;
  current.lastAt = timestamp;
  stats.set(nodeId, current);
}

function activityTimestamp(event) {
  // Receive time for live highlights: payload timestamps can describe
  // the observed object and be much older than ingestion.
  return event.receivedAt ?? event.payload?.timestamp ?? new Date().toISOString();
}

function compactMeta(items) {
  return Object.entries(items)
    .filter(([, value]) => value !== null && value !== undefined && value !== "never")
    .map(([label, value]) => ({ label, value }));
}

function relativeTime(timestamp, now) {
  if (!timestamp) return "never";
  const delta = now - Date.parse(timestamp);
  if (delta < 5_000) return "now";
  if (delta < 60_000) return `${Math.round(delta / 1000)}s`;
  if (delta < 60 * 60_000) return `${Math.round(delta / 60_000)}m`;
  return `${Math.round(delta / 3_600_000)}h`;
}
