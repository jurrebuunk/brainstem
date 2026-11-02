import assert from "node:assert/strict";
import test from "node:test";

import { parseDatabaseUrl } from "../src/db/database.mjs";
import { LATEST_MIGRATION, migrateToLatest, migrationStatus } from "../src/db/migrate.mjs";
import { dialectTest } from "./helpers/database.mjs";

test("database urls parse into dialect settings", () => {
  assert.deepEqual(parseDatabaseUrl("sqlite:data/x.sqlite"), { dialect: "sqlite", path: "data/x.sqlite" });
  assert.deepEqual(parseDatabaseUrl("sqlite:///abs/x.sqlite"), { dialect: "sqlite", path: "/abs/x.sqlite" });
  assert.deepEqual(parseDatabaseUrl("sqlite::memory:"), { dialect: "sqlite", path: ":memory:" });
  assert.equal(parseDatabaseUrl("postgres://u@h/db").dialect, "postgres");
  assert.equal(parseDatabaseUrl("postgresql://u@h/db").dialect, "postgres");
  assert.throws(() => parseDatabaseUrl("mysql://x"), /Unsupported database URL/);
});

dialectTest("migrations apply once and are idempotent", async ({ handle }) => {
  const status = await migrationStatus(handle);
  assert.equal(status.at(-1).name, LATEST_MIGRATION);
  assert.ok(status.every(migration => migration.executedAt));

  assert.deepEqual(await migrateToLatest(handle), []);
});

dialectTest("schema supports upserts, identity ids and json text", async ({ handle }) => {
  const { db } = handle;
  const now = new Date().toISOString();

  await db.insertInto("checkpoints")
    .values({ key: "a", value_json: JSON.stringify({ n: 1 }), updated_at: now })
    .execute();
  await db.insertInto("checkpoints")
    .values({ key: "a", value_json: JSON.stringify({ n: 2 }), updated_at: now })
    .onConflict(oc => oc.column("key").doUpdateSet({ value_json: eb => eb.ref("excluded.value_json") }))
    .execute();

  const row = await db.selectFrom("checkpoints").selectAll().where("key", "=", "a").executeTakeFirstOrThrow();
  assert.deepEqual(JSON.parse(row.value_json), { n: 2 });

  const inserted = await db.insertInto("web_events")
    .values({ received_at: now, kind: "k", event_json: "{}" })
    .returning("id")
    .executeTakeFirstOrThrow();
  assert.equal(typeof inserted.id, "number");

  await db.insertInto("stat_counters").values({ key: "c", value: 1 }).execute();
  await db.updateTable("stat_counters").set(eb => ({ value: eb("value", "+", 41) })).where("key", "=", "c").execute();
  const counter = await db.selectFrom("stat_counters").select("value").where("key", "=", "c").executeTakeFirstOrThrow();
  assert.equal(counter.value, 42);
});

dialectTest("transactions roll back on error", async ({ handle }) => {
  const { db } = handle;

  await assert.rejects(() => db.transaction().execute(async trx => {
    await trx.insertInto("plugin_state")
      .values({ namespace: "n", key: "k", value_json: "1", updated_at: "now" })
      .execute();
    throw new Error("boom");
  }), /boom/);

  const rows = await db.selectFrom("plugin_state").selectAll().execute();
  assert.equal(rows.length, 0);
});
