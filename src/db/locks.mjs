import { createHash } from "node:crypto";
import { sql } from "kysely";

/*
 * Singletons (roadmap 4.1, ADR-0002): work that one process in the
 * cluster should do at a time, such as retention pruning.
 *
 *   const { ran, result } = await withSingletonLock(handle, "deliveries.prune", fn);
 *
 * Postgres: a session-level advisory lock, tried without waiting,
 * on a connection held for the duration of fn. When another process
 * holds it, fn is skipped ({ ran: false }). Advisory locks need a
 * direct connection (not a PgBouncer transaction pool).
 *
 * SQLite: single-node, so the lock is process-local. Several
 * processes on one SQLite file may each run the task, which is
 * harmless for the idempotent tasks this is used for.
 */
const localLocks = new Set();

export async function withSingletonLock(handle, name, fn) {
  if (handle.dialect !== "postgres") {
    const key = `${handle.url ?? ""}:${name}`;
    if (localLocks.has(key)) return { ran: false };

    localLocks.add(key);
    try {
      return { ran: true, result: await fn() };
    }
    finally {
      localLocks.delete(key);
    }
  }

  const [high, low] = advisoryKey(`${handle.schema ?? "public"}:${name}`);

  return await handle.db.connection().execute(async connection => {
    const { rows } = await sql`select pg_try_advisory_lock(${high}, ${low}) as locked`.execute(connection);

    if (!rows[0]?.locked) return { ran: false };

    try {
      return { ran: true, result: await fn() };
    }
    finally {
      await sql`select pg_advisory_unlock(${high}, ${low})`.execute(connection);
    }
  });
}

/*
 * Two signed 32-bit integers derived from the lock name, for
 * pg_try_advisory_lock(int, int).
 */
export function advisoryKey(name) {
  const digest = createHash("sha256").update(name).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}
