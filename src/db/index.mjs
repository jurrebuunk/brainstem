export { DEFAULT_DATABASE_URL, openDatabase, parseDatabaseUrl, resolveDatabaseUrl } from "./database.mjs";
export { LATEST_MIGRATION, createMigrator, migrateToLatest, migrationStatus } from "./migrate.mjs";

/*
 * Open a database and bring its schema up to date.
 * Single-node mode (role=all) migrates on start; cluster
 * deployments run `brainstem migrate` once instead.
 */
export async function openMigratedDatabase(options = {}) {
  const { openDatabase } = await import("./database.mjs");
  const { migrateToLatest } = await import("./migrate.mjs");
  const handle = await openDatabase(options);

  try {
    await migrateToLatest(handle);
  }
  catch (error) {
    await handle.close();
    throw error;
  }

  return handle;
}
