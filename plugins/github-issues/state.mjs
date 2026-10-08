import { createHash } from "node:crypto";

export function shouldEmitIssueObservation({
  config,
  checkpoint,
  observation
}) {
  const issues = checkpoint?.issues ?? {};
  const previous = issues[observation.payload.data.number];
  const fingerprint = fingerprintIssueObservation(
    observation.payload
  );

  const firstRun = !checkpoint?.issues;

  return {
    emit:
      !(firstRun && config.startFromNow) &&
      previous?.fingerprint !== fingerprint,

    fingerprint
  };
}

export function nextIssueCheckpoint({
  checkpoint,
  observations,
  now = new Date().toISOString()
}) {
  const issues = {
    ...(checkpoint?.issues ?? {})
  };

  for (const observation of observations) {
    const payload = observation.payload;

    issues[payload.data.number] = {
      fingerprint: fingerprintIssueObservation(payload),
      state: payload.state,
      updatedAt: payload.data.updatedAt ?? null,
      lastSeenAt: now
    };
  }

  return {
    issues,
    lastPolledAt: now
  };
}

export function fingerprintIssueObservation(payload) {
  return hashStable({
    source: payload.source,
    type: payload.type,
    state: payload.state,
    title: payload.title,
    message: payload.message,
    facts: payload.facts ?? {},
    data: payload.data ?? {}
  });
}

function hashStable(value) {
  return createHash("sha256")
    .update(stableStringify(value))
    .digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  return (
    "{" +
    Object.keys(value)
      .sort()
      .map(key =>
        `${JSON.stringify(key)}:${stableStringify(value[key])}`
      )
      .join(",") +
    "}"
  );
}
