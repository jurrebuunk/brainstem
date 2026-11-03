/*
 * Multi-core (roadmap Phase 3).
 *
 * `inputs` is the input schedule and its leases (roadmap 4.3,
 * ADR-0002). Each core declares the inputs it loaded; any core
 * claims a due, unleased input by bumping `lease_epoch`, polls it,
 * and commits the checkpoint only while its epoch still holds
 * (fencing). Times the scheduler compares are epoch milliseconds.
 *
 * `config_versions` and `active_config` hold the config as
 * versioned data (roadmap 4.6, ADR-0005). `active_config` has a
 * single row (id 1) pointing at the active version.
 *
 * `cores.config_version` records which config version each core
 * runs, so drift between cores is visible.
 */
export function createMigration({ dialect }) {
  const autoId = dialect === "postgres"
    ? col => col.generatedAlwaysAsIdentity().primaryKey()
    : col => col.primaryKey().autoIncrement();
  const idType = dialect === "postgres" ? "bigint" : "integer";

  return {
    async up(db) {
      await db.schema.createTable("inputs").ifNotExists()
        .addColumn("id", "text", col => col.primaryKey())
        .addColumn("plugin", "text")
        .addColumn("input", "text")
        .addColumn("interval_ms", "bigint", col => col.notNull())
        .addColumn("next_due_at", "bigint", col => col.notNull())
        .addColumn("lease_owner", "text")
        .addColumn("lease_until", "bigint")
        .addColumn("lease_epoch", "bigint", col => col.notNull().defaultTo(0))
        .addColumn("last_poll_at", "text")
        .addColumn("last_error", "text")
        // Last time a core declared this input (stale rows are pruned).
        .addColumn("seen_at", "bigint", col => col.notNull())
        .addColumn("created_at", "text", col => col.notNull())
        .addColumn("updated_at", "text", col => col.notNull())
        .execute();
      await db.schema.createIndex("inputs_due_idx").ifNotExists()
        .on("inputs").column("next_due_at").execute();

      await db.schema.createTable("config_versions").ifNotExists()
        .addColumn("id", idType, autoId)
        .addColumn("created_at", "text", col => col.notNull())
        .addColumn("author", "text")
        .addColumn("comment", "text")
        .addColumn("schema_version", "integer", col => col.notNull())
        .addColumn("spec_json", "text", col => col.notNull())
        .addColumn("hash", "text", col => col.notNull())
        .execute();

      await db.schema.createTable("active_config").ifNotExists()
        .addColumn("id", "integer", col => col.primaryKey())
        .addColumn("version_id", "bigint", col => col.notNull())
        .addColumn("updated_at", "text", col => col.notNull())
        .addColumn("updated_by", "text")
        .execute();

      await db.schema.alterTable("cores")
        .addColumn("config_version", "bigint")
        .execute();
    },

    async down(db) {
      await db.schema.alterTable("cores").dropColumn("config_version").execute();
      await db.schema.dropTable("active_config").ifExists().execute();
      await db.schema.dropTable("config_versions").ifExists().execute();
      await db.schema.dropTable("inputs").ifExists().execute();
    }
  };
}
