/*
 * Per-node totals for the Web UI flow (inputs, the core and
 * destinations, keyed by the flow node id such as
 * "input:app-log", "core" or "destination:log-triage").
 *
 * The event log only keeps a window of recent events, so totals
 * are counted here as events arrive. `last_at` is epoch
 * milliseconds of the newest event for the node.
 */
export function createMigration() {
  return {
    async up(db) {
      await db.schema.createTable("stat_nodes").ifNotExists()
        .addColumn("node_id", "text", col => col.primaryKey())
        .addColumn("polls", "bigint", col => col.notNull().defaultTo(0))
        .addColumn("observations", "bigint", col => col.notNull().defaultTo(0))
        .addColumn("decisions", "bigint", col => col.notNull().defaultTo(0))
        .addColumn("delivered", "bigint", col => col.notNull().defaultTo(0))
        .addColumn("handoffs", "bigint", col => col.notNull().defaultTo(0))
        .addColumn("errors", "bigint", col => col.notNull().defaultTo(0))
        .addColumn("last_at", "bigint", col => col.notNull())
        .execute();
    },

    async down(db) {
      await db.schema.dropTable("stat_nodes").ifExists().execute();
    }
  };
}
