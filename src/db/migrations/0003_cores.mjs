/*
 * Core registry (roadmap 4.7, Phase 3 groundwork).
 *
 * One row per runtime process ("core"). A core registers on
 * start, refreshes `last_seen_at` on every heartbeat and marks
 * itself stopped on a clean shutdown. A core that stops
 * heartbeating without stopping is "lost".
 *
 * `topology_json` is the structure the core actually loaded
 * (inputs and destinations with resolved ids and plugin names),
 * so the API can serve the topology without executing config
 * files. `last_seen_at` is epoch milliseconds, like the queue
 * times; audit timestamps are ISO-8601 text.
 */
export function createMigration() {
  return {
    async up(db) {
      await db.schema.createTable("cores").ifNotExists()
        .addColumn("id", "text", col => col.primaryKey())
        .addColumn("role", "text", col => col.notNull())
        .addColumn("queues_json", "text", col => col.notNull())
        .addColumn("version", "text")
        .addColumn("hostname", "text")
        .addColumn("pid", "integer")
        // running | stopped (lost is derived from last_seen_at)
        .addColumn("status", "text", col => col.notNull())
        .addColumn("heartbeat_ms", "integer", col => col.notNull())
        .addColumn("started_at", "text", col => col.notNull())
        .addColumn("last_seen_at", "bigint", col => col.notNull())
        .addColumn("stopped_at", "text")
        .addColumn("topology_json", "text", col => col.notNull())
        .addColumn("topology_hash", "text", col => col.notNull())
        .execute();
      await db.schema.createIndex("cores_last_seen_idx").ifNotExists()
        .on("cores").column("last_seen_at").execute();
    },

    async down(db) {
      await db.schema.dropTable("cores").ifExists().execute();
    }
  };
}
