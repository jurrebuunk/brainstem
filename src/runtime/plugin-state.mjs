import { sql } from "kysely";

// The in-memory store and the ctx.state API come from the SDK.
export {
  MemoryPluginStateStore,
  createPluginState,
  pluginStateNamespace
} from "@brainstem-dev/sdk";

/*
 * Plugin state stores.
 *
 * Small durable key/value state for plugins (suppression state,
 * cursors, caches), keyed by (namespace, key). Values are JSON.
 *
 * The database store here and the SDK's in-memory store share one
 * async interface:
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

/*
 * Database plugin state behind a lazily opened handle.
 *
 * The runtime opens its database on first use; this store
 * waits for that handle instead of requiring it up front.
 */
export class LazyPluginStateStore {
  #getHandle;
  #store = null;

  constructor(getHandle) {
    this.#getHandle = getHandle;
  }

  async #resolve() {
    this.#store ??= new DatabasePluginStateStore(await this.#getHandle());
    return this.#store;
  }

  async get(namespace, key) {
    return (await this.#resolve()).get(namespace, key);
  }

  async set(namespace, key, value) {
    return (await this.#resolve()).set(namespace, key, value);
  }

  async delete(namespace, key) {
    return (await this.#resolve()).delete(namespace, key);
  }

  async update(namespace, key, fn) {
    return (await this.#resolve()).update(namespace, key, fn);
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
