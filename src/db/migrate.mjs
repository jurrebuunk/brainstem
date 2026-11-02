import { Migrator } from "kysely/migration";

import { createMigration as m0001 } from "./migrations/0001_initial.mjs";
import { createMigration as m0002 } from "./migrations/0002_pipeline.mjs";
import { createMigration as m0003 } from "./migrations/0003_cores.mjs";

/*
 * Ordered list of migrations. Append new entries; never edit
 * or reorder applied ones. Each factory receives { dialect }
 * so migrations stay a single portable file.
 */
const MIGRATIONS = [
  ["0001_initial", m0001],
  ["0002_pipeline", m0002],
  ["0003_cores", m0003]
];

export const LATEST_MIGRATION = MIGRATIONS.at(-1)[0];

export function createMigrator(handle, { schema } = {}) {
  return new Migrator({
    db: handle.db,
    migrationTableName: "brainstem_migrations",
    migrationLockTableName: "brainstem_migrations_lock",
    ...((schema ?? handle.schema) ? { migrationTableSchema: schema ?? handle.schema } : {}),
    provider: {
      async getMigrations() {
        return Object.fromEntries(
          MIGRATIONS.map(([name, factory]) => [name, factory({ dialect: handle.dialect })])
        );
      }
    }
  });
}

export async function migrateToLatest(handle) {
  const { error, results = [] } = await createMigrator(handle).migrateToLatest();

  if (error) {
    const failed = results.find(result => result.status === "Error");
    throw new Error(
      `Database migration failed${failed ? ` at ${failed.migrationName}` : ""}: ${error.message ?? error}`,
      { cause: error }
    );
  }

  return results.map(result => ({ name: result.migrationName, status: result.status }));
}

export async function migrationStatus(handle) {
  const migrations = await createMigrator(handle).getMigrations();
  return migrations.map(migration => ({
    name: migration.name,
    executedAt: migration.executedAt ?? null
  }));
}
