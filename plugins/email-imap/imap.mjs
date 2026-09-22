import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

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
          messages.push(
            await normalizeMessage(message, config)
          );
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

export async function normalizeMessage(message, config) {
  const envelope = message.envelope ?? {};
  const source = message.source ?? Buffer.from("");
  const parsed = await simpleParser(source);

  return {
    uid: message.uid,
    messageId:
      parsed.messageId ??
      envelope.messageId ??
      null,
    subject:
      parsed.subject ??
      envelope.subject ??
      "(no subject)",
    from: formatParsedAddresses(parsed.from?.value, envelope.from),
    to: formatParsedAddresses(parsed.to?.value, envelope.to),
    date:
      parsed.date
        ? parsed.date.toISOString()
        : envelope.date
          ? new Date(envelope.date).toISOString()
          : null,
    flags: Array.from(message.flags ?? []),
    snippet: snippetFromParsed(parsed, config.maxBytes)
  };
}

function formatParsedAddresses(parsedAddresses, fallbackAddresses = []) {
  const addresses =
    parsedAddresses?.length
      ? parsedAddresses
      : fallbackAddresses;

  return addresses.map(address => ({
    name: address.name ?? null,
    address: address.address ?? null
  }));
}

export function snippetFromParsed(parsed, maxBytes) {
  const text =
    parsed.text ??
    stripHtml(parsed.html ?? "") ??
    "";

  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxBytes);
}

function stripHtml(html) {
  if (!html) {
    return "";
  }

  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
