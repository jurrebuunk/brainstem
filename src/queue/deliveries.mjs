import { errorText } from "./transport.mjs";

/*
 * Delivery log (roadmap §4.4).
 *
 * One row per (decision, destination) emission, keyed by the
 * idempotency key handed to the destination plugin:
 *
 *   pending    queued, not attempted yet (or redriven)
 *   failed     last attempt failed; a retry is scheduled
 *   delivered  the destination accepted it
 *   dead       out of attempts (or a permanent error)
 *   discarded  an operator dropped the dead delivery
 *
 * The deliver stage checks this log before sending, so a job
 * that runs twice (lost ack, reclaimed lease) does not deliver
 * twice once the first run was recorded.
 */
export const DELIVERY_STATUSES = ["pending", "failed", "delivered", "dead", "discarded"];

export const DEFAULT_DELIVERY_PRUNE_AFTER_DAYS = 14;

export class DatabaseDeliveryStore {
  constructor({ database } = {}) {
    if (!database) {
      throw new Error("DatabaseDeliveryStore requires a database handle");
    }

    this.database = database;
    this.handle = null;
  }

  async #db(executor) {
    if (executor) return executor;

    this.handle ??= typeof this.database === "function"
      ? await this.database()
      : await this.database;

    return this.handle.db;
  }

  async create(delivery, { executor } = {}) {
    const db = await this.#db(executor);
    const now = new Date().toISOString();

    await db.insertInto("deliveries")
      .values({
        key: delivery.key,
        observation_id: delivery.observationId,
        revision: Number(delivery.revision ?? 0),
        destination: delivery.destination,
        plugin: delivery.plugin,
        decision: delivery.decision,
        status: "pending",
        attempts: 0,
        last_error: null,
        output_json: JSON.stringify(delivery.output),
        created_at: now,
        updated_at: now,
        delivered_at: null
      })
      .onConflict(conflict => conflict.column("key").doNothing())
      .execute();
  }

  async get(key, { executor } = {}) {
    const db = await this.#db(executor);
    const row = await db.selectFrom("deliveries")
      .selectAll()
      .where("key", "=", key)
      .executeTakeFirst();

    return row ? deliveryFromRow(row) : null;
  }

  async update(key, changes, { executor } = {}) {
    const db = await this.#db(executor);

    await db.updateTable("deliveries")
      .set({
        ...changes,
        updated_at: new Date().toISOString()
      })
      .where("key", "=", key)
      .execute();
  }

  async list({ status, observationId, destination, limit = 100, before } = {}) {
    const db = await this.#db();
    let query = db.selectFrom("deliveries").selectAll();

    if (status) query = query.where("status", "=", status);
    if (observationId) query = query.where("observation_id", "=", observationId);
    if (destination) query = query.where("destination", "=", destination);
    if (before) query = query.where("updated_at", "<", before);

    const rows = await query
      .orderBy("updated_at", "desc")
      .orderBy("key")
      .limit(limit)
      .execute();

    return rows.map(deliveryFromRow);
  }

  async counts() {
    const db = await this.#db();
    const rows = await db.selectFrom("deliveries")
      .select(eb => ["status", eb.fn.countAll().as("count")])
      .groupBy("status")
      .execute();

    return Object.fromEntries(rows.map(row => [row.status, Number(row.count)]));
  }

  /*
   * Finished rows only: dead deliveries stay until an operator
   * redrives or discards them.
   */
  async prune({ olderThan }) {
    const db = await this.#db();
    const result = await db.deleteFrom("deliveries")
      .where("status", "in", ["delivered", "discarded"])
      .where("updated_at", "<", olderThan)
      .executeTakeFirst();

    return Number(result?.numDeletedRows ?? 0);
  }
}

export class MemoryDeliveryStore {
  constructor() {
    this.rows = new Map();
  }

  async create(delivery) {
    if (this.rows.has(delivery.key)) return;

    const now = new Date().toISOString();
    this.rows.set(delivery.key, {
      key: delivery.key,
      observation_id: delivery.observationId,
      revision: Number(delivery.revision ?? 0),
      destination: delivery.destination,
      plugin: delivery.plugin,
      decision: delivery.decision,
      status: "pending",
      attempts: 0,
      last_error: null,
      output_json: JSON.stringify(delivery.output),
      created_at: now,
      updated_at: now,
      delivered_at: null
    });
  }

  async get(key) {
    const row = this.rows.get(key);
    return row ? deliveryFromRow(row) : null;
  }

  async update(key, changes) {
    const row = this.rows.get(key);
    if (!row) return;

    Object.assign(row, changes, { updated_at: new Date().toISOString() });
  }

  async list({ status, observationId, destination, limit = 100, before } = {}) {
    return [...this.rows.values()]
      .filter(row =>
        (!status || row.status === status) &&
        (!observationId || row.observation_id === observationId) &&
        (!destination || row.destination === destination) &&
        (!before || row.updated_at < before)
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.key.localeCompare(b.key))
      .slice(0, limit)
      .map(deliveryFromRow);
  }

  async counts() {
    const counts = {};
    for (const row of this.rows.values()) {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }
    return counts;
  }

  async prune({ olderThan }) {
    let deleted = 0;
    for (const [key, row] of this.rows) {
      if (
        (row.status === "delivered" || row.status === "discarded") &&
        row.updated_at < olderThan
      ) {
        this.rows.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}

/*
 * Status transitions used by the deliver stage and the admin API.
 */
export const deliveryChanges = {
  attempt(attempts) {
    return { attempts };
  },

  delivered(attempts) {
    return {
      status: "delivered",
      attempts,
      last_error: null,
      delivered_at: new Date().toISOString()
    };
  },

  failed({ attempts, error, dead }) {
    return {
      status: dead ? "dead" : "failed",
      attempts,
      last_error: errorText(error)
    };
  },

  redriven() {
    return { status: "pending", attempts: 0 };
  },

  discarded() {
    return { status: "discarded" };
  }
};

export function deliveryFromRow(row) {
  return {
    key: row.key,
    observationId: row.observation_id,
    revision: Number(row.revision),
    destination: row.destination,
    plugin: row.plugin,
    decision: row.decision,
    status: row.status,
    attempts: Number(row.attempts),
    lastError: row.last_error ?? null,
    output: JSON.parse(row.output_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at ?? null
  };
}
