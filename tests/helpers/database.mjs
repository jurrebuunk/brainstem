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

  const schema = `t_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = await openDatabase({ url: TEST_PG_URL, pool: { max: 1 } });
  await admin.db.executeQuery({ sql: `create schema "${schema}"`, parameters: [], query: { kind: "RawNode" } });
  await admin.close();

  const url = new URL(TEST_PG_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);

  return {
    url: url.toString(),
    async drop() {
      const cleanup = await openDatabase({ url: TEST_PG_URL, pool: { max: 1 } });
      await cleanup.db.executeQuery({ sql: `drop schema "${schema}" cascade`, parameters: [], query: { kind: "RawNode" } });
      await cleanup.close();
    }
  };
}

/*
 * Open a migrated, isolated database for one test.
 */
export async function openTestDatabase(dialect) {
  const isolated = await isolatedDatabaseUrl(dialect);
  const handle = await openDatabase({ url: isolated.url });
  await migrateToLatest(handle);

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
