export function toObservation(ctx, check, result) {
  const state = result.healthy
    ? "healthy"
    : "unhealthy";

  const facts = {};

  if (
    !result.healthy &&
    check.minimumDecisionOnFailure
  ) {
    facts.minimum_decision =
      check.minimumDecisionOnFailure;
  }

  return ctx.observation({
    id: check.id,

    source: {
      type: "http",
      name: check.name
    },

    type: "health_check",
    state,

    title: result.healthy
      ? `${check.name} is healthy`
      : `${check.name} is unhealthy`,

    message: result.healthy
      ? `${check.url} responded with HTTP ${result.status}.`
      : failureMessage(check, result),

    facts,

    data: {
      url: check.url,
      method: check.method,
      status: result.status,
      statusText: result.statusText,
      error: result.error,
      expectedStatuses: check.expectedStatuses
    }
  });
}

function failureMessage(check, result) {
  if (result.status !== null) {
    return `${check.url} responded with HTTP ${result.status}, outside the expected range.`;
  }

  return `${check.url} did not respond successfully: ${result.error}.`;
}
