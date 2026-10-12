import { eventId, eventLevel, eventTimestamp } from "../events.js";


export function inspectorMode(node) {
  if (node.id === "core") {
    return {
      label: "Core I/O",
      listLabel: "Decisions",
      listHint: "Each item shows the observation entering the core and the decision envelope leaving it."
    };
  }

  if (node.id.startsWith("destination:")) {
    return {
      label: "Destination I/O",
      listLabel: "Received envelopes",
      listHint: "Select a delivered decision to see the input envelope and destination-scoped activity."
    };
  }

  return {
    label: "Input polling",
    listLabel: "Polls",
    listHint: "Select a poll to inspect plugin activity and emitted observation envelopes."
  };
}

export function buildInspectorRecords(node, items) {
  if (node.id === "core") return buildCoreRecords(items);
  if (node.id.startsWith("destination:")) return buildDestinationRecords(node, items);
  if (node.id.startsWith("input:")) return buildInputRecords(node, items);
  return [];
}

function buildCoreRecords(items) {
  return items
    .filter(({ event }) => event.kind === "brainstem.core.decision")
    .map(item => {
      const payload = item.event.payload ?? {};
      const observationId = payload.observationId ?? payload.observation?.payload?.id;
      const decision = payload.decision?.payload?.decision ?? payload.decision ?? "unknown";
      const related = relatedByObservationOrPoll(items, {
        observationId,
        pollId: payload.pollId,
        includeKinds: new Set(["brainstem.input.observation", "brainstem.core.decision", "brainstem.output"])
      });

      return {
        id: eventId(item.event, item.index),
        timestamp: eventTimestamp(item.event),
        title: observationId ? `Observation ${observationId}` : "Core decision",
        subtitle: `${payload.source ?? payload.observation?.payload?.source?.type ?? "source"} · ${payload.type ?? payload.observation?.payload?.type ?? "observation"} → ${decision}`,
        badge: decision,
        status: decision === "ignore" ? "event" : "output",
        count: related.length,
        leftTitle: "Input envelope",
        leftSubtitle: "Observation received by Brainstem Core",
        leftBlocks: [
          { type: "summary", items: compactSummaryItems([
            ["Observation", observationId],
            ["Poll", payload.pollId],
            ["Input", payload.inputId]
          ]) },
          { type: "json", title: "observation", value: payload.observation ?? findObservationEnvelope(items, observationId) }
        ],
        rightTitle: "Output envelope",
        rightSubtitle: "Decision emitted by the core",
        rightBlocks: [
          { type: "summary", items: compactSummaryItems([
            ["Decision", decision],
            ["Route", payload.route ?? payload.decision?.payload?.route],
            ["State", payload.state]
          ]) },
          { type: "json", title: "decision", value: payload.decision ?? item.event },
          { type: "timeline", title: "Related I/O", items: related }
        ]
      };
    })
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

function buildDestinationRecords(node, items) {
  const destinationKey = node.id.slice("destination:".length);
  const records = new Map();
  const relevant = items.filter(item => {
    return destinationMatches(item.event, destinationKey) && (
      item.event.kind.startsWith("brainstem.destination.") ||
      item.event.kind === "brainstem.output"
    );
  });

  for (const item of relevant) {
    const payload = item.event.payload ?? {};
    const observationId = observationIdForEvent(item.event);
    const pollId = pollIdForEvent(item.event);
    const key = observationId ?? pollId ?? eventId(item.event, item.index);
    const current = records.get(key) ?? {
      id: `destination-${destinationKey}-${key}`,
      destinationKey,
      observationId,
      pollId,
      events: [],
      output: null,
      inputEnvelope: null,
      latestAt: eventTimestamp(item.event),
      status: "event"
    };

    current.events.push(item);
    current.latestAt = latestTimestamp(current.latestAt, eventTimestamp(item.event));
    current.status = destinationStatus(current.status, item.event);
    current.output = item.event.kind === "brainstem.output" ? item.event : current.output;
    current.inputEnvelope = current.inputEnvelope ?? destinationInputEnvelope(payload, item.event);
    records.set(key, current);
  }

  return [...records.values()].map(record => {
    const activity = items.filter(item => destinationMatches(item.event, record.destinationKey) && sameRun(item.event, record));
    const titleId = record.observationId ?? record.pollId ?? "delivery";

    return {
      id: record.id,
      timestamp: record.latestAt,
      title: `Received ${titleId}`,
      subtitle: `${node.data.label}.${node.data.subtitle ?? "default"}`,
      badge: record.status,
      status: record.status,
      count: activity.length,
      leftTitle: "Input envelope",
      leftSubtitle: "Decision and observation delivered to this destination",
      leftBlocks: [
        { type: "summary", items: compactSummaryItems([
          ["Observation", record.observationId],
          ["Poll", record.pollId],
          ["Destination", record.destinationKey]
        ]) },
        { type: "json", title: "received", value: record.inputEnvelope }
      ],
      rightTitle: "Destination activity",
      rightSubtitle: "Logs and output tied to the selected received envelope",
      rightBlocks: [
        { type: "timeline", title: "Scoped activity", items: activity, empty: "No destination logs matched this envelope." },
        { type: "json", title: "output envelope", value: record.output }
      ]
    };
  }).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

function buildInputRecords(node, items) {
  const inputId = node.id.slice("input:".length);
  const pollEvents = items.filter(({ event }) => inputEventMatches(event, inputId));
  const records = new Map();

  for (const item of pollEvents) {
    const pollId = pollIdForEvent(item.event);
    if (!pollId) continue;
    const current = records.get(pollId) ?? {
      id: `poll-${inputId}-${pollId}`,
      pollId,
      inputId,
      events: [],
      observations: [],
      startedAt: null,
      completedAt: null,
      latestAt: eventTimestamp(item.event),
      status: "running"
    };

    current.events.push(item);
    current.latestAt = latestTimestamp(current.latestAt, eventTimestamp(item.event));
    if (item.event.kind === "brainstem.input.poll.started") current.startedAt = eventTimestamp(item.event);
    if (item.event.kind === "brainstem.input.poll.completed") {
      current.completedAt = eventTimestamp(item.event);
      current.status = "output";
    }
    if (item.event.kind === "brainstem.input.observation") current.observations.push(item.event.payload?.observation ?? item.event);
    records.set(pollId, current);
  }

  const inputLogs = items.filter(({ event }) => inputLogMatches(event, inputId));
  for (const item of inputLogs) {
    const pollId = pollIdForEvent(item.event) ?? findPollForTimestamp([...records.values()], eventTimestamp(item.event));
    if (!pollId || !records.has(pollId)) continue;
    const record = records.get(pollId);
    record.events.push(item);
    record.latestAt = latestTimestamp(record.latestAt, eventTimestamp(item.event));
    if (eventLevel(item.event) === "error") record.status = "error";
  }

  return [...records.values()].map(record => {
    const sortedActivity = [...record.events].sort((a, b) => Date.parse(eventTimestamp(a.event)) - Date.parse(eventTimestamp(b.event)));

    return {
      id: record.id,
      timestamp: record.startedAt ?? record.latestAt,
      title: `Poll ${record.inputId}`,
      subtitle: `${record.observations.length} observation${record.observations.length === 1 ? "" : "s"} emitted`,
      badge: record.status === "output" ? "completed" : record.status,
      status: record.status,
      count: sortedActivity.length,
      leftTitle: "Poll activity",
      leftSubtitle: "Lifecycle and plugin logs for the selected poll",
      leftBlocks: [
        { type: "summary", items: compactSummaryItems([
          ["Input", record.inputId],
          ["Started", record.startedAt ? formatTime(record.startedAt) : null],
          ["Completed", record.completedAt ? formatTime(record.completedAt) : null]
        ]) },
        { type: "timeline", title: "Poll logs", items: sortedActivity }
      ],
      rightTitle: "Output envelopes",
      rightSubtitle: "Observation envelopes emitted by this poll",
      rightBlocks: record.observations.length > 0
        ? record.observations.map((observation, index) => ({ type: "json", title: `observation ${index + 1}`, value: observation }))
        : [{ type: "json", title: "observation", value: null }]
    };
  }).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

function compactSummaryItems(entries) {
  return entries
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([label, value]) => ({ label, value }));
}

function observationIdForEvent(event) {
  const payload = event.payload ?? {};
  return payload.observationId
    ?? payload.observation?.payload?.id
    ?? payload.observationEnvelope?.payload?.id
    ?? payload.fields?.observationId
    ?? payload.fields?.observation_id
    ?? payload.decisionEnvelope?.payload?.observation_id
    ?? payload.decision?.payload?.observation_id;
}

function pollIdForEvent(event) {
  const payload = event.payload ?? {};
  return payload.pollId ?? payload.fields?.pollId ?? payload.fields?.poll_id ?? null;
}

function findObservationEnvelope(items, observationId) {
  if (!observationId) return null;
  return items.find(({ event }) => event.kind === "brainstem.input.observation" && event.payload?.observation?.payload?.id === observationId)?.event.payload?.observation ?? null;
}

function relatedByObservationOrPoll(items, { observationId, pollId, includeKinds }) {
  return items.filter(({ event }) => {
    if (includeKinds && !includeKinds.has(event.kind)) return false;
    const eventObservationId = observationIdForEvent(event);
    const eventPollId = pollIdForEvent(event);
    return Boolean(
      (observationId && eventObservationId === observationId) ||
      (pollId && eventPollId === pollId)
    );
  });
}

function destinationMatches(event, destinationKey) {
  const payload = event.payload ?? {};
  const eventDestination = event.kind === "brainstem.output"
    ? `${payload.destination?.plugin}:${payload.destination?.name}`
    : payload.plugin && payload.destination
      ? `${payload.plugin}:${payload.destination}`
      : null;

  return eventDestination === destinationKey;
}

function destinationInputEnvelope(payload, event) {
  if (event.kind === "brainstem.output") {
    return {
      pollId: payload.pollId ?? null,
      input: payload.input ?? null,
      destination: payload.destination ?? null,
      decision: payload.decision ?? null,
      observation: payload.observation ?? null
    };
  }

  return {
    pollId: payload.pollId ?? null,
    decision: payload.decisionEnvelope ?? payload.decision ?? null,
    observation: payload.observationEnvelope ?? payload.observation ?? null
  };
}

function destinationStatus(current, event) {
  if (event.kind === "brainstem.destination.failed" || eventLevel(event) === "error") return "error";
  if (current === "error") return current;
  if (event.kind === "brainstem.destination.completed" || event.kind === "brainstem.output") return "output";
  if (event.kind === "brainstem.destination.running") return "event";
  return current;
}

function sameRun(event, record) {
  const eventObservationId = observationIdForEvent(event);
  const eventPollId = pollIdForEvent(event);
  return Boolean(
    (record.observationId && eventObservationId === record.observationId) ||
    (record.pollId && eventPollId === record.pollId) ||
    (!record.observationId && !record.pollId && destinationMatches(event, record.destinationKey))
  );
}

function inputEventMatches(event, inputId) {
  const payload = event.payload ?? {};
  return (
    ["brainstem.input.poll.started", "brainstem.input.poll.completed", "brainstem.input.observation"].includes(event.kind) && payload.id === inputId
  );
}

function inputLogMatches(event, inputId) {
  const payload = event.payload ?? {};
  return event.kind === "brainstem.plugin.log" && payload.scope === "input" && payload.id === inputId;
}

function findPollForTimestamp(records, timestamp) {
  const value = Date.parse(timestamp);
  const match = records.find(record => {
    const start = record.startedAt ? Date.parse(record.startedAt) : -Infinity;
    const end = record.completedAt ? Date.parse(record.completedAt) : Date.parse(record.latestAt) + 1000;
    return value >= start && value <= end;
  });

  return match?.pollId ?? null;
}

function latestTimestamp(a, b) {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}
