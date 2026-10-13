import { sql } from "kysely";

import { migrateToLatest, migrationStatus } from "../db/migrate.mjs";
import { SCHEMA_TABLES, countRows, insertIgnoringConflicts } from "./tables.mjs";

export const DEFAULT_COPY_BATCH_SIZE = 500;

/*
 * Copy every 2.0 table from one database to another, e.g.
 * SQLite → Postgres when moving a single node into cluster mode.
 *
 * - The source must already be migrated to latest; it is only read.
 * - The target is migrated to latest first.
 * - Refuses when any target table has rows, unless `force` is set
 *   (then conflicting rows are skipped).
 * - Each table is copied in batches inside its own transaction,
 *   parents before children, keeping primary keys and ids.
 * - On Postgres the web_events identity sequence is moved past
 *   the copied ids so new events do not collide.
 *
 * Returns [{ table, read, inserted }].
 */
export async function copyDatabase(source, target, { force = false, batchSize = DEFAULT_COPY_BATCH_SIZE } = {}) {
  const pending = (await migrationStatus(source)).filter(migration => !migration.executedAt);
  if (pending.length > 0) {
    throw new Error(
      `Source database has pending migrations (${pending.map(migration => migration.name).join(", ")}). ` +
      "Run `brainstem migrate --database <from>` first."
    );
  }

  await migrateToLatest(target);

  if (!force) {
    const nonEmpty = [];
    for (const table of SCHEMA_TABLES) {
      const count = await countRows(target.db, table.name);
      if (count > 0) nonEmpty.push(`${table.name} (${count})`);
    }
    if (nonEmpty.length > 0) {
      throw new Error(
        `Target database is not empty: ${nonEmpty.join(", ")}. Use --force to copy anyway (conflicting rows are skipped).`
      );
    }
  }

  const summary = [];

  for (const table of SCHEMA_TABLES) {
    let read = 0;
    let inserted = 0;

    await target.db.transaction().execute(async trx => {
      for (let offset = 0; ; offset += batchSize) {
        let query = source.db.selectFrom(table.name).selectAll();
        for (const column of table.key) query = query.orderBy(column);
        const rows = await query.limit(batchSize).offset(offset).execute();

        if (rows.length === 0) break;
        read += rows.length;
        inserted += await insertIgnoringConflicts(trx, table.name, rows, {
          dialect: target.dialect,
          overrideIdentity: Boolean(table.identity)
        });
        if (rows.length < batchSize) break;
      }

      if (table.identity && target.dialect === "postgres") {
        await resetIdentitySequence(trx, table.name, table.identity);
      }
    });

    summary.push({ table: table.name, read, inserted });
  }

  return summary;
}

/*
 * setval(seq, max(id)) so the next generated id is max + 1;
 * an empty table resets to 1 (is_called = false).
 */
export async function resetIdentitySequence(db, table, column) {
  await sql`
    select setval(
      pg_get_serial_sequence(${table}, ${column}),
      coalesce((select max(${sql.ref(column)}) from ${sql.table(table)}), 1),
      (select max(${sql.ref(column)}) from ${sql.table(table)}) is not null
    )
  `.execute(db);
}
