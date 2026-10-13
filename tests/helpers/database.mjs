import test from "node:test";
import { join } from "node:path";

import { openDatabase } from "../../src/db/database.mjs";
import { migrateToLatest } from "../../src/db/migrate.mjs";
import { tempDir } from "./fixtures.mjs";

/*
 * Postgres tests run when BRAINSTEM_TEST_PG_URL is set
 * (CI sets it; locally e.g. postgres://brainstem@127.0.0.1:55432/brainstem_test).
 */
export const TEST_PG_URL = process.env.BRAINSTEM_TEST_PG_URL ?? null;

export const DIALECTS = TEST_PG_URL ? ["sqlite", "postgres"] : ["sqlite"];

/*
 * Returns a database URL that is isolated for one test:
 * a fresh SQLite file, or a fresh Postgres schema.
 */
export async function isolatedDatabaseUrl(dialect) {
  if (dialect === "sqlite") {
    const dir = await tempDir("db");
    return { url: `sqlite:${join(dir, "brainstem.sqlite")}`, async drop() {} };
  }

  // Kysely's migrator looks for its tables in every schema, so a
  // concurrent test file's schema would make it skip creating ours.
  // Serialize Postgres tests across test files (node --test runs
  // files in parallel processes) with an advisory lock.
  const releaseLock = await acquireTestLock();

  const schema = `t_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = await openDatabase({ url: TEST_PG_URL, pool: { max: 1 } });

  try {
    await admin.db.executeQuery({ sql: `create schema "${schema}"`, parameters: [], query: { kind: "RawNode" } });
  }
  catch (error) {
    await releaseLock();
    throw error;
  }
  finally {
    await admin.close();
  }

  const url = new URL(TEST_PG_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);

  return {
    url: url.toString(),
    async drop() {
      const cleanup = await openDatabase({ url: TEST_PG_URL, pool: { max: 1 } });
      await cleanup.db.executeQuery({ sql: `drop schema "${schema}" cascade`, parameters: [], query: { kind: "RawNode" } });
      await cleanup.close();
      await releaseLock();
    }
  };
}

const TEST_LOCK_KEY = 72_001_337;

/*
 * Hold a session advisory lock on a checked-out connection until
 * the returned release function is called.
 */
async function acquireTestLock() {
  const handle = await openDatabase({ url: TEST_PG_URL, pool: { max: 1 } });
  let release;
  const released = new Promise(resolve => { release = resolve; });
  let locked;
  const acquired = new Promise((resolve, reject) => { locked = { resolve, reject }; });

  const holder = handle.db.connection().execute(async connection => {
    const raw = sql => connection.executeQuery({ sql, parameters: [], query: { kind: "RawNode" } });
    await raw(`select pg_advisory_lock(${TEST_LOCK_KEY})`);
    locked.resolve();
    await released;
    await raw(`select pg_advisory_unlock(${TEST_LOCK_KEY})`);
  }).catch(error => locked.reject(error));

  await acquired;

  return async () => {
    release();
    await holder;
    await handle.close();
  };
}

/*
 * Open a migrated, isolated database for one test.
 */
export async function openTestDatabase(dialect) {
  const isolated = await isolatedDatabaseUrl(dialect);
  const handle = await openDatabase({ url: isolated.url });

  try {
    await migrateToLatest(handle);
  }
  catch (error) {
    await handle.close();
    await isolated.drop();
    throw error;
  }

  return {
    ...handle,
    async close() {
      await handle.close();
      await isolated.drop();
    }
  };
}

/*
 * Register one test per available dialect.
 *
 *   dialectTest("records round-trip", async ({ handle, dialect }) => { ... });
 */
export function dialectTest(name, fn, options = {}) {
  for (const dialect of DIALECTS) {
    test(`[${dialect}] ${name}`, options, async t => {
      const handle = await openTestDatabase(dialect);
      try {
        await fn({ handle, dialect, t });
      }
      finally {
        await handle.close();
      }
    });
  }
}
