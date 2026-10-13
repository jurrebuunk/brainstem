import { sql } from "kysely";

/*
 * Plugin state stores.
 *
 * Small durable key/value state for plugins (suppression state,
 * cursors, caches), keyed by (namespace, key). Values are JSON.
 *
 * Both stores share one async interface:
 *
 *   get(namespace, key)          -> value | undefined
 *   set(namespace, key, value)   -> value
 *   delete(namespace, key)       -> boolean (whether a value existed)
 *   update(namespace, key, fn)   -> value after the update
 *
 * update() is an atomic read-modify-write: fn(current) receives the
 * current value (undefined when absent) and returns the next value.
 * Returning undefined leaves the stored value unchanged. fn may be
 * called more than once when a concurrent writer wins a race, so it
 * should only compute from its argument.
 */

const MAX_UPDATE_ATTEMPTS = 5;

export class MemoryPluginStateStore {
  #values = new Map();
  #queues = new Map();

  async get(namespace, key) {
    return this.#locked(namespace, key, () => this.#read(namespace, key));
  }

  async set(namespace, key, value) {
    const json = encodeValue(value);

    return this.#locked(namespace, key, () => {
      this.#values.set(storageKey(namespace, key), json);
      return JSON.parse(json);
    });
  }

  async delete(namespace, key) {
    return this.#locked(namespace, key, () =>
      this.#values.delete(storageKey(namespace, key))
    );
  }

  async update(namespace, key, fn) {
    requireFunction(fn);

    return this.#locked(namespace, key, async () => {
      const current = this.#read(namespace, key);
      const next = await fn(current);

      if (next === undefined) {
        return current;
      }

      const json = encodeValue(next);
      this.#values.set(storageKey(namespace, key), json);
      return JSON.parse(json);
    });
  }

  async close() {}

  #read(namespace, key) {
    const json = this.#values.get(storageKey(namespace, key));

    return json === undefined ? undefined : JSON.parse(json);
  }

  async #locked(namespace, key, operation) {
    const id = storageKey(namespace, key);
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);

    this.#queues.set(id, next);

    try {
      return await next;
    }
    finally {
      if (this.#queues.get(id) === next) {
        this.#queues.delete(id);
      }
    }
  }
}

export class DatabasePluginStateStore {
  /*
   * handle: { db, dialect } from openDatabase()/openMigratedDatabase().
   * The store does not own the handle; close the handle yourself.
   */
  constructor(handle) {
    if (!handle?.db || !handle?.dialect) {
      throw new TypeError(
        "DatabasePluginStateStore requires a database handle { db, dialect }"
      );
    }

    this.db = handle.db;
    this.dialect = handle.dialect;
  }

  async get(namespace, key) {
    const row = await selectRow(this.db, namespace, key);

    return row ? JSON.parse(row.value_json) : undefined;
  }

  async set(namespace, key, value) {
    const json = encodeValue(value);

    await upsertRow(this.db, namespace, key, json);
    return JSON.parse(json);
  }

  async delete(namespace, key) {
    const result = await this.db.deleteFrom("plugin_state")
      .where("namespace", "=", namespace)
      .where("key", "=", key)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0) > 0;
  }

  async update(namespace, key, fn) {
    requireFunction(fn);

    return this.dialect === "postgres"
      ? this.#updatePostgres(namespace, key, fn)
      : this.#updateSqlite(namespace, key, fn);
  }

  async close() {}

  /*
   * SQLite: BEGIN IMMEDIATE takes the write lock up front, so a
   * second process waits on busy_timeout instead of failing with
   * SQLITE_BUSY when it upgrades a read lock to a write lock.
   */
  async #updateSqlite(namespace, key, fn) {
    return this.db.connection().execute(async connection => {
      await sql`begin immediate`.execute(connection);

      try {
        const row = await selectRow(connection, namespace, key);
        const current = row ? JSON.parse(row.value_json) : undefined;
        const next = await fn(current);
        let result = current;

        if (next !== undefined) {
          const json = encodeValue(next);
          await upsertRow(connection, namespace, key, json);
          result = JSON.parse(json);
        }

        await sql`commit`.execute(connection);
        return result;
      }
      catch (error) {
        await sql`rollback`.execute(connection).catch(() => {});
        throw error;
      }
    });
  }

  /*
   * Postgres: lock the row with SELECT ... FOR UPDATE. A missing row
   * cannot be locked, so the first write inserts with ON CONFLICT DO
   * NOTHING; if a concurrent transaction inserted first, roll back
   * and retry, which then waits on the now-existing row lock.
   */
  async #updatePostgres(namespace, key, fn) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.db.transaction().execute(async trx => {
          const row = await trx.selectFrom("plugin_state")
            .select("value_json")
            .where("namespace", "=", namespace)
            .where("key", "=", key)
            .forUpdate()
            .executeTakeFirst();

          const current = row ? JSON.parse(row.value_json) : undefined;
          const next = await fn(current);

          if (next === undefined) {
            return current;
          }

          const json = encodeValue(next);
          const updatedAt = new Date().toISOString();

          if (row) {
            await trx.updateTable("plugin_state")
              .set({ value_json: json, updated_at: updatedAt })
              .where("namespace", "=", namespace)
              .where("key", "=", key)
              .execute();
          }
          else {
            const inserted = await trx.insertInto("plugin_state")
              .values({ namespace, key, value_json: json, updated_at: updatedAt })
              .onConflict(oc => oc.columns(["namespace", "key"]).doNothing())
              .returning("key")
              .executeTakeFirst();

            if (!inserted) {
              throw new InsertRaceError();
            }
          }

          return JSON.parse(json);
        });
      }
      catch (error) {
        if (
          error instanceof InsertRaceError &&
          attempt < MAX_UPDATE_ATTEMPTS
        ) {
          continue;
        }

        throw error;
      }
    }
  }
}

class InsertRaceError extends Error {
  constructor() {
    super("plugin_state row was inserted concurrently");
  }
}

function selectRow(db, namespace, key) {
  return db.selectFrom("plugin_state")
    .select("value_json")
    .where("namespace", "=", namespace)
    .where("key", "=", key)
    .executeTakeFirst();
}

function upsertRow(db, namespace, key, json) {
  return db.insertInto("plugin_state")
    .values({
      namespace,
      key,
      value_json: json,
      updated_at: new Date().toISOString()
    })
    .onConflict(oc => oc.columns(["namespace", "key"]).doUpdateSet({
      value_json: eb => eb.ref("excluded.value_json"),
      updated_at: eb => eb.ref("excluded.updated_at")
    }))
    .execute();
}

function encodeValue(value) {
  const json =
    value === undefined
      ? undefined
      : JSON.stringify(value);

  if (json === undefined) {
    throw new TypeError(
      "Plugin state values must be JSON-serializable (use delete() to remove a value)"
    );
  }

  return json;
}

function requireFunction(fn) {
  if (typeof fn !== "function") {
    throw new TypeError(
      "Plugin state update() requires a function"
    );
  }
}

function storageKey(namespace, key) {
  return `${namespace}\u0000${key}`;
}

/*
 * Build the namespace a plugin context's state lives in, e.g.
 * "destination:@brainstem/matrix:room" or, when the config entry
 * has an id, "destination:@brainstem/matrix:room:ops-room".
 */
export function pluginStateNamespace({ kind, plugin, name, id } = {}) {
  const parts = [kind, plugin, name];

  if (id !== undefined && id !== null && id !== "") {
    parts.push(String(id));
  }

  return parts.join(":");
}

/*
 * Bind a store to one namespace: the ctx.state plugins see.
 */
export function createPluginState(store, namespace) {
  if (!store) {
    throw new TypeError("createPluginState requires a store");
  }

  return {
    namespace,

    get(key) {
      return store.get(namespace, requireKey(key));
    },

    set(key, value) {
      return store.set(namespace, requireKey(key), value);
    },

    update(key, fn) {
      return store.update(namespace, requireKey(key), fn);
    },

    delete(key) {
      return store.delete(namespace, requireKey(key));
    }
  };
}

function requireKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError(
      "Plugin state keys must be non-empty strings"
    );
  }

  return key;
}
