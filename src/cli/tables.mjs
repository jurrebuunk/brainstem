import { sql } from "kysely";

/*
 * Tables created by 0001_initial, in foreign-key-safe order
 * (parents before children). `identity` marks a column the
 * database generates; Postgres needs OVERRIDING SYSTEM VALUE to
 * accept explicit ids and a sequence reset afterwards.
 */
export const SCHEMA_TABLES = [
  { name: "records", key: ["id"] },
  { name: "checkpoints", key: ["key"] },
  { name: "plugin_state", key: ["namespace", "key"] },
  { name: "web_events", key: ["id"], identity: "id" },
  { name: "stat_counters", key: ["key"] },
  { name: "stat_timeseries", key: ["bucket", "metric"] },
  { name: "auth_users", key: ["id"] },
  { name: "auth_roles", key: ["id"] },
  { name: "auth_user_roles", key: ["user_id", "role_id"] },
  { name: "auth_sessions", key: ["token"] },
  { name: "auth_login_attempts", key: ["key"] },
  { name: "maintenance_runs", key: ["task"] }
];

export async function countRows(db, table) {
  const row = await db.selectFrom(table)
    .select(eb => eb.fn.countAll().as("count"))
    .executeTakeFirst();

  return Number(row?.count ?? 0);
}

/*
 * Insert rows, skipping any that conflict with an existing
 * primary or unique key. Returns the number of rows inserted.
 *
 * Built as raw SQL so explicit identity values can be written
 * on Postgres (`overriding system value`).
 */
export async function insertIgnoringConflicts(db, table, rows, { dialect, overrideIdentity = false } = {}) {
  if (rows.length === 0) return 0;

  const columns = Object.keys(rows[0]);
  const override = overrideIdentity && dialect === "postgres"
    ? sql` overriding system value`
    : sql``;
  const values = sql.join(rows.map(row => sql`(${sql.join(columns.map(column => row[column]))})`));

  const result = await sql`
    insert into ${sql.table(table)} (${sql.join(columns.map(column => sql.ref(column)))})${override}
    values ${values}
    on conflict do nothing
  `.execute(db);

  return Number(result.numAffectedRows ?? 0);
}

export function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function formatSummary(rows) {
  const width = Math.max(0, ...rows.map(row => row.table.length));

  return rows.map(row => `  ${row.table.padEnd(width)}  ${row.text}`).join("\n");
}
