export function toObservation(ctx, config, message) {
  const from = message.from
    .map(address => address.address ?? address.name)
    .filter(Boolean)
    .join(", ") || "unknown sender";

  return ctx.observation({
    id: `email:${config.user}:${message.uid}`,

    source: {
      type: "email",
      name: config.user
    },

    type: "message",
    state: "new",

    title: message.subject,

    message:
      `From: ${from}\n` +
      `Subject: ${message.subject}\n\n` +
      (message.snippet || "No text snippet available."),

    data: {
      uid: message.uid,
      messageId: message.messageId,
      from: message.from,
      to: message.to,
      date: message.date,
      flags: message.flags
    }
  });
}
