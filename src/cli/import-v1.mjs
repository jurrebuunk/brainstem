import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";

import { parseDatabaseUrl } from "../db/database.mjs";
import { migrateToLatest } from "../db/migrate.mjs";
import { chunk, insertIgnoringConflicts } from "./tables.mjs";

export const IMPORT_V1_TASK = "import-v1";

const BATCH_SIZE = 500;

const RECORD_COLUMNS = [
  "id", "fingerprint", "cache_key", "revision", "observation_json",
  "decision_json", "first_seen_at", "last_seen_at", "updated_at"
];
const EVENT_COLUMNS = ["received_at", "kind", "level", "source", "event_json"];
const USER_COLUMNS = ["id", "username", "name", "password_hash", "active", "created_at", "updated_at"];
const ROLE_COLUMNS = ["id", "name", "description", "permissions_json", "system", "created_at", "updated_at"];
const SESSION_COLUMNS = ["token", "user_id", "csrf_token", "expires_at", "created_at", "revoked_at"];

/*
 * Resolve the 1.x state files inside a data directory.
 */
export function legacyPaths({ dataDir = "data", recordsDb, telemetryDb, checkpointsFile } = {}) {
  return {
    recordsDb: resolve(recordsDb ?? join(dataDir, "brainstem.sqlite")),
    telemetryDb: resolve(telemetryDb ?? join(dataDir, "web-stats.sqlite")),
    checkpointsFile: resolve(checkpointsFile ?? join(dataDir, "checkpoints.json"))
  };
}

/*
 * Import Brainstem 1.x state into a 2.0 database.
 *
 *   data/brainstem.sqlite   → records
 *   data/web-stats.sqlite   → web_events, stat_*, auth_*
 *   data/checkpoints.json   → checkpoints
 *
 * Legacy files are opened read-only and never modified.
 * Re-running is safe: keyed rows use ON CONFLICT DO NOTHING
 * and web_events (which get fresh ids) are imported once,
 * guarded by the maintenance_runs task 'import-v1'.
 *
 * Returns [{ table, read, inserted, note? }].
 */
export async function importV1(handle, options = {}) {
  const paths = legacyPaths(options);
  const { db, dialect } = handle;
  const summary = [];

  await migrateToLatest(handle);

  // Records.
  const target = parseDatabaseUrl(handle.url);
  const inPlace = target.dialect === "sqlite" &&
    target.path !== ":memory:" &&
    resolve(target.path) === paths.recordsDb;

  if (inPlace) {
    summary.push({ table: "records", read: 0, inserted: 0, note: "already in target database (in-place upgrade)" });
  }
  else {
    summary.push(await withLegacyDb(paths.recordsDb, "records", async legacy => {
      return copyLegacyTable(db, dialect, legacy, "records", RECORD_COLUMNS, "id");
    }));
  }

  // Telemetry, stats and auth.
  const telemetryTables = ["web_events", "stat_counters", "stat_timeseries", "auth_users", "auth_roles", "auth_user_roles", "auth_sessions"];

  if (!existsSync(paths.telemetryDb)) {
    for (const table of telemetryTables) {
      summary.push({ table, read: 0, inserted: 0, note: `source not found: ${paths.telemetryDb}` });
    }
  }
  else {
    const legacy = openLegacy(paths.telemetryDb);

    try {
      summary.push(await importEvents(db, legacy));
      summary.push(await guarded(legacy, "stat_counters", () =>
        copyLegacyTable(db, dialect, legacy, "stat_counters", ["key", "value"], "key")));
      summary.push(await guarded(legacy, "stat_timeseries", () =>
        copyLegacyTable(db, dialect, legacy, "stat_timeseries", ["bucket", "metric", "value"], "bucket, metric")));
      summary.push(...await importAuth(db, dialect, legacy));
    }
    finally {
      legacy.close();
    }
  }

  // Checkpoints.
  summary.push(await importCheckpoints(db, dialect, paths.checkpointsFile));

  return summary;
}

function openLegacy(path) {
  return new DatabaseSync(path, { readOnly: true });
}

async function withLegacyDb(path, table, fn) {
  if (!existsSync(path)) {
    return { table, read: 0, inserted: 0, note: `source not found: ${path}` };
  }

  const legacy = openLegacy(path);
  try {
    return await guarded(legacy, table, () => fn(legacy));
  }
  finally {
    legacy.close();
  }
}

function hasTable(legacy, table) {
  return Boolean(
    legacy.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table)
  );
}

async function guarded(legacy, table, fn) {
  if (!hasTable(legacy, table)) {
    return { table, read: 0, inserted: 0, note: "table not present in source" };
  }
  return fn();
}

function readLegacyRows(legacy, table, columns, orderBy) {
  return legacy.prepare(
    `select ${columns.join(", ")} from ${table} order by ${orderBy}`
  ).all();
}

async function copyLegacyTable(db, dialect, legacy, table, columns, orderBy) {
  const rows = readLegacyRows(legacy, table, columns, orderBy);
  let inserted = 0;

  await db.transaction().execute(async trx => {
    for (const batch of chunk(rows, BATCH_SIZE)) {
      inserted += await insertIgnoringConflicts(trx, table, batch, { dialect });
    }
  });

  return { table, read: rows.length, inserted };
}

/*
 * web_events have database-generated ids that may collide with
 * events the 2.0 runtime already wrote, so they are inserted with
 * fresh ids in source order — exactly once.
 */
async function importEvents(db, legacy) {
  if (!hasTable(legacy, "web_events")) {
    return { table: "web_events", read: 0, inserted: 0, note: "table not present in source" };
  }

  const done = await db.selectFrom("maintenance_runs")
    .select("last_run_at")
    .where("task", "=", IMPORT_V1_TASK)
    .executeTakeFirst();

  if (done) {
    return { table: "web_events", read: 0, inserted: 0, note: `already imported at ${done.last_run_at}` };
  }

  const rows = readLegacyRows(legacy, "web_events", EVENT_COLUMNS, "id");
  let inserted = 0;

  await db.transaction().execute(async trx => {
    for (const batch of chunk(rows, BATCH_SIZE)) {
      const result = await trx.insertInto("web_events").values(batch).executeTakeFirst();
      inserted += Number(result.numInsertedOrUpdatedRows ?? batch.length);
    }
    await trx.insertInto("maintenance_runs")
      .values({ task: IMPORT_V1_TASK, last_run_at: new Date().toISOString() })
      .execute();
  });

  return { table: "web_events", read: rows.length, inserted };
}

/*
 * Users and roles are matched by their unique username / name
 * when the target already has them under a different id (e.g.
 * default roles seeded by a 2.0 start before the import), so
 * role assignments and sessions still point at the right rows.
 */
async function importAuth(db, dialect, legacy) {
  const summary = [];
  const userIds = new Map();
  const roleIds = new Map();

  summary.push(await guarded(legacy, "auth_users", async () => {
    const result = await copyLegacyTable(db, dialect, legacy, "auth_users", USER_COLUMNS, "created_at, id");
    const legacyUsers = readLegacyRows(legacy, "auth_users", ["id", "username"], "id");
    const targetUsers = await db.selectFrom("auth_users").select(["id", "username"]).execute();
    const byUsername = new Map(targetUsers.map(user => [user.username, user.id]));
    for (const user of legacyUsers) {
      if (byUsername.has(user.username)) userIds.set(user.id, byUsername.get(user.username));
    }
    return result;
  }));

  summary.push(await guarded(legacy, "auth_roles", async () => {
    const result = await copyLegacyTable(db, dialect, legacy, "auth_roles", ROLE_COLUMNS, "created_at, id");
    const legacyRoles = readLegacyRows(legacy, "auth_roles", ["id", "name"], "id");
    const targetRoles = await db.selectFrom("auth_roles").select(["id", "name"]).execute();
    const byName = new Map(targetRoles.map(role => [role.name, role.id]));
    for (const role of legacyRoles) {
      if (byName.has(role.name)) roleIds.set(role.id, byName.get(role.name));
    }
    return result;
  }));

  summary.push(await guarded(legacy, "auth_user_roles", async () => {
    const legacyRows = readLegacyRows(legacy, "auth_user_roles", ["user_id", "role_id"], "user_id, role_id");
    const rows = legacyRows
      .map(row => ({ user_id: userIds.get(row.user_id), role_id: roleIds.get(row.role_id) }))
      .filter(row => row.user_id && row.role_id);
    const inserted = await insertMapped(db, dialect, "auth_user_roles", rows);
    return withSkipped({ table: "auth_user_roles", read: legacyRows.length, inserted }, legacyRows.length - rows.length);
  }));

  summary.push(await guarded(legacy, "auth_sessions", async () => {
    const legacyRows = readLegacyRows(legacy, "auth_sessions", SESSION_COLUMNS, "created_at, token");
    const rows = legacyRows
      .map(row => ({ ...row, user_id: userIds.get(row.user_id) }))
      .filter(row => row.user_id);
    const inserted = await insertMapped(db, dialect, "auth_sessions", rows);
    return withSkipped({ table: "auth_sessions", read: legacyRows.length, inserted }, legacyRows.length - rows.length);
  }));

  return summary;
}

async function insertMapped(db, dialect, table, rows) {
  let inserted = 0;
  await db.transaction().execute(async trx => {
    for (const batch of chunk(rows, BATCH_SIZE)) {
      inserted += await insertIgnoringConflicts(trx, table, batch, { dialect });
    }
  });
  return inserted;
}

function withSkipped(entry, skipped) {
  return skipped > 0
    ? { ...entry, note: `${skipped} skipped (user or role missing in target)` }
    : entry;
}

async function importCheckpoints(db, dialect, path) {
  if (!existsSync(path)) {
    return { table: "checkpoints", read: 0, inserted: 0, note: `source not found: ${path}` };
  }

  const text = await readFile(path, "utf8");
  let data;
  try {
    data = text.trim() ? JSON.parse(text) : {};
  }
  catch (error) {
    throw new Error(`Cannot parse ${path}: ${error.message}`, { cause: error });
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${path} must contain a JSON object of checkpoint key → value`);
  }

  const now = new Date().toISOString();
  const rows = Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value_json: JSON.stringify(value), updated_at: now }));

  const inserted = await insertMapped(db, dialect, "checkpoints", rows);

  return { table: "checkpoints", read: rows.length, inserted };
}
