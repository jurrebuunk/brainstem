import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

  get(id) {
    const record =
      this.records.get(id);

    return record
      ? clone(record)
      : null;
  }

  put(record) {
    this.records.set(
      record.id,
      normalizeRecord(record)
    );
  }

  touch(id, { observation, lastSeenAt }) {
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

  prune({ olderThan }) {
    for (const [id, record] of this.records) {
      if (record.last_seen_at < olderThan) {
        this.records.delete(id);
      }
    }
  }

  close() {}
}

export class SqliteRecordStore {
  constructor({
    path,
    pruneAfterDays = null
  }) {
    this.path = resolve(path);

    mkdirSync(dirname(this.path), {
      recursive: true
    });

    this.closed = false;

    this.db =
      new DatabaseSync(this.path);

    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        revision INTEGER NOT NULL,
        observation_json TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS records_last_seen_at_idx
        ON records (last_seen_at);
    `);

    this.getStatement =
      this.db.prepare(`
        SELECT *
        FROM records
        WHERE id = ?
      `);

    this.putStatement =
      this.db.prepare(`
        INSERT INTO records (
          id,
          fingerprint,
          cache_key,
          revision,
          observation_json,
          decision_json,
          first_seen_at,
          last_seen_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          fingerprint = excluded.fingerprint,
          cache_key = excluded.cache_key,
          revision = excluded.revision,
          observation_json = excluded.observation_json,
          decision_json = excluded.decision_json,
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at
      `);

    this.touchStatement =
      this.db.prepare(`
        UPDATE records
        SET observation_json = ?,
            last_seen_at = ?
        WHERE id = ?
      `);

    this.pruneStatement =
      this.db.prepare(`
        DELETE FROM records
        WHERE last_seen_at < ?
      `);

    if (typeof pruneAfterDays === "number") {
      this.prune({
        olderThan: daysAgoIso(pruneAfterDays)
      });
    }
  }

  get(id) {
    const row =
      this.getStatement.get(id);

    return row
      ? recordFromRow(row)
      : null;
  }

  put(record) {
    const normalized =
      normalizeRecord(record);

    this.putStatement.run(
      normalized.id,
      normalized.fingerprint,
      normalized.cache_key,
      normalized.revision,
      JSON.stringify(normalized.observation),
      JSON.stringify(normalized.decision),
      normalized.first_seen_at,
      normalized.last_seen_at,
      normalized.updated_at
    );
  }

  touch(id, { observation, lastSeenAt }) {
    this.touchStatement.run(
      JSON.stringify(observation),
      lastSeenAt,
      id
    );
  }

  prune({ olderThan }) {
    this.pruneStatement.run(
      olderThan
    );
  }

  close() {
    if (this.closed) {
      return;
    }

    this.db.close();
    this.closed = true;
  }
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
    revision: row.revision,
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
