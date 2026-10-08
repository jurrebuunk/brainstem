export function eventId(event, index) {
  return `${event.receivedAt ?? event.payload?.timestamp ?? "event"}-${index}`;
}

export function eventTimestamp(event) {
  return event.payload?.timestamp ?? event.receivedAt ?? new Date().toISOString();
}

export function eventTitle(event) {
  if (event.kind === "brainstem.log") return event.payload.message;
  if (event.kind === "brainstem.output") {
    const decision = event.payload.decision.payload;
    return `${decision.observation_id} -> ${decision.decision}`;
  }
  return event.kind.replace(/^brainstem\./, "");
}

export function eventSummary(event) {
  const p = event.payload ?? {};

  if (event.kind === "brainstem.log") return logSummary(p);
  if (event.kind === "brainstem.output") {
    const d = p.decision.payload;
    const o = p.observation.payload;
    return `${o.source.type}/${o.type} ${o.state} -> ${d.decision}`;
  }
  if (event.kind === "brainstem.snapshot") {
    return `${p.inputs?.length ?? 0} inputs, ${p.destinations?.length ?? 0} destinations`;
  }
  if (event.kind === "brainstem.plugin.log") {
    return `${p.scope}:${p.plugin}${p.id ? `/${p.id}` : ""} ${p.message}`;
  }
  if (event.kind === "brainstem.input.poll.started") return `${p.id} poll started`;
  if (event.kind === "brainstem.input.poll.completed") return `${p.id} completed (${p.observations ?? 0} observations)`;
  if (event.kind === "brainstem.input.observation") return `${p.observation?.payload?.id ?? p.id} emitted by ${p.id}`;
  if (event.kind === "brainstem.core.decision") return `${p.observationId} -> ${p.decision?.payload?.decision ?? p.decision}`;
  if (event.kind.startsWith("brainstem.destination.")) return `${p.plugin}.${p.destination} ${p.decision ?? ""}`.trim();

  return event.kind;
}

export function eventLevel(event) {
  if (event.kind === "brainstem.log") return event.payload.level ?? "info";
  if (event.kind === "brainstem.output") return "output";
  if (event.kind === "brainstem.plugin.log") return event.payload.level ?? "info";
  if (event.kind.includes("failed")) return "error";
  return "event";
}

export function eventNodeIds(event) {
  const p = event.payload ?? {};
  const ids = [];

  if (event.kind === "brainstem.log") {
    if (p.id) ids.push(`input:${p.id}`);
    if (p.inputId) ids.push(`input:${p.inputId}`);
    if (p.plugin && p.destination) ids.push(`destination:${p.plugin}:${p.destination}`);
    if (p.message === "observation decided" || p.observationId) ids.push("core");
  }

  if (event.kind === "brainstem.output") {
    ids.push(`input:${p.input.id ?? p.input.plugin}`);
    ids.push("core");
    ids.push(`destination:${p.destination.plugin}:${p.destination.name}`);
  }

  if (event.kind === "brainstem.plugin.log") {
    if (p.scope === "input" && p.id) ids.push(`input:${p.id}`);
    if (p.scope === "destination") ids.push(`destination:${p.plugin}:${p.destination}`);
  }

  if (
    event.kind === "brainstem.input.poll.started" ||
    event.kind === "brainstem.input.poll.completed" ||
    event.kind === "brainstem.input.observation" ||
    event.kind === "brainstem.input.loaded"
  ) {
    ids.push(`input:${p.id}`);
  }

  if (event.kind === "brainstem.core.decision") {
    if (p.inputId) ids.push(`input:${p.inputId}`);
    ids.push("core");
  }

  if (event.kind.startsWith("brainstem.destination.")) {
    ids.push(`destination:${p.plugin}:${p.destination}`);
  }

  return ids;
}

export function buildGraph(events, now = Date.now()) {
  const inputs = new Map();
  const destinations = new Map();
  const nodeActivity = new Map();
  const edgeActivity = new Map();
  const nodeStatus = new Map();
  const stats = new Map();

  const snapshot = latestSnapshot(events);
  for (const input of snapshot?.payload?.inputs ?? []) {
    inputs.set(input.id, input);
  }
  for (const destination of snapshot?.payload?.destinations ?? []) {
    const id = `${destination.plugin}:${destination.destination}`;
    destinations.set(id, { id, ...destination });
  }

  for (const event of events) {
    const timestamp = eventTimestamp(event);
    const nodeIds = eventNodeIds(event);

    for (const id of nodeIds) {
      touch(stats, id, event, timestamp);
      nodeActivity.set(id, timestamp);
    }

    collectTopology(event, inputs, destinations);
    collectActivity(event, timestamp, edgeActivity, nodeStatus);
  }

  const inputItems = Array.from(inputs.values());
  const destinationItems = Array.from(destinations.values());
  const rows = Math.max(inputItems.length, destinationItems.length, 1);

  return {
    nodes: [
      ...inputItems.map((input, index) => graphNode({
        id: `input:${input.id}`,
        nodeType: "input",
        label: input.id,
        subtitle: `${input.plugin ?? input.module}.${input.input ?? "default"}`,
        status: activeStatus(`input:${input.id}`, "idle", nodeStatus, nodeActivity, now),
        meta: compactMeta({
          polls: stats.get(`input:${input.id}`)?.polls ?? 0,
          outputs: stats.get(`input:${input.id}`)?.outputs ?? 0,
          last: relativeTime(stats.get(`input:${input.id}`)?.lastAt)
        }),
        x: 0,
        y: index * 155,
        active: isActive(nodeActivity.get(`input:${input.id}`), now)
      })),
      graphNode({
        id: "core",
        nodeType: "core",
        label: "Brainstem Core",
        subtitle: "dedupe · laya · policy · route",
        status: activeStatus("core", "idle", nodeStatus, nodeActivity, now),
        meta: compactMeta({
          decisions: stats.get("core")?.decisions ?? 0,
          outputs: stats.get("core")?.outputs ?? 0,
          last: relativeTime(stats.get("core")?.lastAt)
        }),
        x: 455,
        y: (rows - 1) * 77.5,
        active: isActive(nodeActivity.get("core"), now)
      }),
      ...destinationItems.map((destination, index) => graphNode({
        id: `destination:${destination.id}`,
        nodeType: "destination",
        label: destination.plugin,
        subtitle: destination.destination,
        status: activeStatus(`destination:${destination.id}`, "idle", nodeStatus, nodeActivity, now),
        meta: compactMeta({
          outputs: stats.get(`destination:${destination.id}`)?.outputs ?? 0,
          errors: stats.get(`destination:${destination.id}`)?.errors ?? 0,
          last: relativeTime(stats.get(`destination:${destination.id}`)?.lastAt)
        }),
        x: 910,
        y: index * 155,
        active: isActive(nodeActivity.get(`destination:${destination.id}`), now)
      }))
    ],
    edges: [
      ...inputItems.map(input => graphEdge({
        id: `edge-input-${input.id}`,
        source: `input:${input.id}`,
        target: "core",
        active: isActive(edgeActivity.get(`edge-input-${input.id}`), now),
        color: "#3b82f6"
      })),
      ...destinationItems.map(destination => graphEdge({
        id: `edge-destination-${destination.id}`,
        source: "core",
        target: `destination:${destination.id}`,
        active: isActive(edgeActivity.get(`edge-destination-${destination.id}`), now),
        color: "#22c55e"
      }))
    ]
  };
}

function collectTopology(event, inputs, destinations) {
  const p = event.payload ?? {};

  if (event.kind === "brainstem.input.loaded") inputs.set(p.id, p);
  if (
    event.kind === "brainstem.input.poll.started" ||
    event.kind === "brainstem.input.poll.completed" ||
    event.kind === "brainstem.input.observation"
  ) {
    inputs.set(p.id, { id: p.id, plugin: p.plugin, input: p.input });
  }
  if (event.kind === "brainstem.core.decision" && p.inputId) {
    inputs.set(p.inputId, { id: p.inputId, plugin: p.inputPlugin, input: p.inputName });
  }
  if (event.kind === "brainstem.plugin.log") {
    if (p.scope === "input" && p.id) {
      inputs.set(p.id, { id: p.id, plugin: p.plugin, input: p.input });
    }
    if (p.scope === "destination") {
      const id = `${p.plugin}:${p.destination}`;
      destinations.set(id, { id, plugin: p.plugin, destination: p.destination });
    }
  }
  if (event.kind.startsWith("brainstem.destination.")) {
    const id = `${p.plugin}:${p.destination}`;
    destinations.set(id, { id, plugin: p.plugin, destination: p.destination });
  }
  if (event.kind === "brainstem.output") {
    const inputId = p.input.id ?? p.input.plugin;
    const destinationId = `${p.destination.plugin}:${p.destination.name}`;
    inputs.set(inputId, { id: inputId, plugin: p.input.plugin, input: p.input.name });
    destinations.set(destinationId, { id: destinationId, plugin: p.destination.plugin, destination: p.destination.name });
  }
  if (event.kind === "brainstem.log") {
    if (p.id) inputs.set(p.id, { id: p.id, plugin: p.plugin, input: p.input });
    if (p.inputId) inputs.set(p.inputId, { id: p.inputId, plugin: p.inputPlugin, input: p.inputName });
    if (p.plugin && p.destination) {
      const id = `${p.plugin}:${p.destination}`;
      destinations.set(id, { id, plugin: p.plugin, destination: p.destination });
    }
  }
}

function collectActivity(event, timestamp, edgeActivity, nodeStatus) {
  const p = event.payload ?? {};

  if (event.kind === "brainstem.input.poll.started") {
    nodeStatus.set(`input:${p.id}`, "polling");
  }
  if (event.kind === "brainstem.input.observation") {
    edgeActivity.set(`edge-input-${p.id}`, timestamp);
  }
  if (event.kind === "brainstem.core.decision") {
    nodeStatus.set("core", "deciding");
    if (p.inputId) edgeActivity.set(`edge-input-${p.inputId}`, timestamp);
  }
  if (event.kind === "brainstem.destination.running") {
    const id = `${p.plugin}:${p.destination}`;
    nodeStatus.set(`destination:${id}`, "running");
    edgeActivity.set(`edge-destination-${id}`, timestamp);
  }
  if (event.kind === "brainstem.output") {
    const inputId = p.input.id ?? p.input.plugin;
    const destinationId = `${p.destination.plugin}:${p.destination.name}`;
    edgeActivity.set(`edge-input-${inputId}`, timestamp);
    edgeActivity.set(`edge-destination-${destinationId}`, timestamp);
    nodeStatus.set("core", "deciding");
    nodeStatus.set(`destination:${destinationId}`, "running");
  }
  if (event.kind === "brainstem.log" && p.message === "observation decided" && p.inputId) {
    edgeActivity.set(`edge-input-${p.inputId}`, timestamp);
  }
}

function graphNode({ id, nodeType, label, subtitle, status, meta, x, y, active }) {
  return { id, type: "brainstemNode", position: { x, y }, data: { label, subtitle, status, meta, nodeType, active } };
}

function graphEdge({ id, source, target, active, color }) {
  return { id, source, target, animated: active, type: "smoothstep", className: active ? "edge-active" : "", style: { stroke: active ? color : "#4b5563", strokeWidth: active ? 2.5 : 1.5 } };
}

function touch(stats, nodeId, event, timestamp) {
  const current = stats.get(nodeId) ?? { polls: 0, decisions: 0, outputs: 0, errors: 0, lastAt: null };
  if (event.kind === "brainstem.log") {
    if (event.payload.message === "input poll started") current.polls += 1;
    if (event.payload.message === "observation decided") current.decisions += 1;
    if (event.payload.level === "error") current.errors += 1;
  }
  if (event.kind === "brainstem.input.poll.started") current.polls += 1;
  if (event.kind === "brainstem.input.observation") current.outputs += 1;
  if (event.kind === "brainstem.core.decision") current.decisions += 1;
  if (event.kind === "brainstem.output") current.outputs += 1;
  if (event.kind === "brainstem.plugin.log" && event.payload.level === "error") current.errors += 1;
  if (event.kind.includes("failed")) current.errors += 1;
  current.lastAt = timestamp;
  stats.set(nodeId, current);
}

function latestSnapshot(events) {
  return events.findLast?.(event => event.kind === "brainstem.snapshot") ?? [...events].reverse().find(event => event.kind === "brainstem.snapshot");
}

function activeStatus(id, fallback, nodeStatus, nodeActivity, now) {
  return isActive(nodeActivity.get(id), now) ? nodeStatus.get(id) ?? fallback : fallback;
}

function logSummary(payload) {
  if (payload.message === "input poll started") return `${payload.id} poll started`;
  if (payload.message === "input poll completed") return `${payload.id} completed (${payload.observations ?? 0} observations)`;
  if (payload.message === "observation decided") return `${payload.observationId} -> ${payload.decision}`;
  if (payload.message?.startsWith("destination")) return `${payload.plugin}.${payload.destination} ${payload.decision ?? ""}`.trim();
  return payload.message;
}

function compactMeta(items) {
  return Object.entries(items).filter(([, value]) => value !== null && value !== undefined && value !== "never").map(([label, value]) => ({ label, value }));
}

function relativeTime(timestamp) {
  if (!timestamp) return "never";
  const delta = Date.now() - Date.parse(timestamp);
  if (delta < 5_000) return "now";
  if (delta < 60_000) return `${Math.round(delta / 1000)}s`;
  if (delta < 60 * 60_000) return `${Math.round(delta / 60_000)}m`;
  return `${Math.round(delta / 3_600_000)}h`;
}

function isActive(timestamp, now) {
  return timestamp ? now - Date.parse(timestamp) < 15_000 : false;
}
