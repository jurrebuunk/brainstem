export function toObservation(ctx, target, result) {
  const facts = {};

  if (
    ["critical", "expired", "invalid", "unreachable"].includes(result.state)
  ) {
    facts.minimum_decision =
      target.minimumDecisionOnCritical;
  }
  else if (result.state === "expiring") {
    facts.minimum_decision =
      target.minimumDecisionOnWarning;
  }

  return ctx.observation({
    id: target.id,

    source: {
      type: "tls",
      name: target.name
    },

    type: "certificate",
    state: result.state,

    title: titleFor(target, result),
    message: messageFor(target, result),

    facts,

    data: {
      host: target.host,
      port: target.port,
      servername: target.servername,
      validTo: result.validTo,
      daysRemaining: result.daysRemaining,
      authorized: result.authorized,
      authorizationError: result.authorizationError,
      fingerprint256: result.fingerprint256,
      subject: result.subject,
      issuer: result.issuer,
      checkedAt: result.checkedAt,
      error: result.error
    }
  });
}

function titleFor(target, result) {
  if (result.state === "valid") {
    return `${target.name} TLS certificate is valid`;
  }

  if (result.state === "expiring") {
    return `${target.name} TLS certificate expires soon`;
  }

  if (result.state === "critical") {
    return `${target.name} TLS certificate is close to expiry`;
  }

  if (result.state === "expired") {
    return `${target.name} TLS certificate has expired`;
  }

  if (result.state === "invalid") {
    return `${target.name} TLS certificate is invalid`;
  }

  return `${target.name} TLS certificate could not be checked`;
}

function messageFor(target, result) {
  if (result.state === "valid") {
    return `${target.host}:${target.port} has a valid TLS certificate expiring in ${result.daysRemaining} day(s).`;
  }

  if (result.daysRemaining !== null) {
    return `${target.host}:${target.port} certificate expires at ${result.validTo} (${result.daysRemaining} day(s) remaining).`;
  }

  return `${target.host}:${target.port} TLS check failed: ${result.error}.`;
}
