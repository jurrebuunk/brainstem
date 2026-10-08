import { createHash } from "node:crypto";

export function shouldEmitCertificateObservation({
  target,
  result,
  previous,
  now = Date.now()
}) {
  const fingerprint =
    fingerprintCertificateResult(result);

  const changed =
    previous?.fingerprint !== fingerprint;

  const emitHealthy =
    result.state === "valid" &&
    target.emitHealthy !== false;

  const actionable =
    result.state !== "valid";

  const repeat =
    !changed &&
    actionable &&
    repeatDue(target, previous, now);

  const emit =
    changed
      ? actionable || emitHealthy
      : repeat;

  return {
    emit,
    fingerprint,
    next: {
      fingerprint,
      state: result.state,
      lastCheckedAt: new Date(now).toISOString(),
      lastEmittedAt:
        emit
          ? new Date(now).toISOString()
          : previous?.lastEmittedAt ?? null
    }
  };
}

export function fingerprintCertificateResult(result) {
  return hashStable({
    state: result.state,
    ok: result.ok,
    error: result.error,
    authorized: result.authorized,
    authorizationError: result.authorizationError,
    validTo: result.validTo,
    fingerprint256: result.fingerprint256,
    subject: result.subject,
    issuer: result.issuer
  });
}

function repeatDue(target, previous, now) {
  if (target.repeatAfterMs === null) {
    return false;
  }

  if (!previous?.lastEmittedAt) {
    return true;
  }

  return (
    now - Date.parse(previous.lastEmittedAt) >=
    target.repeatAfterMs
  );
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
