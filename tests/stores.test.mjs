import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Brainstem, createObservation } from "../src/core/brainstem.mjs";
import {
  DatabaseRecordStore,
  MemoryRecordStore,
  RecordConflictError,
  SqliteRecordStore
} from "../src/core/record-stores.mjs";
import {
  DatabaseCheckpointStore,
  MemoryCheckpointStore
} from "../src/runtime/checkpoints.mjs";
import { BrainstemRuntime } from "../src/runtime/runtime.mjs";
import {
  createCheckpointStore,
  createRecordStore
} from "../src/runtime/stores.mjs";
import { dialectTest } from "./helpers/database.mjs";
import {
  countingInputSource,
  fakeBrainstem,
  minimalPolicyConfig,
  silentLogger,
  tempDir,
  writePlugin
} from "./helpers/fixtures.mjs";

function record(id, overrides = {}) {
  const now = new Date().toISOString();
  return {
    id,
    fingerprint: "f1",
    cache_key: "c1",
    revision: 1,
    observation: { payload: { id } },
    decision: { payload: { observation_id: id, revision: overrides.revision ?? 1 } },
    first_seen_at: now,
    last_seen_at: now,
    updated_at: now,
    ...overrides
  };
}

function fakeLaya(counter = { count: 0 }, onAsk) {
  return {
    async systemOne(state, questions) {
      counter.count += 1;
      await onAsk?.(state, counter.count);
      const name = Object.keys(questions)[0];
      const answer = name === "route"
        ? { choice: "coding", probabilities: { coding: 1 } }
        : name === "severity"
          ? { score: 2 }
          : { noul: 0.9 };
      return { answers: { [name]: answer } };
    },
    async close() {}
  };
}

function observation(state, id = "cas:test:1") {
  return createObservation({
    id,
    source: { type: "test", name: "cas" },
    type: "status",
    state,
    title: `State ${state}`,
    message: `Observation is ${state}`
  });
}

/*
 * Record stores.
 */

dialectTest("database record store round-trips, touches and prunes", async ({ handle }) => {
  const store = new DatabaseRecordStore({ database: handle });

  assert.equal(await store.get("missing"), null);

  const first = record("a", { first_seen_at: "2020-01-01T00:00:00.000Z" });
  await store.put(first);
  assert.deepEqual(await store.get("a"), first);

  // Upsert keeps first_seen_at of the original row.
  await store.put(record("a", { revision: 2, fingerprint: "f2" }));
  const updated = await store.get("a");
  assert.equal(updated.revision, 2);
  assert.equal(updated.fingerprint, "f2");
  assert.equal(updated.first_seen_at, "2020-01-01T00:00:00.000Z");

  await store.touch("a", { observation: { touched: true }, lastSeenAt: "2030-01-01T00:00:00.000Z" });
  const touched = await store.get("a");
  assert.deepEqual(touched.observation, { touched: true });
  assert.equal(touched.last_seen_at, "2030-01-01T00:00:00.000Z");
  assert.equal(touched.revision, 2);

  await store.put(record("old", { last_seen_at: "2000-01-01T00:00:00.000Z" }));
  assert.equal(await store.prune({ olderThan: "2010-01-01T00:00:00.000Z" }), 1);
  assert.equal(await store.get("old"), null);
  assert.ok(await store.get("a"));

  await store.close();
  // The store does not own the injected handle.
  await handle.db.selectFrom("records").select("id").execute();
});

dialectTest("database record store rejects writes on a revision conflict", async ({ handle }) => {
  const store = new DatabaseRecordStore({ database: handle });

  await store.put(record("r"), { expectedRevision: null });

  // Must not exist yet.
  await assert.rejects(
    () => store.put(record("r"), { expectedRevision: null }),
    RecordConflictError
  );

  // Stale expected revision.
  await assert.rejects(
    () => store.put(record("r", { revision: 3 }), { expectedRevision: 2 }),
    error => error instanceof RecordConflictError && error.id === "r" && error.expectedRevision === 2
  );
  assert.equal((await store.get("r")).revision, 1);

  // Matching expected revision.
  await store.put(record("r", { revision: 2, fingerprint: "f2" }), { expectedRevision: 1 });
  assert.equal((await store.get("r")).revision, 2);

  // Two writers racing from the same revision: exactly one wins.
  const results = await Promise.allSettled([
    store.put(record("r", { revision: 3, fingerprint: "x" }), { expectedRevision: 2 }),
    store.put(record("r", { revision: 3, fingerprint: "y" }), { expectedRevision: 2 })
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.ok(results.find(result => result.status === "rejected").reason instanceof RecordConflictError);

  await store.close();
});

test("memory record store applies the same revision rules", async () => {
  const store = new MemoryRecordStore();

  await store.put(record("m"), { expectedRevision: null });
  await assert.rejects(() => store.put(record("m"), { expectedRevision: null }), RecordConflictError);
  await assert.rejects(() => store.put(record("m", { revision: 2 }), { expectedRevision: 5 }), RecordConflictError);
  await store.put(record("m", { revision: 2 }), { expectedRevision: 1 });
  assert.equal((await store.get("m")).revision, 2);
});

dialectTest("database record store prunes periodically", async ({ handle }) => {
  const store = new DatabaseRecordStore({
    database: handle,
    pruneAfterDays: 1,
    pruneIntervalMs: 20
  });

  await store.open();
  await store.put(record("stale", { last_seen_at: "2000-01-01T00:00:00.000Z" }));
  assert.ok(await store.get("stale"));

  const deadline = Date.now() + 3_000;
  while (await store.get("stale")) {
    assert.ok(Date.now() < deadline, "stale record was not pruned by the timer");
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  await store.close();
  assert.equal(store.pruneTimer, null);
});

dialectTest("two cores on one database: a conflicting write is re-read and retried", async ({ handle }) => {
  const other = new DatabaseRecordStore({ database: handle });
  const core = new Brainstem(minimalPolicyConfig, {
    store: new DatabaseRecordStore({ database: handle })
  });

  core.laya = fakeLaya();
  const first = await core.process(observation("open"));
  assert.equal(first.payload.revision, 1);

  // While this core evaluates, "another core" stores revision 2.
  core.laya = fakeLaya({ count: 0 }, async (_state, count) => {
    if (count === 1) {
      await other.put(
        record("cas:test:1", { revision: 2, fingerprint: "someone-else" }),
        { expectedRevision: 1 }
      );
    }
  });

  const decision = await core.process(observation("closed"));
  assert.equal(decision.payload.revision, 3);

  const stored = await core.getRecord("cas:test:1");
  assert.equal(stored.revision, 3);
  assert.equal(stored.observation.payload.state, "closed");
  assert.deepEqual(stored.decision, decision);

  await core.close();
});

dialectTest("two cores on one database: an identical concurrent decision is adopted", async ({ handle }) => {
  const a = new Brainstem(minimalPolicyConfig, { store: new DatabaseRecordStore({ database: handle }) });
  const b = new Brainstem(minimalPolicyConfig, { store: new DatabaseRecordStore({ database: handle }) });
  let fromB = null;

  b.laya = fakeLaya();
  a.laya = fakeLaya({ count: 0 }, async (_state, count) => {
    if (count === 1) {
      fromB = await b.process(observation("open", "cas:test:2"));
    }
  });

  const fromA = await a.process(observation("open", "cas:test:2"));

  assert.deepEqual(fromA, fromB);
  assert.equal((await a.getRecord("cas:test:2")).revision, 1);

  await a.close();
  await b.close();
});

test("core raises the conflict after repeated failed writes", async () => {
  class AlwaysConflicting extends MemoryRecordStore {
    async put(value, { expectedRevision } = {}) {
      this.attempts = (this.attempts ?? 0) + 1;
      throw new RecordConflictError(value.id, expectedRevision);
    }
  }

  const store = new AlwaysConflicting();
  const core = new Brainstem(minimalPolicyConfig, { store });
  core.laya = fakeLaya();

  await assert.rejects(() => core.process(observation("open")), RecordConflictError);
  assert.equal(store.attempts, 3);

  await core.close();
});

test("sqlite record store reuses a 1.x records file", async () => {
  const dir = await tempDir("legacy-records");
  const path = join(dir, "records.sqlite");
  const legacy = new DatabaseSync(path);

  legacy.exec(`
    CREATE TABLE records (
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
  `);
  legacy.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "legacy:1", "f", "c", 4, "{\"o\":1}", "{\"d\":1}", "2024-01-01", "2024-01-02", "2024-01-02"
  );
  legacy.close();

  const store = new SqliteRecordStore({ path });
  const loaded = await store.get("legacy:1");

  assert.equal(loaded.revision, 4);
  assert.deepEqual(loaded.decision, { d: 1 });
  assert.equal(store.path, path);

  await store.close();
});

/*
 * Checkpoint stores.
 */

dialectTest("database checkpoint store round-trips JSON values", async ({ handle }) => {
  const store = new DatabaseCheckpointStore({ database: handle });

  assert.equal(await store.get("a"), undefined);

  await store.set("a", { count: 1, nested: [1, "two", null, true] });
  assert.deepEqual(await store.get("a"), { count: 1, nested: [1, "two", null, true] });

  await store.set("a", { count: 2 });
  assert.deepEqual(await store.get("a"), { count: 2 });

  await store.set("a", null);
  assert.equal(await store.get("a"), undefined);

  await assert.rejects(() => store.set("a", undefined), /cannot be undefined/);
  await assert.rejects(() => store.set("a", new Date()), /plain JSON/);

  await store.close();
});

dialectTest("two database checkpoint stores see each other's writes", async ({ handle }) => {
  const first = new DatabaseCheckpointStore({ database: handle });
  const second = new DatabaseCheckpointStore({ database: handle });

  assert.equal(await second.get("shared"), undefined);

  await first.set("shared", { count: 1 });
  assert.deepEqual(await second.get("shared"), { count: 1 });

  await second.set("shared", { count: 2 });
  assert.deepEqual(await first.get("shared"), { count: 2 });

  await first.set("shared", null);
  assert.equal(await second.get("shared"), undefined);

  await first.close();
  await second.close();
});

dialectTest("database checkpoint store imports a legacy JSON file once", async ({ handle }) => {
  const dir = await tempDir("legacy-checkpoints");
  const legacyJsonPath = join(dir, "checkpoints.json");

  await writeFile(legacyJsonPath, JSON.stringify({
    "input.a": { count: 7 },
    "input.b": "cursor-123",
    "input.gone": null
  }));

  const store = new DatabaseCheckpointStore({ database: handle, legacyJsonPath });

  assert.deepEqual(await store.get("input.a"), { count: 7 });
  assert.equal(await store.get("input.b"), "cursor-123");
  assert.equal(await store.get("input.gone"), undefined);
  assert.equal(store.imported, 2);

  await store.set("input.a", { count: 8 });
  await store.close();

  // The table is no longer empty: the file is not imported again.
  const again = new DatabaseCheckpointStore({ database: handle, legacyJsonPath });
  assert.deepEqual(await again.get("input.a"), { count: 8 });
  assert.equal(again.imported, 0);
  await again.close();

  // The legacy file itself is left untouched.
  assert.deepEqual(JSON.parse(await readFile(legacyJsonPath, "utf8"))["input.a"], { count: 7 });
});

dialectTest("database checkpoint store ignores a missing legacy file", async ({ handle }) => {
  const dir = await tempDir("legacy-missing");
  const store = new DatabaseCheckpointStore({
    database: handle,
    legacyJsonPath: join(dir, "nope.json")
  });

  assert.equal(await store.get("x"), undefined);
  assert.equal(store.imported, 0);
  await store.close();
});

/*
 * Runtime store construction.
 */

test("store factories default to the database and keep explicit types", async () => {
  const dir = await tempDir("store-factories");
  const config = { runtime: { database: { url: `sqlite:${join(dir, "db.sqlite")}` } } };

  const records = createRecordStore(config, dir);
  const checkpoints = createCheckpointStore(config, dir);

  assert.ok(records instanceof DatabaseRecordStore);
  assert.ok(checkpoints instanceof DatabaseCheckpointStore);

  await checkpoints.set("k", { v: 1 });
  assert.deepEqual(await checkpoints.get("k"), { v: 1 });
  await records.put(record("x"));
  assert.equal((await records.get("x")).id, "x");

  await records.close();
  await checkpoints.close();

  assert.ok(existsSync(join(dir, "db.sqlite")));
  assert.ok(createRecordStore({ runtime: { records: { type: "memory" } } }, dir) instanceof MemoryRecordStore);
  assert.ok(createRecordStore({ runtime: { records: false } }, dir) instanceof MemoryRecordStore);
  assert.ok(createCheckpointStore({ runtime: { checkpoints: false } }, dir) instanceof MemoryCheckpointStore);
  assert.ok(
    createRecordStore({ runtime: { records: { type: "sqlite", path: "r.sqlite" } } }, dir) instanceof SqliteRecordStore
  );
  assert.throws(() => createRecordStore({ runtime: { records: { type: "nope" } } }, dir), /Unsupported/);
});

test("runtime database path resolves relative to baseDir", async () => {
  const dir = await tempDir("store-basedir");
  const store = createCheckpointStore({ runtime: { database: { path: "data/x.sqlite" } } }, dir);

  await store.set("k", 1);
  await store.close();

  assert.ok(existsSync(join(dir, "data", "x.sqlite")));
});

function runtimeWithCounter({ dir, inputPath, config, database }) {
  return new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: {
      ...minimalPolicyConfig,
      runtime: {
        retry: { attempts: 1, minDelayMs: 0, maxDelayMs: 0, factor: 1 },
        ...config
      }
    },
    baseDir: dir,
    database,
    logger: silentLogger,
    plugins: [{ id: "counter", module: inputPath }]
  });
}

dialectTest("runtime shares an injected database handle and leaves it open", async ({ handle }) => {
  const dir = await tempDir("runtime-injected-db");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource());

  for (let run = 0; run < 2; run += 1) {
    const runtime = runtimeWithCounter({ dir, inputPath, config: {}, database: handle });
    assert.ok(runtime.checkpointStore instanceof DatabaseCheckpointStore);
    await runtime.runOnce();
  }

  // Still usable: the runtime did not close the handle it did not open.
  const checkpoints = new DatabaseCheckpointStore({ database: handle });
  assert.deepEqual(await checkpoints.get("counter"), { count: 2 });
  assert.equal(existsSync(join(dir, "data")), false);
});

dialectTest("runtime opens and closes its own handle from runtime.database.url", async ({ handle }) => {
  const dir = await tempDir("runtime-own-db");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource());
  const runtime = runtimeWithCounter({
    dir,
    inputPath,
    config: { database: { url: handle.url } }
  });

  await runtime.runOnce();

  assert.equal(runtime.database.owned, true);
  await assert.rejects(() => runtime.database.get(), /closed/);

  const checkpoints = new DatabaseCheckpointStore({ database: handle });
  assert.deepEqual(await checkpoints.get("counter"), { count: 1 });
});

dialectTest("runtime core records use the database by default", async ({ handle }) => {
  const runtime = new BrainstemRuntime({
    config: minimalPolicyConfig,
    database: handle,
    logger: silentLogger
  });

  assert.ok(runtime.recordStore instanceof DatabaseRecordStore);
  assert.equal(runtime.brainstem.records, runtime.recordStore);

  runtime.brainstem.laya = fakeLaya();
  const decision = await runtime.brainstem.process(observation("open", "runtime:db:1"));
  await runtime.brainstem.close();

  const stored = await new DatabaseRecordStore({ database: handle }).get("runtime:db:1");
  assert.equal(stored.revision, decision.payload.revision);
});
