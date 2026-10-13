import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { copyDatabase } from "../src/cli/copy.mjs";
import { importV1 } from "../src/cli/import-v1.mjs";
import { SCHEMA_TABLES, countRows } from "../src/cli/tables.mjs";
import { openDatabase } from "../src/db/database.mjs";
import { LATEST_MIGRATION, migrationStatus } from "../src/db/migrate.mjs";
import { DIALECTS, TEST_PG_URL, isolatedDatabaseUrl } from "./helpers/database.mjs";
import { tempDir } from "./helpers/fixtures.mjs";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// 1.x DDL, copied from src/core/record-stores.mjs,
// src/backend/telemetry-store.mjs and src/backend/auth-store.mjs.
const LEGACY_RECORDS_DDL = `
  CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    revision INTEGER NOT NULL,
    observation_json TEXT NOT NULL,
    decision_json TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS records_last_seen_at_idx ON records (last_seen_at);
`;

const LEGACY_TELEMETRY_DDL = `
  pragma foreign_keys = on;
  create table if not exists web_events (
    id integer primary key autoincrement,
    received_at text not null,
    kind text not null,
    level text,
    source text,
    event_json text not null
  );
  create index if not exists idx_web_events_received_at on web_events (received_at);
  create table if not exists stat_counters (key text primary key, value integer not null default 0);
  create table if not exists stat_timeseries (
    bucket text not null, metric text not null, value integer not null default 0,
    primary key (bucket, metric)
  );
  create table if not exists auth_users (
    id text primary key, username text not null unique, name text, password_hash text not null,
    active integer not null default 1, created_at text not null, updated_at text not null
  );
  create table if not exists auth_roles (
    id text primary key, name text not null unique, description text, permissions_json text not null,
    system integer not null default 0, created_at text not null, updated_at text not null
  );
  create table if not exists auth_user_roles (
    user_id text not null references auth_users(id) on delete cascade,
    role_id text not null references auth_roles(id) on delete cascade,
    primary key (user_id, role_id)
  );
  create table if not exists auth_sessions (
    token text primary key, user_id text not null references auth_users(id) on delete cascade,
    csrf_token text not null, expires_at text not null, created_at text not null, revoked_at text
  );
`;

const T = "2026-09-01T00:00:00.000Z";

async function createLegacyDataDir() {
  const dir = await tempDir("v1");

  const records = new DatabaseSync(join(dir, "brainstem.sqlite"));
  records.exec("PRAGMA journal_mode = WAL;");
  records.exec(LEGACY_RECORDS_DDL);
  const insertRecord = records.prepare("insert into records values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (let index = 0; index < 3; index += 1) {
    insertRecord.run(`obs-${index}`, `fp-${index}`, "ck", index + 1, `{"id":"obs-${index}"}`, `{"action":"ignore"}`, T, T, T);
  }
  records.close();

  const telemetry = new DatabaseSync(join(dir, "web-stats.sqlite"));
  telemetry.exec(LEGACY_TELEMETRY_DDL);
  const insertEvent = telemetry.prepare("insert into web_events (received_at, kind, level, source, event_json) values (?, ?, ?, ?, ?)");
  for (let index = 0; index < 5; index += 1) {
    insertEvent.run(T, "decision", index % 2 ? "info" : null, "core", JSON.stringify({ n: index }));
  }
  telemetry.exec(`
    insert into stat_counters values ('decisions', 42), ('observations', 7);
    insert into stat_timeseries values ('2026-09-01T00', 'decisions', 3), ('2026-09-01T01', 'decisions', 4);
    insert into auth_users values ('u1', 'admin', 'Admin', 'hash', 1, '${T}', '${T}');
    insert into auth_users values ('u2', 'viewer', null, 'hash2', 0, '${T}', '${T}');
    insert into auth_roles values ('r1', 'admin', 'Administrators', '["*"]', 1, '${T}', '${T}');
    insert into auth_roles values ('r2', 'viewer', null, '["read"]', 1, '${T}', '${T}');
    insert into auth_user_roles values ('u1', 'r1'), ('u2', 'r2');
    insert into auth_sessions values ('tok', 'u1', 'csrf', '2099-01-01T00:00:00.000Z', '${T}', null);
  `);
  telemetry.close();

  await writeFile(join(dir, "checkpoints.json"), JSON.stringify({
    "chat:messages": { lastSeenAt: "2026-09-22T08:30:00Z" },
    "email:inbox": 1234,
    "log:tail": [1, "two", null]
  }, null, 2));

  return dir;
}

const EXPECTED_IMPORT = {
  records: 3,
  web_events: 5,
  stat_counters: 2,
  stat_timeseries: 2,
  auth_users: 2,
  auth_roles: 2,
  auth_user_roles: 2,
  auth_sessions: 1,
  checkpoints: 3
};

async function hashFiles(dir) {
  const hashes = {};
  for (const name of ["brainstem.sqlite", "web-stats.sqlite", "checkpoints.json"]) {
    hashes[name] = createHash("sha256").update(await readFile(join(dir, name))).digest("hex");
  }
  return hashes;
}

async function tableCounts(db) {
  const counts = {};
  for (const table of SCHEMA_TABLES) counts[table.name] = await countRows(db, table.name);
  return counts;
}

function byTable(summary) {
  return Object.fromEntries(summary.map(entry => [entry.table, entry]));
}

async function runBrainstem(args, options = {}) {
  const env = { ...process.env, ...options.env };
  if (!options.env?.BRAINSTEM_DATABASE_URL) delete env.BRAINSTEM_DATABASE_URL;

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["brainstem.mjs", ...args], { cwd: ROOT, env });
    return { code: 0, stdout, stderr };
  }
  catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function withIsolatedDatabase(dialect, fn) {
  const isolated = await isolatedDatabaseUrl(dialect);
  try {
    return await fn(isolated.url);
  }
  finally {
    await isolated.drop();
  }
}

for (const dialect of DIALECTS) {
  test(`[${dialect}] import-v1 imports all 1.x state and is idempotent`, async () => {
    const dataDir = await createLegacyDataDir();
    const before = await hashFiles(dataDir);

    await withIsolatedDatabase(dialect, async url => {
      const handle = await openDatabase({ url });
      try {
        const first = byTable(await importV1(handle, { dataDir }));
        for (const [table, count] of Object.entries(EXPECTED_IMPORT)) {
          assert.equal(first[table].read, count, `${table} read`);
          assert.equal(first[table].inserted, count, `${table} inserted`);
        }

        const { db } = handle;
        const record = await db.selectFrom("records").selectAll().where("id", "=", "obs-1").executeTakeFirstOrThrow();
        assert.equal(record.revision, 2);
        assert.equal(record.observation_json, `{"id":"obs-1"}`);

        const checkpoint = await db.selectFrom("checkpoints").selectAll().where("key", "=", "chat:messages").executeTakeFirstOrThrow();
        assert.deepEqual(JSON.parse(checkpoint.value_json), { lastSeenAt: "2026-09-22T08:30:00Z" });
        const tail = await db.selectFrom("checkpoints").select("value_json").where("key", "=", "log:tail").executeTakeFirstOrThrow();
        assert.deepEqual(JSON.parse(tail.value_json), [1, "two", null]);

        const counter = await db.selectFrom("stat_counters").select("value").where("key", "=", "decisions").executeTakeFirstOrThrow();
        assert.equal(counter.value, 42);

        const events = await db.selectFrom("web_events").selectAll().orderBy("id").execute();
        assert.deepEqual(events.map(event => JSON.parse(event.event_json).n), [0, 1, 2, 3, 4]);
        assert.equal(events[0].level, null);

        const session = await db.selectFrom("auth_sessions").selectAll().executeTakeFirstOrThrow();
        assert.equal(session.user_id, "u1");
        assert.equal(session.revoked_at, null);

        const countsAfterFirst = await tableCounts(db);

        const second = byTable(await importV1(handle, { dataDir }));
        for (const table of Object.keys(EXPECTED_IMPORT)) {
          assert.equal(second[table].inserted, 0, `${table} re-run inserts nothing`);
        }
        assert.match(second.web_events.note, /already imported/);
        assert.deepEqual(await tableCounts(db), countsAfterFirst);
      }
      finally {
        await handle.close();
      }
    });

    assert.deepEqual(await hashFiles(dataDir), before, "legacy files are not modified");
  });

  test(`[${dialect}] import-v1 maps roles seeded by 2.0 by name`, async () => {
    const dataDir = await createLegacyDataDir();

    await withIsolatedDatabase(dialect, async url => {
      const handle = await openDatabase({ url });
      try {
        const { migrateToLatest } = await import("../src/db/migrate.mjs");
        await migrateToLatest(handle);
        await handle.db.insertInto("auth_roles")
          .values({ id: "new-admin", name: "admin", description: null, permissions_json: "[\"*\"]", system: 1, created_at: T, updated_at: T })
          .execute();

        const summary = byTable(await importV1(handle, { dataDir }));
        assert.equal(summary.auth_roles.inserted, 1);
        assert.equal(summary.auth_user_roles.inserted, 2);

        const roles = await handle.db.selectFrom("auth_user_roles").selectAll().where("user_id", "=", "u1").execute();
        assert.deepEqual(roles.map(row => ({ ...row })), [{ user_id: "u1", role_id: "new-admin" }]);
      }
      finally {
        await handle.close();
      }
    });
  });
}

test("import-v1 upgrades a 1.x brainstem.sqlite in place", async () => {
  const dataDir = await createLegacyDataDir();
  const recordsPath = join(dataDir, "brainstem.sqlite");

  const result = await runBrainstem(["migrate", "import-v1", "--data-dir", dataDir, "--database", `sqlite:${recordsPath}`]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /records\s+0 read, 0 inserted \(already in target database/);
  assert.match(result.stdout, /web_events\s+5 read, 5 inserted/);
  assert.match(result.stdout, /checkpoints\s+3 read, 3 inserted/);

  const handle = await openDatabase({ url: `sqlite:${recordsPath}` });
  try {
    const status = await migrationStatus(handle);
    assert.equal(status.at(-1).name, LATEST_MIGRATION);
    assert.ok(status.every(migration => migration.executedAt));

    const counts = await tableCounts(handle.db);
    assert.equal(counts.records, 3);
    assert.equal(counts.web_events, 5);
    assert.equal(counts.auth_users, 2);

    // 2.0 writes still work against the upgraded file.
    await handle.db.insertInto("records")
      .values({ id: "obs-new", fingerprint: "f", cache_key: "c", revision: 1, observation_json: "{}", decision_json: "{}", first_seen_at: T, last_seen_at: T, updated_at: T })
      .execute();
    assert.equal(await countRows(handle.db, "records"), 4);
  }
  finally {
    await handle.close();
  }
});

test("plain migrate upgrades a 1.x brainstem.sqlite in place", async () => {
  const dataDir = await createLegacyDataDir();
  const recordsPath = join(dataDir, "brainstem.sqlite");

  const first = await runBrainstem(["migrate"], { env: { BRAINSTEM_DATABASE_URL: `sqlite:${recordsPath}` } });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /applied 0001_initial/);

  const again = await runBrainstem(["migrate", "--database", `sqlite:${recordsPath}`]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /up to date/);

  const status = await runBrainstem(["migrate", "status", "--database", `sqlite:${recordsPath}`]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /0001_initial\s+applied/);

  const legacy = new DatabaseSync(recordsPath, { readOnly: true });
  assert.equal(legacy.prepare("select count(*) as n from records").get().n, 3);
  legacy.close();
});

test("migrate exits non-zero on failure and bad usage", async () => {
  const unreachable = await runBrainstem(["migrate", "--database", "postgres://nobody@127.0.0.1:1/none"]);
  assert.equal(unreachable.code, 1);
  assert.match(unreachable.stderr, /migrate failed/);

  const unknown = await runBrainstem(["migrate", "sideways"]);
  assert.equal(unknown.code, 2);

  const missing = await runBrainstem(["migrate", "copy", "--from", "sqlite:/nonexistent/x.sqlite"]);
  assert.equal(missing.code, 2);

  const noSource = await runBrainstem(["migrate", "copy", "--from", "sqlite:/nonexistent/x.sqlite", "--to", "sqlite::memory:"]);
  assert.equal(noSource.code, 1);
  assert.match(noSource.stderr, /Source database not found/);
});

async function importedSqlite() {
  const dataDir = await createLegacyDataDir();
  const url = `sqlite:${join(await tempDir("copy-src"), "brainstem.sqlite")}`;
  const handle = await openDatabase({ url });
  await importV1(handle, { dataDir });
  // Leave a gap in web_events ids, as pruning does.
  await handle.db.deleteFrom("web_events").where("id", "=", 2).execute();
  await handle.db.insertInto("plugin_state").values({ namespace: "matrix", key: "k", value_json: "1", updated_at: T }).execute();
  return handle;
}

for (const dialect of DIALECTS) {
  test(`[${dialect}] migrate copy copies all tables from sqlite`, async () => {
    const source = await importedSqlite();

    try {
      await withIsolatedDatabase(dialect, async url => {
        const target = await openDatabase({ url });
        try {
          const expected = await tableCounts(source.db);
          const summary = byTable(await copyDatabase(source, target, { batchSize: 2 }));

          for (const table of SCHEMA_TABLES) {
            assert.equal(summary[table.name].inserted, expected[table.name], table.name);
          }
          assert.deepEqual(await tableCounts(target.db), expected);

          const sourceEvents = await source.db.selectFrom("web_events").selectAll().orderBy("id").execute();
          const targetEvents = await target.db.selectFrom("web_events").selectAll().orderBy("id").execute();
          assert.deepEqual(targetEvents.map(row => ({ ...row })), sourceEvents.map(row => ({ ...row })));

          // New events continue after the copied ids.
          const inserted = await target.db.insertInto("web_events")
            .values({ received_at: T, kind: "k", event_json: "{}" })
            .returning("id")
            .executeTakeFirstOrThrow();
          assert.equal(inserted.id, Math.max(...sourceEvents.map(event => event.id)) + 1);

          // Non-empty target is refused without --force, allowed with it.
          await assert.rejects(() => copyDatabase(source, target), /not empty/);
          const forced = byTable(await copyDatabase(source, target, { force: true }));
          assert.equal(forced.records.inserted, 0);
          assert.equal(forced.records.read, expected.records);
        }
        finally {
          await target.close();
        }
      });
    }
    finally {
      await source.close();
    }
  });
}

test("migrate copy refuses a source with pending migrations", async () => {
  const source = await openDatabase({ url: `sqlite:${join(await tempDir("copy-empty"), "x.sqlite")}` });
  const target = await openDatabase({ url: "sqlite::memory:" });
  try {
    await assert.rejects(() => copyDatabase(source, target), /pending migrations/);
  }
  finally {
    await source.close();
    await target.close();
  }
});

test("migrate sqlite-to-pg via the CLI", { skip: !TEST_PG_URL && "BRAINSTEM_TEST_PG_URL not set" }, async () => {
  const source = await importedSqlite();
  const sourceUrl = source.url;
  const expected = await tableCounts(source.db);
  await source.close();

  await withIsolatedDatabase("postgres", async url => {
    const result = await runBrainstem(["migrate", "sqlite-to-pg", "--from", sourceUrl, "--to", url]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`web_events\\s+${expected.web_events} copied`));
    assert.match(result.stdout, new RegExp(`records\\s+${expected.records} copied`));

    const refused = await runBrainstem(["migrate", "copy", "--from", sourceUrl, "--to", url]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /not empty/);
  });
});
