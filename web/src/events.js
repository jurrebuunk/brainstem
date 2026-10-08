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

export function eventLabel(event) {
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
    else if (payload.plugin && payload.message?.startsWith?.("destination")) {
      ids.push(`destination:${payload.plugin}`);
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
  const activity = new Map();

  for (const event of events) {
    const timestamp = eventTimestamp(event);

    if (event.kind === "brainstem.log") {
      const payload = event.payload;

      if (payload.id) {
        inputs.set(payload.id, {
          id: payload.id,
          plugin: payload.plugin,
          input: payload.input
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
        input: input.name
      });

      destinations.set(destinationId, {
        id: destinationId,
        plugin: destination.plugin,
        destination: destination.name
      });
    }

    for (const id of eventNodeIds(event)) {
      activity.set(id, timestamp);
    }
  }

  const inputItems = Array.from(inputs.values());
  const destinationItems = Array.from(destinations.values());
  const now = Date.now();

  const nodes = [
    ...inputItems.map((input, index) => node({
      id: `input:${input.id}`,
      type: "input",
      label: input.id,
      subtitle: `${input.plugin}.${input.input}`,
      x: 0,
      y: index * 140,
      active: isActive(activity.get(`input:${input.id}`), now)
    })),
    node({
      id: "core",
      type: "core",
      label: "Brainstem Core",
      subtitle: "decision engine",
      x: 430,
      y: Math.max(0, (Math.max(inputItems.length, destinationItems.length) - 1) * 70),
      active: isActive(activity.get("core"), now)
    }),
    ...destinationItems.map((destination, index) => node({
      id: `destination:${destination.id}`,
      type: "destination",
      label: destination.plugin,
      subtitle: destination.destination,
      x: 860,
      y: index * 140,
      active: isActive(activity.get(`destination:${destination.id}`), now)
    }))
  ];

  const edges = [
    ...inputItems.map(input => ({
      id: `edge-input-${input.id}`,
      source: `input:${input.id}`,
      target: "core",
      animated: isActive(activity.get(`input:${input.id}`), now)
    })),
    ...destinationItems.map(destination => ({
      id: `edge-destination-${destination.id}`,
      source: "core",
      target: `destination:${destination.id}`,
      animated: isActive(activity.get(`destination:${destination.id}`), now)
    }))
  ];

  return { nodes, edges };
}

function node({ id, type, label, subtitle, x, y, active }) {
  return {
    id,
    position: { x, y },
    data: { label, subtitle, type, active },
    className: `node node-${type}${active ? " node-active" : ""}`
  };
}

function isActive(timestamp, now) {
  if (!timestamp) {
    return false;
  }

  return now - Date.parse(timestamp) < 5000;
}
