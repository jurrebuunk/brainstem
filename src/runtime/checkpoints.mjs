import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class MemoryCheckpointStore {
  constructor(initial = {}) {
    this.data = structuredClone(initial);
  }

  async get(key) {
    return clone(
      this.data[key]
    );
  }

  async set(key, value) {
    assertJsonValue(value);

    if (value === null) {
      delete this.data[key];
      return;
    }

    this.data[key] = clone(value);
  }

  async close() {}
}

export class JsonFileCheckpointStore extends MemoryCheckpointStore {
  constructor(path) {
    super();

    this.path = path;
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  async get(key) {
    await this.#load();

    return super.get(key);
  }

  async set(key, value) {
    await this.#load();
    await super.set(key, value);
    await this.#write();
  }

  async close() {
    await this.writeQueue;
  }

  async #load() {
    if (this.loaded) {
      return;
    }

    try {
      const text =
        await readFile(this.path, "utf8");

      this.data = JSON.parse(text);
    }
    catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      this.data = {};
    }

    this.loaded = true;
  }

  async #write() {
    this.writeQueue =
      this.writeQueue.then(async () => {
        await mkdir(dirname(this.path), {
          recursive: true
        });

        const temporaryPath =
          `${this.path}.tmp`;

        await writeFile(
          temporaryPath,
          JSON.stringify(this.data, null, 2) + "\n"
        );

        await rename(
          temporaryPath,
          this.path
        );
      });

    await this.writeQueue;
  }
}

/*
 * Database checkpoint store.
 *
 * Uses the `checkpoints` table (key ->
 * value_json) on every Brainstem dialect.
 *
 * Every get() reads the database, so several
 * processes sharing one database never see a
 * stale cached value.
 *
 * `database` is a handle from openDatabase()
 * ({ db, dialect, close }), a promise of one,
 * or a function returning one (opened lazily on
 * first use). The store only closes the handle
 * when `ownsDatabase` is true.
 *
 * `legacyJsonPath` points at a 1.x
 * data/checkpoints.json. When the store opens,
 * the table is empty and that file exists, its
 * entries are imported once. The file itself
 * is left untouched.
 */
export class DatabaseCheckpointStore {
  constructor({
    database,
    ownsDatabase = false,
    legacyJsonPath = null
  } = {}) {
    if (!database) {
      throw new Error(
        "DatabaseCheckpointStore requires a database handle"
      );
    }

    this.database = database;
    this.ownsDatabase = ownsDatabase;
    this.legacyJsonPath = legacyJsonPath;

    this.handle = null;
    this.opening = null;
    this.closed = false;

    /*
     * Number of entries imported from the
     * legacy JSON file (0 when none).
     */
    this.imported = 0;
  }

  async open() {
    if (this.closed) {
      throw new Error(
        "Checkpoint store has been closed"
      );
    }

    if (this.handle) {
      return this.handle;
    }

    this.opening ??= (async () => {
      const handle =
        typeof this.database === "function"
          ? await this.database()
          : await this.database;

      this.handle = handle;

      await this.#importLegacyJson(handle);

      return handle;
    })();

    try {
      return await this.opening;
    }
    catch (error) {
      this.opening = null;
      throw error;
    }
  }

  async get(key) {
    const { db } =
      await this.open();

    const row =
      await db
        .selectFrom("checkpoints")
        .select("value_json")
        .where("key", "=", key)
        .executeTakeFirst();

    return row
      ? JSON.parse(row.value_json)
      : undefined;
  }

  async set(key, value) {
    assertJsonValue(value);

    const { db } =
      await this.open();

    if (value === null) {
      await db
        .deleteFrom("checkpoints")
        .where("key", "=", key)
        .execute();

      return;
    }

    await db
      .insertInto("checkpoints")
      .values({
        key,
        value_json: JSON.stringify(value),
        updated_at: new Date().toISOString()
      })
      .onConflict(conflict =>
        conflict
          .column("key")
          .doUpdateSet(eb => ({
            value_json: eb.ref("excluded.value_json"),
            updated_at: eb.ref("excluded.updated_at")
          }))
      )
      .execute();
  }

  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;

    await this.opening?.catch(() => {});

    const handle = this.handle;
    this.handle = null;

    if (
      handle &&
      this.ownsDatabase
    ) {
      await handle.close();
    }
  }

  async #importLegacyJson({ db }) {
    if (!this.legacyJsonPath) {
      return;
    }

    const existing =
      await db
        .selectFrom("checkpoints")
        .select("key")
        .limit(1)
        .executeTakeFirst();

    if (existing) {
      return;
    }

    let data;

    try {
      data = JSON.parse(
        await readFile(this.legacyJsonPath, "utf8")
      );
    }
    catch (error) {
      if (error.code === "ENOENT") {
        return;
      }

      throw new Error(
        `Failed to import legacy checkpoints from '${this.legacyJsonPath}': ${error.message}`,
        { cause: error }
      );
    }

    const now =
      new Date().toISOString();

    const rows =
      Object.entries(data ?? {})
        .filter(([, value]) =>
          value !== null &&
          value !== undefined
        )
        .map(([key, value]) => ({
          key,
          value_json: JSON.stringify(value),
          updated_at: now
        }));

    if (rows.length === 0) {
      return;
    }

    /*
     * DO NOTHING keeps the import idempotent
     * when several processes start at once.
     */
    await db.transaction().execute(async trx => {
      for (const row of rows) {
        await trx
          .insertInto("checkpoints")
          .values(row)
          .onConflict(conflict =>
            conflict
              .column("key")
              .doNothing()
          )
          .execute();
      }
    });

    this.imported = rows.length;
  }
}

export function createDeferredCheckpoint({
  store,
  key
}) {
  let pending = false;
  let pendingValue;

  return {
    api: {
      get() {
        return store.get(key);
      },

      defer(value) {
        assertJsonValue(value);

        pending = true;
        pendingValue = clone(value);
      }
    },

    async commit() {
      if (!pending) {
        return;
      }

      await store.set(
        key,
        pendingValue
      );
    }
  };
}

export function assertJsonValue(value, path = "checkpoint") {
  if (value === undefined) {
    throw new TypeError(
      `${path} cannot be undefined`
    );
  }

  if (value === null) {
    return;
  }

  const type = typeof value;

  if (
    type === "string" ||
    type === "boolean"
  ) {
    return;
  }

  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `${path} must be a finite number`
      );
    }

    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertJsonValue(
        item,
        `${path}[${index}]`
      )
    );

    return;
  }

  if (type === "object") {
    const prototype =
      Object.getPrototypeOf(value);

    if (
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new TypeError(
        `${path} must be plain JSON data`
      );
    }

    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(
        item,
        `${path}.${key}`
      );
    }

    return;
  }

  throw new TypeError(
    `${path} must be JSON-serializable`
  );
}

function clone(value) {
  return value === undefined
    ? undefined
    : structuredClone(value);
}
