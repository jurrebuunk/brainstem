/*
 * One Brainstem core process for the multi-core acceptance tests.
 *
 *   node core.mjs <shared-dir> <core-name>
 *
 * Polls a counting input and records every delivery as
 * "<core-name> <observation id>" in <shared-dir>/deliveries.log.
 * Runs until SIGTERM.
 */
import { join } from "node:path";

import { BrainstemRuntime } from "../../../src/runtime/runtime.mjs";
import {
  countingInputSource,
  fakeBrainstem,
  recordingDestinationSource,
  runtimeConfig,
  silentLogger,
  writePlugin
} from "../../helpers/fixtures.mjs";

const [sharedDir, coreName] = process.argv.slice(2);
const intervalMs = Number(process.env.CORE_INTERVAL_MS ?? 50);

const inputPath = await writePlugin(sharedDir, `input-${coreName}.mjs`, countingInputSource({ prefix: "shared" }));
const destinationPath = await writePlugin(
  sharedDir,
  `destination-${coreName}.mjs`,
  recordingDestinationSource(join(sharedDir, "deliveries.log"))
);

const runtime = new BrainstemRuntime({
  brainstem: fakeBrainstem(),
  config: runtimeConfig(join(sharedDir, "checkpoints.json")),
  logger: silentLogger,
  plugins: [{ id: "shared-counter", module: inputPath, intervalMs }],
  destinations: [{ module: destinationPath, decisions: ["queue"], config: { name: coreName } }]
});

process.once("SIGTERM", async () => {
  await runtime.close();
  process.exit(0);
});

await runtime.start();
process.send?.("ready");
