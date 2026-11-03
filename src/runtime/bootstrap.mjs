import { existsSync } from "node:fs";

import { openDatabase, openMigratedDatabase } from "../db/index.mjs";
import { migrationStatus } from "../db/migrate.mjs";
import { importV1, legacyPaths } from "../cli/import-v1.mjs";
import { runtimeDatabaseUrl } from "./stores.mjs";

const AUTO_IMPORT_TASK = "auto-import-v1";

/*
 * Open the single database shared by the runtime and the
 * backend API in one process, migrated to the latest schema.
 *
 * On the first start after upgrading from 1.x, legacy state
 * files in the data directory (web-stats.sqlite,
 * checkpoints.json, a separate records file) are imported
 * once. Set runtime.database.importLegacy: false to skip.
 *
 * With `migrate: false` (cluster roles: migrations run once, from
 * `brainstem migrate` or a deploy hook, never from every pod) the
 * schema is only checked, and opening fails while migrations are
 * pending.
 *
 * `waitMs` (BRAINSTEM_SCHEMA_WAIT_MS) keeps retrying that for a
 * while instead of failing at once: on Kubernetes the pods start
 * together with the migration Job, or before the database is up.
 */
export async function openRuntimeDatabase(config = {}, {
  baseDir = process.cwd(),
  logger = null,
  migrate = true,
  waitMs = Number(process.env.BRAINSTEM_SCHEMA_WAIT_MS ?? 0),
  retryMs = 2_000
} = {}) {
  const options = config.runtime?.database ?? {};
  const url = runtimeDatabaseUrl(options, baseDir);

  if (!migrate) {
    const deadline = Date.now() + Math.max(0, waitMs || 0);
    let warned = false;

    while (true) {
      try {
        return await openCurrentDatabase(url, options);
      }
      catch (error) {
        if (Date.now() + retryMs > deadline) throw error;

        if (!warned) {
          warned = true;
          logger?.warn?.("waiting for the database schema", { error: error.message, waitMs });
        }

        await new Promise(resolve => setTimeout(resolve, retryMs));
      }
    }
  }

  const handle = await openMigratedDatabase({
    url,
    pool: options.pool ?? {}
  });

  if (options.importLegacy !== false) {
    try {
      await importLegacyStateOnce(handle, options, logger);
    }
    catch (error) {
      await handle.close();
      throw error;
    }
  }

  return handle;
}

async function openCurrentDatabase(url, options) {
  const handle = await openDatabase({ url, pool: options.pool ?? {} });

  try {
    await assertSchemaCurrent(handle);
  }
  catch (error) {
    await handle.close();
    throw error;
  }

  return handle;
}

export async function assertSchemaCurrent(handle) {
  let status;

  try {
    status = await migrationStatus(handle);
  }
  catch (error) {
    throw new Error(`Could not read the database schema version: ${error.message}. Run \`brainstem migrate\` first.`, { cause: error });
  }

  const pending = status.filter(migration => !migration.executedAt).map(migration => migration.name);

  if (pending.length > 0) {
    throw new Error(`The database schema is not up to date (pending: ${pending.join(", ")}). Run \`brainstem migrate\` first, or set BRAINSTEM_MIGRATE=true.`);
  }
}

async function importLegacyStateOnce(handle, options, logger) {
  const paths = legacyPaths({ dataDir: options.legacyDataDir ?? "data" });
  const hasLegacy = existsSync(paths.telemetryDb) || existsSync(paths.checkpointsFile);

  if (!hasLegacy) return;

  const done = await handle.db.selectFrom("maintenance_runs")
    .select("last_run_at")
    .where("task", "=", AUTO_IMPORT_TASK)
    .executeTakeFirst();

  if (done) return;

  logger?.info?.("importing 1.x state into the database", { dataDir: options.legacyDataDir ?? "data" });

  const summary = await importV1(handle, { dataDir: options.legacyDataDir ?? "data" });

  await handle.db.insertInto("maintenance_runs")
    .values({ task: AUTO_IMPORT_TASK, last_run_at: new Date().toISOString() })
    .onConflict(oc => oc.column("task").doNothing())
    .execute();

  logger?.info?.("imported 1.x state", {
    tables: summary
      .filter(row => row.inserted > 0)
      .map(row => `${row.table}: ${row.inserted}`)
  });
}
