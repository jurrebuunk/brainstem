import { sql } from "kysely";

/*
 * Initial 2.0 schema. Portable across SQLite and Postgres:
 * timestamps are ISO-8601 text, JSON is text, booleans are
 * integers. Mirrors the 1.x SQLite tables so data can be
 * imported unchanged.
 */
export function createMigration({ dialect }) {
  const autoId = dialect === "postgres"
    ? col => col.generatedAlwaysAsIdentity().primaryKey()
    : col => col.primaryKey().autoIncrement();
  const idType = dialect === "postgres" ? "bigint" : "integer";

  return {
    async up(db) {
      // Core decision records.
      await db.schema.createTable("records").ifNotExists()
        .addColumn("id", "text", col => col.primaryKey())
        .addColumn("fingerprint", "text", col => col.notNull())
        .addColumn("cache_key", "text", col => col.notNull())
        .addColumn("revision", "integer", col => col.notNull())
        .addColumn("observation_json", "text", col => col.notNull())
        .addColumn("decision_json", "text", col => col.notNull())
        .addColumn("first_seen_at", "text", col => col.notNull())
        .addColumn("last_seen_at", "text", col => col.notNull())
        .addColumn("updated_at", "text", col => col.notNull())
        .execute();
      await db.schema.createIndex("records_last_seen_at_idx").ifNotExists()
        .on("records").column("last_seen_at").execute();

      // Input checkpoints (replaces data/checkpoints.json).
      await db.schema.createTable("checkpoints").ifNotExists()
        .addColumn("key", "text", col => col.primaryKey())
        .addColumn("value_json", "text", col => col.notNull())
        .addColumn("updated_at", "text", col => col.notNull())
        .execute();

      // Durable plugin state (replaces plugin JSON files / module Maps).
      await db.schema.createTable("plugin_state").ifNotExists()
        .addColumn("namespace", "text", col => col.notNull())
        .addColumn("key", "text", col => col.notNull())
        .addColumn("value_json", "text", col => col.notNull())
        .addColumn("updated_at", "text", col => col.notNull())
        .addPrimaryKeyConstraint("plugin_state_pk", ["namespace", "key"])
        .execute();

      // Telemetry.
      await db.schema.createTable("web_events").ifNotExists()
        .addColumn("id", idType, autoId)
        .addColumn("received_at", "text", col => col.notNull())
        .addColumn("kind", "text", col => col.notNull())
        .addColumn("level", "text")
        .addColumn("source", "text")
        .addColumn("event_json", "text", col => col.notNull())
        .execute();
      for (const column of ["received_at", "kind", "level", "source"]) {
        await db.schema.createIndex(`idx_web_events_${column}`).ifNotExists()
          .on("web_events").column(column).execute();
      }

      await db.schema.createTable("stat_counters").ifNotExists()
        .addColumn("key", "text", col => col.primaryKey())
        .addColumn("value", "bigint", col => col.notNull().defaultTo(0))
        .execute();

      await db.schema.createTable("stat_timeseries").ifNotExists()
        .addColumn("bucket", "text", col => col.notNull())
        .addColumn("metric", "text", col => col.notNull())
        .addColumn("value", "bigint", col => col.notNull().defaultTo(0))
        .addPrimaryKeyConstraint("stat_timeseries_pk", ["bucket", "metric"])
        .execute();

      // Auth.
      await db.schema.createTable("auth_users").ifNotExists()
        .addColumn("id", "text", col => col.primaryKey())
        .addColumn("username", "text", col => col.notNull().unique())
        .addColumn("name", "text")
        .addColumn("password_hash", "text", col => col.notNull())
        .addColumn("active", "integer", col => col.notNull().defaultTo(1))
        .addColumn("created_at", "text", col => col.notNull())
        .addColumn("updated_at", "text", col => col.notNull())
        .execute();

      await db.schema.createTable("auth_roles").ifNotExists()
        .addColumn("id", "text", col => col.primaryKey())
        .addColumn("name", "text", col => col.notNull().unique())
        .addColumn("description", "text")
        .addColumn("permissions_json", "text", col => col.notNull())
        .addColumn("system", "integer", col => col.notNull().defaultTo(0))
        .addColumn("created_at", "text", col => col.notNull())
        .addColumn("updated_at", "text", col => col.notNull())
        .execute();

      await db.schema.createTable("auth_user_roles").ifNotExists()
        .addColumn("user_id", "text", col => col.notNull().references("auth_users.id").onDelete("cascade"))
        .addColumn("role_id", "text", col => col.notNull().references("auth_roles.id").onDelete("cascade"))
        .addPrimaryKeyConstraint("auth_user_roles_pk", ["user_id", "role_id"])
        .execute();

      await db.schema.createTable("auth_sessions").ifNotExists()
        .addColumn("token", "text", col => col.primaryKey())
        .addColumn("user_id", "text", col => col.notNull().references("auth_users.id").onDelete("cascade"))
        .addColumn("csrf_token", "text", col => col.notNull())
        .addColumn("expires_at", "text", col => col.notNull())
        .addColumn("created_at", "text", col => col.notNull())
        .addColumn("revoked_at", "text")
        .execute();
      await db.schema.createIndex("auth_sessions_user_idx").ifNotExists()
        .on("auth_sessions").column("user_id").execute();
      await db.schema.createIndex("auth_sessions_expires_idx").ifNotExists()
        .on("auth_sessions").column("expires_at").execute();

      // Login rate limiting shared across API replicas.
      await db.schema.createTable("auth_login_attempts").ifNotExists()
        .addColumn("key", "text", col => col.primaryKey())
        .addColumn("count", "integer", col => col.notNull())
        .addColumn("window_started_at", "text", col => col.notNull())
        .execute();

      // Singleton maintenance bookkeeping (prune runs etc.).
      await db.schema.createTable("maintenance_runs").ifNotExists()
        .addColumn("task", "text", col => col.primaryKey())
        .addColumn("last_run_at", "text", col => col.notNull())
        .execute();

      await sql`select 1`.execute(db);
    },

    async down(db) {
      for (const table of [
        "maintenance_runs", "auth_login_attempts", "auth_sessions", "auth_user_roles",
        "auth_roles", "auth_users", "stat_timeseries", "stat_counters", "web_events",
        "plugin_state", "checkpoints", "records"
      ]) {
        await db.schema.dropTable(table).ifExists().execute();
      }
    }
  };
}
