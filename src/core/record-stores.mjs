import { resolve } from "node:path";

/*
 * Record stores.
 *
 * A record store keeps one decision record per
 * observation ID. All methods are async:
 *
 *   get(id)                      -> record | null
 *   put(record, { expectedRevision })
 *   touch(id, { observation, lastSeenAt })
 *   prune({ olderThan })
 *   close()
 *
 * put() is an upsert guarded by an optional
 * optimistic revision check:
 *
 *   expectedRevision === undefined
 *     unconditional upsert (1.x behaviour)
 *
 *   expectedRevision === null
 *     the record must not exist yet
 *
 *   expectedRevision === <number>
 *     an existing record is only replaced when
 *     its stored revision still equals it
 *
 * A failed check throws RecordConflictError.
 *
 * Within one process Brainstem serializes all
 * work for an ID, so the check never fails
 * there. It is groundwork for multi-core
 * compare-and-swap, where several cores may
 * write the same record (roadmap Phase 3).
 */

export const DEFAULT_PRUNE_INTERVAL_MS =
  60 * 60 * 1000;


export class RecordConflictError extends Error {
  constructor(id, expectedRevision) {
    super(
      `Record '${id}' was modified concurrently ` +
      `(expected revision ${expectedRevision ?? "none"})`
    );

    this.name = "RecordConflictError";
    this.code = "BRAINSTEM_RECORD_CONFLICT";
    this.id = id;
    this.expectedRevision = expectedRevision;
  }
}


export class MemoryRecordStore {
  constructor(initial = {}) {
    this.records = new Map(
      Object.entries(initial).map(
        ([id, record]) => [
          id,
          clone(record)
        ]
      )
    );
  }

  async open() {}

  async get(id) {
    const record =
      this.records.get(id);

    return record
      ? clone(record)
      : null;
  }

  async put(record, { expectedRevision } = {}) {
    const stored =
      this.records.get(record.id);

    if (
      !revisionMatches(
        stored,
        expectedRevision
      )
    ) {
      throw new RecordConflictError(
        record.id,
        expectedRevision
      );
    }

    const normalized =
      normalizeRecord(record);

    /*
     * Upsert semantics: first_seen_at belongs
     * to the original row.
     */
    if (stored) {
      normalized.first_seen_at =
        stored.first_seen_at;
    }

    this.records.set(
      record.id,
      normalized
    );
  }

  async touch(id, { observation, lastSeenAt }) {
    const record =
      this.records.get(id);

    if (!record) {
      return;
    }

    record.observation =
      clone(observation);

    record.last_seen_at =
      lastSeenAt;
  }

  async prune({ olderThan }) {
    for (const [id, record] of this.records) {
      if (record.last_seen_at < olderThan) {
        this.records.delete(id);
      }
    }
  }

  async close() {}
}


/*
 * Kysely-backed record store.
 *
 * Works on every Brainstem dialect (SQLite and
 * Postgres) against the `records` table from
 * migration 0001.
 *
 * `database` is a handle from openDatabase()
 * ({ db, dialect, close }), a promise of one,
 * or a function returning one (opened lazily on
 * first use). The store only closes the handle
 * when `ownsDatabase` is true.
 *
 * When `pruneAfterDays` is set, records not seen
 * for that long are pruned once the store opens
 * and then every `pruneIntervalMs` (hourly by
 * default) on an unref'd timer.
 */
export class DatabaseRecordStore {
  constructor({
    database,
    ownsDatabase = false,
    pruneAfterDays = null,
    pruneIntervalMs = DEFAULT_PRUNE_INTERVAL_MS,
    onError = null
  } = {}) {
    if (!database) {
      throw new Error(
        "DatabaseRecordStore requires a database handle"
      );
    }

    this.database = database;
    this.ownsDatabase = ownsDatabase;
    this.pruneAfterDays = pruneAfterDays;
    this.pruneIntervalMs = pruneIntervalMs;
    this.onError = onError;

    this.handle = null;
    this.opening = null;
    this.pruneTimer = null;
    this.closed = false;
  }


  /*
   * Resolve the database handle.
   *
   * Idempotent. A failed open is not cached, so
   * startup retries can try again.
   */
  async open() {
    if (this.closed) {
      throw new Error(
        "Record store has been closed"
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

      if (this.closed) {
        await this.#closeHandle();

        throw new Error(
          "Record store has been closed"
        );
      }

      this.#startPruning();

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


  get dialect() {
    return this.handle?.dialect ?? null;
  }


  async get(id) {
    const { db } =
      await this.open();

    const row =
      await db
        .selectFrom("records")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();

    return row
      ? recordFromRow(row)
      : null;
  }


  async put(record, { expectedRevision } = {}) {
    const { db } =
      await this.open();

    const normalized =
      normalizeRecord(record);

    const row = {
      id: normalized.id,
      fingerprint: normalized.fingerprint,
      cache_key: normalized.cache_key,
      revision: normalized.revision,
      observation_json:
        JSON.stringify(normalized.observation),
      decision_json:
        JSON.stringify(normalized.decision),
      first_seen_at: normalized.first_seen_at,
      last_seen_at: normalized.last_seen_at,
      updated_at: normalized.updated_at
    };


    /*
     * One statement on both dialects:
     *
     *   INSERT ... ON CONFLICT (id)
     *   DO UPDATE SET ... [WHERE revision = ?]
     *
     * or DO NOTHING when the record must not
     * exist yet. Zero affected rows means the
     * optimistic check failed.
     */
    const result =
      await db
        .insertInto("records")
        .values(row)
        .onConflict(conflict => {
          const target =
            conflict.column("id");

          if (expectedRevision === null) {
            return target.doNothing();
          }

          const update =
            target.doUpdateSet(eb => ({
              fingerprint: eb.ref("excluded.fingerprint"),
              cache_key: eb.ref("excluded.cache_key"),
              revision: eb.ref("excluded.revision"),
              observation_json: eb.ref("excluded.observation_json"),
              decision_json: eb.ref("excluded.decision_json"),
              last_seen_at: eb.ref("excluded.last_seen_at"),
              updated_at: eb.ref("excluded.updated_at")
            }));

          return expectedRevision === undefined
            ? update
            : update.where(
                "records.revision",
                "=",
                expectedRevision
              );
        })
        .executeTakeFirst();

    if (
      Number(result?.numInsertedOrUpdatedRows ?? 0) === 0
    ) {
      throw new RecordConflictError(
        normalized.id,
        expectedRevision
      );
    }
  }


  async touch(id, { observation, lastSeenAt }) {
    const { db } =
      await this.open();

    await db
      .updateTable("records")
      .set({
        observation_json:
          JSON.stringify(observation),
        last_seen_at: lastSeenAt
      })
      .where("id", "=", id)
      .execute();
  }


  async prune({ olderThan }) {
    const { db } =
      await this.open();

    const result =
      await db
        .deleteFrom("records")
        .where("last_seen_at", "<", olderThan)
        .executeTakeFirst();

    return Number(result?.numDeletedRows ?? 0);
  }


  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;

    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }

    await this.opening?.catch(() => {});
    await this.#closeHandle();
  }


  #startPruning() {
    if (
      typeof this.pruneAfterDays !== "number"
    ) {
      return;
    }

    const run = () =>
      this.prune({
        olderThan:
          daysAgoIso(this.pruneAfterDays)
      })
        .catch(error => {
          if (!this.closed) {
            this.onError?.(error);
          }
        });

    run();

    if (this.pruneIntervalMs > 0) {
      this.pruneTimer = setInterval(
        run,
        this.pruneIntervalMs
      );

      this.pruneTimer.unref?.();
    }
  }


  async #closeHandle() {
    const handle = this.handle;
    this.handle = null;

    if (
      handle &&
      this.ownsDatabase
    ) {
      await handle.close();
    }
  }
}


/*
 * Backward-compatible SQLite record store.
 *
 * Config may still say:
 *
 *   records: { type: "sqlite", path }
 *
 * This opens (and migrates) `sqlite:<path>` and
 * owns that handle. 1.x record files use the
 * same `records` table and are reused as-is.
 */
export class SqliteRecordStore extends DatabaseRecordStore {
  constructor({
    path,
    ...options
  }) {
    const absolute =
      resolve(path);

    super({
      ...options,
      ownsDatabase: true,
      database: () =>
        import("../db/index.mjs").then(
          ({ openMigratedDatabase }) =>
            openMigratedDatabase({
              url: `sqlite:${absolute}`
            })
        )
    });

    this.path = absolute;
  }
}


function revisionMatches(stored, expectedRevision) {
  if (expectedRevision === undefined) {
    return true;
  }

  if (expectedRevision === null) {
    return !stored;
  }

  return (
    !stored ||
    stored.revision === expectedRevision
  );
}

function normalizeRecord(record) {
  return {
    id: record.id,
    fingerprint: record.fingerprint,
    cache_key: record.cache_key,
    revision: record.revision,
    observation: clone(record.observation),
    decision: clone(record.decision),
    first_seen_at: record.first_seen_at,
    last_seen_at: record.last_seen_at,
    updated_at: record.updated_at
  };
}

function recordFromRow(row) {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    cache_key: row.cache_key,
    revision: Number(row.revision),
    observation: JSON.parse(row.observation_json),
    decision: JSON.parse(row.decision_json),
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    updated_at: row.updated_at
  };
}

function daysAgoIso(days) {
  return new Date(
    Date.now() - days * 24 * 60 * 60 * 1000
  ).toISOString();
}

function clone(value) {
  return value === undefined
    ? undefined
    : structuredClone(value);
}
