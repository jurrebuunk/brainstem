export function formatMessage(ctx, event) {
  if (typeof ctx.config.template === "function") {
    return ctx.config.template(event);
  }

  const decision =
    event.decision.payload;

  const observation =
    event.observation.payload;

  const lines = [
    `Brainstem ${decision.decision}: ${observation.title}`,
    `Observation: ${observation.id}`,
    `Route: ${decision.route ?? "none"}`,
    `Source: ${observation.source.type}/${observation.source.name}`,
    `Type: ${observation.type}`,
    `State: ${observation.state}`,
    `Reason: ${decision.reason ?? "none"}`
  ];

  if (observation.data?.url) {
    lines.push(
      `URL: ${observation.data.url}`
    );
  }

  return lines.join("\n");
}
