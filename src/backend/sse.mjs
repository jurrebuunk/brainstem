import { responseHeaders } from "./http-utils.mjs";

const RECENT_EVENTS = 1_000;
const SENT_IDS = 5_000;

/*
 * Server-sent events for the Web UI (roadmap 4.7).
 *
 * Telemetry is persisted first, then announced by id on the
 * notifier ("events" topic). Every API replica listens and streams
 * the events to its own clients, so a client sees all telemetry
 * whichever replica it is connected to; on Postgres that is
 * LISTEN/NOTIFY with ids only (well below the payload limit).
 *
 * Each persisted event is sent with `id: <row id>`, so a reconnecting
 * EventSource resumes from its Last-Event-ID on any replica: no
 * sticky sessions. Events that could not be persisted are still
 * streamed by the replica that received them, without an id.
 *
 *   store     { getEventsByIds(ids), getEventsAfterId(id, limit) }
 *   notifier  src/db/notifier.mjs (optional; local-only without)
 */
export function createSseHub({ store = null, notifier = null, replayLimit = 2_000, logger = console } = {}) {
  const clients = new Set();
  const recent = new Map();
  const sent = new Set();
  let lastId = 0;
  let closed = false;

  const unlisten = [
    notifier?.listen("events", ids => deliver(Array.isArray(ids) ? ids : [ids])),
    // Messages may have been missed while the listener was down.
    notifier?.listen("$reconnect", () => catchUp())
  ].filter(Boolean);

  function remember(event) {
    recent.set(event.persistedId, event);
    if (recent.size > RECENT_EVENTS) recent.delete(recent.keys().next().value);
  }

  async function deliver(ids) {
    try {
      const wanted = ids.map(Number).filter(id => Number.isSafeInteger(id) && !sent.has(id));
      const missing = wanted.filter(id => !recent.has(id));

      if (missing.length > 0 && store) {
        for (const event of await store.getEventsByIds(missing)) remember(event);
      }

      const events = wanted
        .map(id => recent.get(id))
        .filter(Boolean)
        .sort((a, b) => a.persistedId - b.persistedId);

      for (const event of events) send(event);
    }
    catch (error) {
      logger.error?.("failed to stream telemetry events", error);
    }
  }

  async function catchUp() {
    if (!store || lastId === 0) return;

    try {
      for (const event of await store.getEventsAfterId(lastId, replayLimit)) {
        remember(event);
        send(event);
      }
    }
    catch (error) {
      logger.error?.("failed to catch up telemetry events", error);
    }
  }

  function send(event) {
    const id = event.persistedId;

    if (id !== undefined) {
      if (sent.has(id)) return;

      sent.add(id);
      if (sent.size > SENT_IDS) sent.delete(sent.values().next().value);
      lastId = Math.max(lastId, id);
    }

    for (const client of clients) {
      if (client.buffer) client.buffer.push(event);
      else write(client, event);
    }
  }

  function write(client, event) {
    const id = event.persistedId;

    if (id !== undefined) {
      if (client.seen.has(id)) return;
      client.seen.add(id);
      if (client.seen.size > SENT_IDS) client.seen.delete(client.seen.values().next().value);
    }

    client.response.write(`${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`);
  }

  return {
    get size() {
      return clients.size;
    },

    /*
     * Start a stream. With a Last-Event-ID header (or ?lastEventId=)
     * the events after it are replayed first; live events arriving
     * meanwhile are buffered and sent after the replay.
     */
    async stream(request, response, { lastEventId = parseLastEventId(request) } = {}) {
      response.writeHead(200, responseHeaders({
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      }));

      response.write(`retry: 3000\n\n`);
      response.write(`data: ${JSON.stringify({
        version: "1",
        kind: "web.connected",
        payload: {
          timestamp: new Date().toISOString(),
          resumedFrom: lastEventId
        }
      })}\n\n`);

      const replay = lastEventId !== null && store !== null;
      const client = { response, seen: new Set(), buffer: replay ? [] : null };

      clients.add(client);
      response.on("close", () => clients.delete(client));

      if (!replay) return;

      try {
        for (const event of await store.getEventsAfterId(lastEventId, replayLimit)) {
          write(client, event);
        }
      }
      catch (error) {
        logger.error?.("failed to replay telemetry events", error);
      }

      const buffered = client.buffer;
      client.buffer = null;
      for (const event of buffered) write(client, event);
    },

    /*
     * Announce an event this replica received. Persisted events
     * (with persistedId) reach every replica's clients; others only
     * this replica's.
     */
    publish(event) {
      if (closed) return;

      if (event.persistedId === undefined) {
        send(event);
        return;
      }

      remember(event);

      if (notifier) notifier.notify("events", [event.persistedId]);
      else deliver([event.persistedId]);
    },

    // Compatibility: stream to this replica's clients only.
    broadcast(event) {
      send(event);
    },

    /*
     * End every stream (drain): clients reconnect, through the load
     * balancer, to a replica that is still ready.
     */
    closeAll() {
      for (const client of clients) client.response.end();
      clients.clear();
    },

    close() {
      closed = true;
      for (const stop of unlisten) stop();
      this.closeAll();
    }
  };
}

function parseLastEventId(request) {
  const header = request?.headers?.["last-event-id"];
  let value = Array.isArray(header) ? header[0] : header;

  if (value === undefined && request?.url) {
    value = new URL(request.url, "http://localhost").searchParams.get("lastEventId") ?? undefined;
  }

  if (value === undefined || value === "") return null;

  const id = Number(value);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}
