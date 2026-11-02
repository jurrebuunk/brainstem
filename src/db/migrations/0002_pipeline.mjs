/*
 * Durable pipeline (roadmap Phase 2).
 *
 * `jobs` is the work queue and the transactional outbox: each
 * pipeline stage commits its outputs and the next stage's jobs
 * in one transaction. Times the queue compares (run_at,
 * locked_until) are epoch milliseconds; audit timestamps are
 * ISO-8601 text like the rest of the schema.
 *
 * `deliveries` is the delivery log: one row per (decision,
 * destination) emission, keyed by the idempotency key that is
 * handed to the destination plugin.
 */
export function createMigration({ dialect }) {
  const autoId = dialect === "postgres"
    ? col => col.generatedAlwaysAsIdentity().primaryKey()
    : col => col.primaryKey().autoIncrement();
  const idType = dialect === "postgres" ? "bigint" : "integer";

  return {
    async up(db) {
      await db.schema.createTable("jobs").ifNotExists()
        .addColumn("id", idType, autoId)
        .addColumn("queue", "text", col => col.notNull())
        // Dedupe: at most one job per key.
        .addColumn("job_key", "text", col => col.unique())
        // Serialization: jobs sharing a key run one at a time, in id order.
        .addColumn("queue_key", "text")
        .addColumn("payload_json", "text", col => col.notNull())
        // ready | running | dead
        .addColumn("state", "text", col => col.notNull())
        .addColumn("attempts", "integer", col => col.notNull().defaultTo(0))
        .addColumn("max_attempts", "integer", col => col.notNull())
        .addColumn("run_at", "bigint", col => col.notNull())
        .addColumn("locked_by", "text")
        .addColumn("locked_until", "bigint")
        .addColumn("last_error", "text")
        .addColumn("created_at", "text", col => col.notNull())
        .addColumn("updated_at", "text", col => col.notNull())
        .execute();
      await db.schema.createIndex("jobs_claim_idx").ifNotExists()
        .on("jobs").columns(["state", "queue", "run_at"]).execute();
      await db.schema.createIndex("jobs_queue_key_idx").ifNotExists()
        .on("jobs").columns(["queue_key", "id"]).execute();

      await db.schema.createTable("deliveries").ifNotExists()
        .addColumn("key", "text", col => col.primaryKey())
        .addColumn("observation_id", "text", col => col.notNull())
        .addColumn("revision", "integer", col => col.notNull())
        .addColumn("destination", "text", col => col.notNull())
        .addColumn("plugin", "text", col => col.notNull())
        .addColumn("decision", "text", col => col.notNull())
        // pending | failed | delivered | dead | discarded
        .addColumn("status", "text", col => col.notNull())
        .addColumn("attempts", "integer", col => col.notNull().defaultTo(0))
        .addColumn("last_error", "text")
        .addColumn("output_json", "text", col => col.notNull())
        .addColumn("created_at", "text", col => col.notNull())
        .addColumn("updated_at", "text", col => col.notNull())
        .addColumn("delivered_at", "text")
        .execute();
      await db.schema.createIndex("deliveries_status_idx").ifNotExists()
        .on("deliveries").columns(["status", "updated_at"]).execute();
      await db.schema.createIndex("deliveries_observation_idx").ifNotExists()
        .on("deliveries").column("observation_id").execute();
    },

    async down(db) {
      await db.schema.dropTable("deliveries").ifExists().execute();
      await db.schema.dropTable("jobs").ifExists().execute();
    }
  };
}
