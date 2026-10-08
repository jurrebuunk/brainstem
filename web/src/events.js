export function eventId(event, index) {
  return `${event.receivedAt ?? event.payload?.timestamp ?? "event"}-${index}`;
}

export function eventTimestamp(event) {
  return (
    event.payload?.timestamp ??
    event.receivedAt ??
    new Date().toISOString()
  );
}

export function eventTitle(event) {
  if (event.kind === "brainstem.log") {
    return event.payload.message;
  }

  if (event.kind === "brainstem.output") {
    const decision = event.payload.decision.payload;
    const observation = event.payload.observation.payload;
    return `${observation.id} -> ${decision.decision}`;
  }

  return event.kind;
}

export function eventSummary(event) {
  if (event.kind === "brainstem.log") {
    const payload = event.payload;

    if (payload.message === "input poll started") {
      return `${payload.id} poll started`;
    }

    if (payload.message === "input poll completed") {
      return `${payload.id} completed (${payload.observations ?? 0} observations)`;
    }

    if (payload.message === "observation decided") {
      return `${payload.observationId} -> ${payload.decision}`;
    }

    if (payload.message?.startsWith("destination")) {
      return `${payload.plugin}.${payload.destination} ${payload.decision ?? ""}`.trim();
    }

    return payload.message;
  }

  if (event.kind === "brainstem.output") {
    const decision = event.payload.decision.payload;
    const observation = event.payload.observation.payload;
    return `${observation.source.type}/${observation.type} ${observation.state} -> ${decision.decision}`;
  }

  return event.kind;
}

export function eventLevel(event) {
  if (event.kind === "brainstem.log") {
    return event.payload.level ?? "info";
  }

  if (event.kind === "brainstem.output") {
    return "output";
  }

  return "event";
}

export function eventNodeIds(event) {
  const ids = [];

  if (event.kind === "brainstem.log") {
    const payload = event.payload;

    if (payload.id) {
      ids.push(`input:${payload.id}`);
    }

    if (payload.plugin && payload.destination) {
      ids.push(`destination:${payload.plugin}:${payload.destination}`);
    }

    if (
      payload.message === "observation decided" ||
      payload.observationId
    ) {
      ids.push("core");
    }
  }

  if (event.kind === "brainstem.output") {
    ids.push(`input:${event.payload.input.id ?? event.payload.input.plugin}`);
    ids.push("core");
    ids.push(`destination:${event.payload.destination.plugin}:${event.payload.destination.name}`);
  }

  return ids;
}

export function buildGraph(events) {
  const inputs = new Map();
  const destinations = new Map();
  const nodeActivity = new Map();
  const edgeActivity = new Map();
  const stats = new Map();

  for (const event of events) {
    const timestamp = eventTimestamp(event);
    const nodeIds = eventNodeIds(event);

    for (const id of nodeIds) {
      touch(stats, id, event, timestamp);
      nodeActivity.set(id, timestamp);
    }

    if (event.kind === "brainstem.log") {
      const payload = event.payload;

      if (payload.id) {
        inputs.set(payload.id, {
          id: payload.id,
          plugin: payload.plugin,
          input: payload.input,
          intervalMs: payload.intervalMs ?? null
        });
      }

      if (payload.plugin && payload.destination) {
        const id = `${payload.plugin}:${payload.destination}`;
        destinations.set(id, {
          id,
          plugin: payload.plugin,
          destination: payload.destination
        });
      }
    }

    if (event.kind === "brainstem.output") {
      const input = event.payload.input;
      const destination = event.payload.destination;
      const inputId = input.id ?? input.plugin;
      const destinationId = `${destination.plugin}:${destination.name}`;

      inputs.set(inputId, {
        id: inputId,
        plugin: input.plugin,
        input: input.name,
        intervalMs: null
      });

      destinations.set(destinationId, {
        id: destinationId,
        plugin: destination.plugin,
        destination: destination.name
      });

      edgeActivity.set(`edge-input-${inputId}`, timestamp);
      edgeActivity.set(`edge-destination-${destinationId}`, timestamp);
    }
  }

  const inputItems = Array.from(inputs.values());
  const destinationItems = Array.from(destinations.values());
  const rows = Math.max(inputItems.length, destinationItems.length, 1);
  const now = Date.now();

  const nodes = [
    ...inputItems.map((input, index) => graphNode({
      id: `input:${input.id}`,
      nodeType: "input",
      label: input.id,
      subtitle: `${input.plugin}.${input.input}`,
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
      meta: compactMeta({
        outputs: stats.get(`destination:${destination.id}`)?.outputs ?? 0,
        errors: stats.get(`destination:${destination.id}`)?.errors ?? 0,
        last: relativeTime(stats.get(`destination:${destination.id}`)?.lastAt)
      }),
      x: 910,
      y: index * 155,
      active: isActive(nodeActivity.get(`destination:${destination.id}`), now)
    }))
  ];

  const edges = [
    ...inputItems.map(input => edge({
      id: `edge-input-${input.id}`,
      source: `input:${input.id}`,
      target: "core",
      active: isActive(edgeActivity.get(`edge-input-${input.id}`), now),
      color: "#3b82f6"
    })),
    ...destinationItems.map(destination => edge({
      id: `edge-destination-${destination.id}`,
      source: "core",
      target: `destination:${destination.id}`,
      active: isActive(edgeActivity.get(`edge-destination-${destination.id}`), now),
      color: "#22c55e"
    }))
  ];

  return { nodes, edges };
}

function graphNode({ id, nodeType, label, subtitle, meta, x, y, active }) {
  return {
    id,
    type: "brainstemNode",
    position: { x, y },
    data: { label, subtitle, meta, nodeType, active }
  };
}

function edge({ id, source, target, active, color }) {
  return {
    id,
    source,
    target,
    animated: active,
    type: "smoothstep",
    className: active ? "edge-active" : "",
    style: {
      stroke: active ? color : "#4b5563",
      strokeWidth: active ? 2.5 : 1.5
    }
  };
}

function touch(stats, nodeId, event, timestamp) {
  const current = stats.get(nodeId) ?? {
    polls: 0,
    decisions: 0,
    outputs: 0,
    errors: 0,
    lastAt: null
  };

  if (event.kind === "brainstem.log") {
    if (event.payload.message === "input poll started") {
      current.polls += 1;
    }

    if (event.payload.message === "observation decided") {
      current.decisions += 1;
    }

    if (event.payload.level === "error") {
      current.errors += 1;
    }
  }

  if (event.kind === "brainstem.output") {
    current.outputs += 1;
  }

  current.lastAt = timestamp;
  stats.set(nodeId, current);
}

function compactMeta(items) {
  return Object.entries(items)
    .filter(([, value]) => value !== null && value !== undefined && value !== "never")
    .map(([label, value]) => ({ label, value }));
}

function relativeTime(timestamp) {
  if (!timestamp) {
    return "never";
  }

  const delta = Date.now() - Date.parse(timestamp);

  if (delta < 5_000) {
    return "now";
  }

  if (delta < 60_000) {
    return `${Math.round(delta / 1000)}s`;
  }

  if (delta < 60 * 60_000) {
    return `${Math.round(delta / 60_000)}m`;
  }

  return `${Math.round(delta / 3_600_000)}h`;
}

function isActive(timestamp, now) {
  if (!timestamp) {
    return false;
  }

  return now - Date.parse(timestamp) < 5000;
}
