import { sql } from "kysely";

/*
 * Run fn inside a write transaction on either dialect.
 *
 * SQLite uses BEGIN IMMEDIATE so the write lock is taken up
 * front (a deferred transaction that reads and then writes can
 * fail with SQLITE_BUSY when another process wrote in between).
 * Postgres uses a regular READ COMMITTED transaction; callers
 * that need a cross-replica guard take an advisory lock with
 * lockTransaction().
 */
export async function writeTransaction(handle, fn) {
  if (handle.dialect !== "sqlite") {
    return await handle.db.transaction().execute(fn);
  }

  return await handle.db.connection().execute(async connection => {
    await sql`begin immediate`.execute(connection);
    try {
      const result = await fn(connection);
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
 * Serialize transactions that share a name across Postgres
 * connections (and therefore replicas). The lock is released
 * on commit or rollback. SQLite's BEGIN IMMEDIATE already
 * serializes writers, so this is a no-op there.
 */
export async function lockTransaction(trx, dialect, name) {
  if (dialect !== "postgres") return;
  await sql`select pg_advisory_xact_lock(hashtext(${name}))`.execute(trx);
}

export function isUniqueViolation(error) {
  return error?.code === "23505"
    || /UNIQUE constraint failed/i.test(String(error?.message ?? ""));
}

export function countValue(row) {
  return Number(row?.count ?? 0);
}

/*
 * Human-readable description of the database for logs and
 * the health endpoint. Strips credentials from Postgres URLs.
 */
export function describeDatabase(url) {
  const value = String(url ?? "");
  if (value.startsWith("sqlite:")) return value.slice("sqlite:".length);

  try {
    const parsed = new URL(value);
    parsed.password = "";
    parsed.username = parsed.username ? parsed.username : "";
    parsed.search = "";
    return parsed.toString();
  }
  catch {
    return "postgres";
  }
}
