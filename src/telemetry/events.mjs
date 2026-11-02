export function eventTimestamp(event) {
  return event?.payload?.timestamp ?? event?.receivedAt ?? new Date().toISOString();
}

export function eventLevel(event) {
  if (event?.kind === "brainstem.log") return event.payload?.level ?? "info";
  if (event?.kind === "brainstem.output") return "output";
  if (event?.kind === "brainstem.plugin.log") return event.payload?.level ?? "info";
  if (String(event?.kind ?? "").includes("failed")) return "error";
  return "event";
}

export function eventObservationId(event) {
  const payload = event?.payload ?? {};
  return payload.observationId
    ?? payload.observation?.payload?.id
    ?? payload.observationEnvelope?.payload?.id
    ?? payload.fields?.observationId
    ?? payload.fields?.observation_id
    ?? payload.decisionEnvelope?.payload?.observation_id
    ?? payload.decision?.payload?.observation_id
    ?? null;
}

export function eventPollId(event) {
  const payload = event?.payload ?? {};
  return payload.pollId ?? payload.fields?.pollId ?? payload.fields?.poll_id ?? null;
}

export function eventInputId(event) {
  const payload = event?.payload ?? {};

  if (payload.scope === "input" && payload.id) return payload.id;
  if (payload.inputId) return payload.inputId;
  if (payload.input?.id) return payload.input.id;
  if (payload.id && String(event?.kind ?? "").startsWith("brainstem.input.")) return payload.id;

  return null;
}

/*
 * Where the event's observation came from:
 *   { kind: "input", id } or { kind: "destination", id, depth, lineage }.
 * Events from runtimes before origins existed: real inputs map to
 * { kind: "input" }; a handoff was recorded as input id
 * "destination:<id>".
 */
export function eventOrigin(event) {
  const payload = event?.payload ?? {};
  const origin = payload.origin ?? payload.decisionEnvelope?.origin ?? null;

  if (origin) return origin;

  const inputId = payload.inputId ?? payload.input?.id ?? null;

  if (typeof inputId === "string" && inputId.startsWith("destination:")) {
    return { kind: "destination", id: inputId.slice("destination:".length) };
  }

  return inputId ? { kind: "input", id: inputId } : null;
}

/*
 * The configured destination entry id (unique per entry, unlike
 * plugin + destination name).
 */
export function eventDestinationId(event) {
  const payload = event?.payload ?? {};

  if (event?.kind === "brainstem.output") return payload.destination?.id ?? null;

  return payload.destinationId ?? null;
}

export function eventCoreId(event) {
  return event?.payload?.coreId ?? null;
}

export function eventDestinationKey(event) {
  const payload = event?.payload ?? {};

  if (event?.kind === "brainstem.output") {
    const plugin = payload.destination?.plugin;
    const destination = payload.destination?.name;
    return plugin && destination ? `${plugin}:${destination}` : null;
  }

  return payload.plugin && payload.destination
    ? `${payload.plugin}:${payload.destination}`
    : null;
}

export function eventSourceKey(event) {
  const inputId = eventInputId(event);
  if (inputId) return `input:${inputId}`;

  const destinationKey = eventDestinationKey(event);
  if (destinationKey) return `destination:${destinationKey}`;

  if (event?.kind === "brainstem.core.decision" || event?.kind === "brainstem.core.failed") return "core";

  return null;
}

export function metricsForEvent(event) {
  const kind = event?.kind;
  const payload = event?.payload ?? {};
  const metrics = new Set(["events.total"]);

  if (kind === "brainstem.input.poll.started") metrics.add("polls.started");
  if (kind === "brainstem.input.poll.completed") metrics.add("polls.completed");
  if (kind === "brainstem.input.poll.failed") metrics.add("polls.failed");
  if (kind === "brainstem.input.observation") metrics.add("observations.emitted");
  if (kind === "brainstem.core.decision") {
    metrics.add("decisions.total");
    metrics.add(`decisions.${payload.decision?.payload?.decision ?? payload.decision ?? "unknown"}`);
  }
  if (kind === "brainstem.output") metrics.add("outputs.total");
  if (kind === "brainstem.destination.emitted") metrics.add("handoffs.emitted");
  if (kind === "brainstem.destination.running") metrics.add("destinations.running");
  if (kind === "brainstem.destination.completed") metrics.add("destinations.completed");
  if (kind === "brainstem.destination.failed") {
    metrics.add("destinations.failed");
    if (payload.dead) metrics.add("destinations.dead");
  }
  if (kind === "brainstem.core.failed") {
    metrics.add("decisions.failed");
    if (payload.dead) metrics.add("decisions.dead");
  }
  if (kind === "brainstem.plugin.log" && payload.level === "error") metrics.add("plugin.errors");
  if (kind === "brainstem.log" && payload.level === "error") metrics.add("runtime.errors");
  if (String(kind ?? "").includes("failed") || metrics.has("plugin.errors") || metrics.has("runtime.errors")) metrics.add("errors.total");

  return [...metrics];
}

export const NODE_STAT_FIELDS = ["polls", "observations", "decisions", "delivered", "handoffs", "errors"];

/*
 * Per-node counter increments for one event, keyed by flow node
 * id ("input:<id>", "core", "destination:<id>"). Destinations are
 * counted by configured id, so events from runtimes that did not
 * report destinationId yet are not attributed to a destination.
 *
 *   -> [{ nodeId, field }]   field: one of NODE_STAT_FIELDS, or
 *                            null to only mark the node as seen
 */
export function nodeStatsForEvent(event) {
  const kind = String(event?.kind ?? "");
  const payload = event?.payload ?? {};
  const origin = eventOrigin(event);
  const destinationId = eventDestinationId(event);
  const failed = kind.includes("failed");
  const stats = [];
  const add = (nodeId, field) => {
    if (nodeId) stats.push({ nodeId, field });
  };

  if (kind === "brainstem.input.poll.started") add(`input:${payload.id}`, "polls");
  if (kind === "brainstem.input.poll.completed") add(`input:${payload.id}`, null);
  if (kind === "brainstem.input.poll.failed") add(`input:${payload.id}`, "errors");
  if (kind === "brainstem.input.observation") add(`input:${payload.id}`, "observations");

  if (kind === "brainstem.core.decision") {
    add("core", "decisions");
    if (origin?.kind === "input") add(`input:${origin.id}`, null);
  }
  if (kind === "brainstem.core.failed") add("core", "errors");

  if (kind.startsWith("brainstem.destination.") && kind !== "brainstem.destination.loaded" && destinationId) {
    const nodeId = `destination:${destinationId}`;

    if (kind === "brainstem.destination.completed") add(nodeId, "delivered");
    else if (kind === "brainstem.destination.emitted") add(nodeId, "handoffs");
    else if (failed) add(nodeId, "errors");
    else add(nodeId, null);
  }

  if (kind === "brainstem.plugin.log" && payload.level === "error") {
    if (payload.scope === "input" && payload.id) add(`input:${payload.id}`, "errors");
    if (payload.scope === "destination" && destinationId) add(`destination:${destinationId}`, "errors");
  }

  return stats;
}
