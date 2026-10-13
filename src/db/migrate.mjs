import { sql } from "kysely";
import { Migrator } from "kysely/migration";

import { createMigration as m0001 } from "./migrations/0001_initial.mjs";

/*
 * Ordered list of migrations. Append new entries; never edit
 * or reorder applied ones. Each factory receives { dialect }
 * so migrations stay a single portable file.
 */
const MIGRATIONS = [
  ["0001_initial", m0001]
];

export const LATEST_MIGRATION = MIGRATIONS.at(-1)[0];

export function createMigrator(handle, { schema } = {}) {
  return new Migrator({
    db: handle.db,
    migrationTableName: "brainstem_migrations",
    migrationLockTableName: "brainstem_migrations_lock",
    ...(schema ? { migrationTableSchema: schema } : {}),
    provider: {
      async getMigrations() {
        return Object.fromEntries(
          MIGRATIONS.map(([name, factory]) => [name, factory({ dialect: handle.dialect })])
        );
      }
    }
  });
}

/*
 * On Postgres, pin the migration tables to the connection's
 * current schema. Without this Kysely looks for them in every
 * schema and skips creating them when another schema in the same
 * database already has a brainstem_migrations table.
 */
async function migratorFor(handle) {
  if (handle.dialect !== "postgres") return createMigrator(handle);

  const { rows } = await sql`select current_schema() as schema`.execute(handle.db);
  return createMigrator(handle, { schema: rows[0]?.schema ?? undefined });
}

export async function migrateToLatest(handle) {
  const { error, results = [] } = await (await migratorFor(handle)).migrateToLatest();

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
  const migrations = await (await migratorFor(handle)).getMigrations();
  return migrations.map(migration => ({
    name: migration.name,
    executedAt: migration.executedAt ?? null
  }));
}
