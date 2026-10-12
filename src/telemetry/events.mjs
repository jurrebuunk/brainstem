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

  if (event?.kind === "brainstem.core.decision") return "core";

  return null;
}

export function metricsForEvent(event) {
  const kind = event?.kind;
  const payload = event?.payload ?? {};
  const metrics = new Set(["events.total"]);

  if (kind === "brainstem.input.poll.started") metrics.add("polls.started");
  if (kind === "brainstem.input.poll.completed") metrics.add("polls.completed");
  if (kind === "brainstem.input.observation") metrics.add("observations.emitted");
  if (kind === "brainstem.core.decision") {
    metrics.add("decisions.total");
    metrics.add(`decisions.${payload.decision?.payload?.decision ?? payload.decision ?? "unknown"}`);
  }
  if (kind === "brainstem.output") metrics.add("outputs.total");
  if (kind === "brainstem.destination.running") metrics.add("destinations.running");
  if (kind === "brainstem.destination.completed") metrics.add("destinations.completed");
  if (kind === "brainstem.destination.failed") metrics.add("destinations.failed");
  if (kind === "brainstem.plugin.log" && payload.level === "error") metrics.add("plugin.errors");
  if (kind === "brainstem.log" && payload.level === "error") metrics.add("runtime.errors");
  if (String(kind ?? "").includes("failed") || metrics.has("plugin.errors") || metrics.has("runtime.errors")) metrics.add("errors.total");

  return [...metrics];
}
