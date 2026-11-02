/*
 * One Brainstem core process for the multi-core acceptance tests.
 *
 *   node core.mjs <shared-dir> <core-name>
 *
 * Polls a counting input and records every delivery as
 * "<core-name> <observation id>" in <shared-dir>/deliveries.log.
 * All cores share one database: CORE_DATABASE_URL (a Postgres
 * schema in CI) or a SQLite file in <shared-dir>. Runs until
 * SIGTERM (drains, then exits) or SIGKILL.
 */
import { join } from "node:path";

import { BrainstemRuntime } from "../../../src/runtime/runtime.mjs";
import {
  countingInputSource,
  fakeBrainstem,
  recordingDestinationSource,
  silentLogger,
  writePlugin
} from "../../helpers/fixtures.mjs";

const [sharedDir, coreName] = process.argv.slice(2);
const intervalMs = Number(process.env.CORE_INTERVAL_MS ?? 50);
const databaseUrl = process.env.CORE_DATABASE_URL ?? `sqlite:${join(sharedDir, "brainstem.sqlite")}`;

const inputPath = await writePlugin(sharedDir, `input-${coreName}.mjs`, countingInputSource({ prefix: "shared" }));
const destinationPath = await writePlugin(
  sharedDir,
  `destination-${coreName}.mjs`,
  recordingDestinationSource(join(sharedDir, "deliveries.log"))
);

const runtime = new BrainstemRuntime({
  brainstem: fakeBrainstem(),
  config: {
    runtime: {
      coreId: coreName,
      database: { url: databaseUrl, importLegacy: false },
      records: { type: "memory" },
      checkpoints: { type: "database", legacyPath: false },
      retry: { attempts: 1, minDelayMs: 0, maxDelayMs: 0, factor: 1 },
      queue: { pollIntervalMs: 50, leaseMs: 2_000 },
      inputs: { leaseMs: 1_000, checkIntervalMs: 50 },
      cores: { heartbeatMs: 200 },
      shutdown: { timeoutMs: 2_000 }
    }
  },
  logger: silentLogger,
  plugins: [{ id: "shared-counter", module: inputPath, intervalMs }],
  destinations: [{ id: "recorder", module: destinationPath, decisions: ["queue"], config: { name: coreName } }]
});

process.once("SIGTERM", async () => {
  await runtime.drain();
  await runtime.close();
  process.exit(0);
});

await runtime.start();
process.send?.("ready");
