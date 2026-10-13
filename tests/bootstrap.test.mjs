import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { openRuntimeDatabase } from "../src/runtime/bootstrap.mjs";
import { tempDir } from "./helpers/fixtures.mjs";

test("runtime database imports 1.x checkpoints once on first start", async () => {
  const dir = await tempDir("bootstrap");
  const dataDir = join(dir, "data");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dataDir);
  await writeFile(join(dataDir, "checkpoints.json"), JSON.stringify({ "github-issues": { since: "2026-10-01" } }));

  const config = {
    runtime: {
      database: { url: `sqlite:${join(dir, "brainstem.sqlite")}`, legacyDataDir: dataDir }
    }
  };

  const first = await openRuntimeDatabase(config, { baseDir: dir });
  const rows = await first.db.selectFrom("checkpoints").selectAll().execute();
  assert.deepEqual(rows.map(row => [row.key, JSON.parse(row.value_json)]), [["github-issues", { since: "2026-10-01" }]]);

  await first.db.deleteFrom("checkpoints").execute();
  await first.close();

  // A second start must not re-import over newer state.
  const second = await openRuntimeDatabase(config, { baseDir: dir });
  assert.equal((await second.db.selectFrom("checkpoints").selectAll().execute()).length, 0);
  await second.close();
});

test("legacy import can be disabled", async () => {
  const dir = await tempDir("bootstrap-off");
  await writeFile(join(dir, "checkpoints.json"), JSON.stringify({ a: 1 }));

  const handle = await openRuntimeDatabase({
    runtime: { database: { url: `sqlite:${join(dir, "b.sqlite")}`, legacyDataDir: dir, importLegacy: false } }
  });
  assert.equal((await handle.db.selectFrom("checkpoints").selectAll().execute()).length, 0);
  await handle.close();
});
