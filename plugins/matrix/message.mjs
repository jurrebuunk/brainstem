export function matrixMessageContent(ctx, event) {
  const body =
    formatMessage(ctx, event);

  const content = {
    msgtype: "m.text",
    body
  };

  if (ctx.config.message?.format === "html") {
    content.format = "org.matrix.custom.html";
    content.formatted_body = toHtml(body);
  }

  if (
    ctx.config.threading !== false &&
    event.notification?.previousEventId
  ) {
    content["m.relates_to"] = {
      rel_type: "m.thread",
      event_id: event.notification.previousEventId,
      is_falling_back: true
    };
  }

  return content;
}

export function formatMessage(ctx, event) {
  if (typeof ctx.config.template === "function") {
    return ctx.config.template(event);
  }

  const decision =
    event.decision.payload;

  const observation =
    event.observation.payload;

  const label =
    event.notification?.kind === "recovery"
      ? "recovery"
      : event.notification?.kind === "repeat"
        ? `${decision.decision} reminder`
        : decision.decision;

  const lines = [
    `Brainstem ${label}: ${observation.title}`,
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

function toHtml(text) {
  return text
    .split("\n")
    .map(escapeHtml)
    .join("<br>");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
