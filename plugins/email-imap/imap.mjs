import { ImapFlow } from "imapflow";

export async function fetchNewMessages(config, checkpoint = {}) {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.password
    },
    logger: false,
    connectionTimeout: config.timeoutMs,
    greetingTimeout: config.timeoutMs,
    socketTimeout: config.timeoutMs
  });

  await client.connect();

  try {
    const lock = await client.getMailboxLock(config.mailbox);

    try {
      const status = await client.status(config.mailbox, {
        uidNext: true,
        uidValidity: true
      });

      const uidValidity = String(status.uidValidity ?? "");
      const uidNext = Number(status.uidNext ?? 1);
      const currentLastUid = Math.max(0, uidNext - 1);

      if (
        checkpoint.uidValidity &&
        checkpoint.uidValidity !== uidValidity
      ) {
        checkpoint = {};
      }

      if (checkpoint.lastUid == null && config.startFromNow) {
        return {
          messages: [],
          checkpoint: {
            uidValidity,
            lastUid: currentLastUid
          }
        };
      }

      const lastUid = Number(checkpoint.lastUid ?? 0);

      if (currentLastUid <= lastUid) {
        return {
          messages: [],
          checkpoint: {
            uidValidity,
            lastUid
          }
        };
      }

      const range = `${lastUid + 1}:*`;
      const messages = [];
      let newestUid = lastUid;

      for await (const message of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          source: true,
          flags: true
        },
        {
          uid: true
        }
      )) {
        newestUid = Math.max(newestUid, message.uid);

        if (messages.length < config.maxMessages) {
          messages.push(normalizeMessage(message, config));
        }
      }

      return {
        messages,
        checkpoint: {
          uidValidity,
          lastUid: newestUid
        }
      };
    }
    finally {
      lock.release();
    }
  }
  finally {
    await client.logout().catch(() => {});
  }
}

function normalizeMessage(message, config) {
  const envelope = message.envelope ?? {};
  const raw = message.source
    ? message.source.toString("utf8")
    : "";

  return {
    uid: message.uid,
    messageId: envelope.messageId ?? null,
    subject: envelope.subject ?? "(no subject)",
    from: formatAddresses(envelope.from),
    to: formatAddresses(envelope.to),
    date: envelope.date
      ? new Date(envelope.date).toISOString()
      : null,
    flags: Array.from(message.flags ?? []),
    snippet: snippetFromRaw(raw, config.maxBytes)
  };
}

function formatAddresses(addresses = []) {
  return addresses.map(address => ({
    name: address.name ?? null,
    address: address.address ?? null
  }));
}

function snippetFromRaw(raw, maxBytes) {
  return raw
    .replace(/\r/g, "")
    .split("\n")
    .filter(line => !line.includes(":"))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxBytes);
}
