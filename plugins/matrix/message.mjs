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

  const kind =
    event.notification?.kind ?? "alert";

  const compact =
    ctx.config.message?.compact ?? false;

  const lines = compact
    ? compactMessage({ kind, decision, observation })
    : fullMessage({ kind, decision, observation });

  return lines.join("\n");
}

function fullMessage({ kind, decision, observation }) {
  const descriptor =
    descriptorFor(kind, decision.decision);

  const lines = [
    `${descriptor.icon} ${descriptor.title}: ${observation.title}`,
    "",
    descriptor.description,
    "",
    `Decision: ${decision.decision.toUpperCase()}`,
    `Route: ${decision.route ?? "none"}`,
    `State: ${observation.state}`,
    `Source: ${observation.source.type}/${observation.source.name}`,
    `Type: ${observation.type}`,
    `Observation: ${observation.id}`
  ];

  if (decision.reason) {
    lines.push(
      `Reason: ${decision.reason}`
    );
  }

  if (observation.message) {
    lines.push(
      "",
      observation.message
    );
  }

  if (observation.data?.url) {
    lines.push(
      "",
      `URL: ${observation.data.url}`
    );
  }

  if (decision.timestamp) {
    lines.push(
      `Time: ${decision.timestamp}`
    );
  }

  return lines;
}

function compactMessage({ kind, decision, observation }) {
  const descriptor =
    descriptorFor(kind, decision.decision);

  const lines = [
    `${descriptor.icon} ${descriptor.title}: ${observation.title}`,
    `${decision.decision.toUpperCase()} · ${decision.route ?? "no route"} · ${observation.source.type}/${observation.source.name}`
  ];

  if (observation.data?.url) {
    lines.push(
      observation.data.url
    );
  }

  return lines;
}

function descriptorFor(kind, decision) {
  if (kind === "recovery") {
    return {
      icon: "✅",
      title: "Brainstem recovery",
      description:
        "The observation is no longer actionable. The incident appears to have recovered."
    };
  }

  if (kind === "repeat") {
    return {
      icon: "🔁",
      title: "Brainstem reminder",
      description:
        "This issue is still active. Brainstem is repeating the notification because the repeat interval elapsed."
    };
  }

  if (decision === "escalate") {
    return {
      icon: "🧯",
      title: "Brainstem escalation",
      description:
        "This observation may require human attention or intervention."
    };
  }

  if (decision === "dispatch") {
    return {
      icon: "🚨",
      title: "Brainstem alert",
      description:
        "This observation should be investigated now."
    };
  }

  if (decision === "queue") {
    return {
      icon: "📌",
      title: "Brainstem queued work",
      description:
        "This observation looks actionable, but does not require immediate attention."
    };
  }

  return {
    icon: "ℹ️",
    title: "Brainstem notice",
    description:
      "Brainstem recorded this observation."
  };
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
