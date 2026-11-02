export { eventLevel, eventTimestamp } from "../../src/telemetry/events.mjs";
// The flow graph itself is built in ./flow/model.js.
export { buildFlowModel, eventNodeIds } from "./flow/model.js";

export function eventId(event, index) {
  return `${event.receivedAt ?? event.payload?.timestamp ?? "event"}-${index}`;
}

export function eventTitle(event) {
  if (event.kind === "brainstem.log") return event.payload?.message ?? "log";
  if (event.kind === "brainstem.output") {
    const decision = event.payload?.decision?.payload ?? {};
    return `${decision.observation_id ?? "observation"} -> ${decision.decision ?? "output"}`;
  }
  return String(event.kind ?? "event").replace(/^brainstem\./, "");
}

export function eventSummary(event) {
  const p = event.payload ?? {};

  if (event.kind === "brainstem.log") return logSummary(p);
  if (event.kind === "brainstem.output") {
    const d = p.decision?.payload ?? {};
    const o = p.observation?.payload ?? {};
    return `${o.source?.type ?? "source"}/${o.type ?? "observation"} ${o.state ?? ""} -> ${d.decision ?? "output"}`;
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
  if (event.kind === "brainstem.core.failed") return `${p.observationId} decision failed${p.dead ? " (dead)" : `; retry ${p.attempt}/${p.attempts}`}`;
  if (event.kind === "brainstem.destination.emitted") {
    const count = Array.isArray(p.observations) ? p.observations.length : 0;
    return `${p.destinationId ?? p.plugin} handed off ${count} observation${count === 1 ? "" : "s"}`;
  }
  if (event.kind === "brainstem.destination.failed") return `${p.plugin}.${p.destination} failed${p.dead ? " (dead)" : `; retry ${p.attempt}/${p.attempts}`}`;
  if (event.kind.startsWith("brainstem.destination.")) return `${p.plugin}.${p.destination} ${p.decision ?? ""}`.trim();

  return event.kind;
}

function logSummary(payload) {
  if (payload.message === "input poll started") return `${payload.id} poll started`;
  if (payload.message === "input poll completed") return `${payload.id} completed (${payload.observations ?? 0} observations)`;
  if (payload.message === "observation decided") return `${payload.observationId} -> ${payload.decision}`;
  if (payload.message?.startsWith("destination")) return `${payload.plugin}.${payload.destination} ${payload.decision ?? ""}`.trim();
  return payload.message;
}
