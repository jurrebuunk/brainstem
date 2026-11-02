import { existsSync } from "node:fs";

import { openMigratedDatabase } from "../db/index.mjs";
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
 */
export async function openRuntimeDatabase(config = {}, {
  baseDir = process.cwd(),
  logger = null
} = {}) {
  const options = config.runtime?.database ?? {};
  const handle = await openMigratedDatabase({
    url: runtimeDatabaseUrl(options, baseDir),
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
