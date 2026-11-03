import { randomUUID } from "node:crypto";

/*
 * Cross-process notifications (roadmap 4.5, 4.7).
 *
 *   notifier.listen(topic, fn)   fn(data) for every message on the
 *                                topic; returns unsubscribe
 *   notifier.notify(topic, data) deliver to this process at once
 *                                and to every other process sharing
 *                                the database
 *
 * Topics used by Brainstem: "jobs" (new work), "inputs" (input
 * schedule changed), "events" (telemetry rows by id), "config"
 * (active config changed). The special topic "$reconnect" fires
 * after a lost Postgres listener connection is back, so consumers
 * can resync whatever they may have missed.
 *
 * Postgres: one dedicated LISTEN connection per process (it must be
 * a direct connection, not a PgBouncer transaction pool) on the
 * channel "brainstem". Messages carry the schema, so tests and
 * deployments sharing one server in different schemas never see
 * each other's messages, and the sending process id, so a process
 * never handles its own message twice. NOTIFY is sent outside the
 * writing transaction and coalesced per topic, keeping it off the
 * hot path. Payloads stay under the 8000-byte NOTIFY limit; array
 * data is split across messages.
 *
 * SQLite: process-local only. Other processes sharing the file
 * notice changes on their next poll.
 */
export const NOTIFY_CHANNEL = "brainstem";

const MAX_PAYLOAD_BYTES = 7_500;
const COALESCE_MS = 15;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;
// A partitioned LISTEN connection never errors by itself: ping it.
const PING_INTERVAL_MS = 15_000;
const PING_TIMEOUT_MS = 5_000;

export function createNotifier({ dialect, url, schema = null, logger = null, pingIntervalMs = PING_INTERVAL_MS } = {}) {
  if (dialect === "postgres" && url) {
    return new PostgresNotifier({ url, schema, logger, pingIntervalMs });
  }

  return new LocalNotifier();
}

class LocalNotifier {
  constructor() {
    this.topics = new Map();
  }

  get distributed() {
    return false;
  }

  listen(topic, listener) {
    let listeners = this.topics.get(topic);

    if (!listeners) {
      listeners = new Set();
      this.topics.set(topic, listeners);
    }

    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  notify(topic, data = null) {
    this.deliver(topic, data);
  }

  // Listeners run asynchronously so a notifying caller never runs
  // consumer code inline.
  deliver(topic, data) {
    for (const listener of this.topics.get(topic) ?? []) {
      queueMicrotask(() => {
        try {
          const result = listener(data);
          result?.catch?.(() => {});
        }
        catch {
          // A failing listener never breaks the notifier.
        }
      });
    }
  }

  async close() {
    this.topics.clear();
  }
}

class PostgresNotifier extends LocalNotifier {
  constructor({ url, schema, logger, pingIntervalMs = PING_INTERVAL_MS }) {
    super();
    this.pingIntervalMs = pingIntervalMs;
    this.pingTimer = null;
    this.url = url;
    this.schema = schema ?? "public";
    this.logger = logger;
    this.origin = randomUUID();
    this.client = null;
    this.connecting = null;
    this.connected = false;
    this.closed = false;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.reconnectTimer = null;
    this.pending = new Map();
    this.flushTimer = null;
    this.sender = null;
  }

  get distributed() {
    return true;
  }

  listen(topic, listener) {
    const unsubscribe = super.listen(topic, listener);
    this.#connect();
    return unsubscribe;
  }

  /*
   * Local listeners now; other processes after a short coalescing
   * window. Array data is merged per topic, other data keeps the
   * last value.
   */
  notify(topic, data = null) {
    this.deliver(topic, data);

    if (this.closed) return;

    const current = this.pending.get(topic);
    this.pending.set(
      topic,
      Array.isArray(data)
        ? [...(Array.isArray(current) ? current : []), ...data]
        : data
    );

    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      this.#flush().catch(error => {
        this.logger?.warn?.("notify failed", { error });
      });
    }, COALESCE_MS);
    this.flushTimer.unref?.();
  }

  /*
   * Wait until pending notifications are sent (tests, shutdown).
   */
  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    await this.#flush();
  }

  async #flush() {
    if (this.pending.size === 0) return;

    const messages = [];

    for (const [topic, data] of this.pending) {
      for (const chunk of chunks(data)) {
        messages.push(JSON.stringify({ s: this.schema, o: this.origin, t: topic, d: chunk }));
      }
    }

    this.pending.clear();

    const sender = await this.#sender();

    for (const message of messages) {
      await sender.query("select pg_notify($1, $2)", [NOTIFY_CHANNEL, message]);
    }
  }

  // A small pool for NOTIFY; the LISTEN client stays dedicated.
  async #sender() {
    if (!this.sender) {
      const { default: pg } = await import("pg");
      this.sender = new pg.Pool({
        connectionString: this.url,
        max: 1,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 10_000,
        query_timeout: 10_000,
        keepAlive: true
      });
      this.sender.on("error", () => {});
    }

    return this.sender;
  }

  #connect() {
    if (this.closed || this.client || this.connecting) return;

    this.connecting = (async () => {
      const { default: pg } = await import("pg");
      const client = new pg.Client({
        connectionString: this.url,
        connectionTimeoutMillis: 10_000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000
      });

      client.on("notification", message => this.#receive(message));
      client.on("error", error => this.#lost(client, error));
      client.on("end", () => this.#lost(client, null));

      await client.connect();
      await client.query(`listen ${NOTIFY_CHANNEL}`);

      if (this.closed) {
        await client.end().catch(() => {});
        return;
      }

      const reconnected = this.hadConnection;
      this.client = client;
      this.connected = true;
      this.hadConnection = true;
      this.reconnectDelay = RECONNECT_MIN_MS;

      this.#startPing(client);

      if (reconnected) this.deliver("$reconnect", null);
    })()
      .catch(error => {
        this.logger?.warn?.("notification listener failed to connect", { error });
        this.#scheduleReconnect();
      })
      .finally(() => {
        this.connecting = null;
      });
  }

  /*
   * A failed or slow ping ends the connection, which reconnects and
   * announces $reconnect so consumers resync what they missed.
   */
  #startPing(client) {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(async () => {
      let timer;
      try {
        await Promise.race([
          client.query("select 1"),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("notification listener ping timed out")), PING_TIMEOUT_MS);
          })
        ]);
      }
      catch (error) {
        this.#lost(client, error);
      }
      finally {
        clearTimeout(timer);
      }
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  #lost(client, error) {
    if (this.client !== client) return;

    clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.client = null;
    this.connected = false;
    client.removeAllListeners("notification");
    client.end().catch(() => {});
    // end() waits for the server, which a partition never answers.
    client.connection?.stream?.destroy?.();

    if (this.closed) return;

    this.logger?.warn?.("notification listener disconnected", { error });
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect();
    }, this.reconnectDelay);
    this.reconnectTimer.unref?.();

    this.reconnectDelay = Math.min(RECONNECT_MAX_MS, this.reconnectDelay * 2);
  }

  #receive(message) {
    let parsed;

    try {
      parsed = JSON.parse(message.payload);
    }
    catch {
      return;
    }

    if (parsed?.s !== this.schema || parsed.o === this.origin) return;

    this.deliver(parsed.t, parsed.d ?? null);
  }

  /*
   * Resolves once the LISTEN connection is up (tests).
   */
  async ready() {
    this.#connect();
    while (!this.connected && !this.closed) {
      await (this.connecting ?? new Promise(resolve => setTimeout(resolve, 20)));
    }
  }

  async close() {
    if (this.closed) return;

    await this.flush().catch(() => {});

    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.reconnectTimer = null;

    await this.connecting;

    const client = this.client;
    this.client = null;
    this.connected = false;

    await client?.end().catch(() => {});
    await this.sender?.end().catch(() => {});
    await super.close();
  }
}

function chunks(data) {
  if (!Array.isArray(data)) return [data];

  const result = [];
  let current = [];
  let size = 2;

  for (const item of data) {
    const itemSize = JSON.stringify(item).length + 1;

    if (current.length > 0 && size + itemSize > MAX_PAYLOAD_BYTES) {
      result.push(current);
      current = [];
      size = 2;
    }

    current.push(item);
    size += itemSize;
  }

  if (current.length > 0 || result.length === 0) result.push(current);

  return result;
}
