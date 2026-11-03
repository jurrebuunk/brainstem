/*
 * One Brainstem core for the chaos tests (roadmap Phase 5).
 *
 *   node core.mjs <shared-dir> <core-name>
 *
 * Polls a counting input and delivers every observation to a
 * destination that records an external "effect". Appends to
 * <shared-dir>/events.log:
 *
 *   poll-start <core> <count>           the input began polling <count>
 *   effect <core> <key> <observation>   the destination's side effect
 *
 * The effect is written before the delivery commits, and the
 * destination then waits CHAOS_DELIVERY_DELAY_MS: a kill in that
 * window is the ambiguous case (the receiver acted, Brainstem doesn't
 * know), which must be retried under the same idempotency key.
 * Likewise the input waits CHAOS_POLL_DELAY_MS between emitting and
 * committing, the window for a stale poller.
 *
 * CORE_DATABASE_URL points at Postgres, usually through the test's
 * TCP proxy so the test can cut or partition it.
 */
import { join } from "node:path";

import { BrainstemRuntime } from "../../../src/runtime/runtime.mjs";
import { fakeBrainstem, silentLogger, writePlugin } from "../../helpers/fixtures.mjs";

const [sharedDir, coreName] = process.argv.slice(2);
const events = join(sharedDir, "events.log");
const pollDelayMs = Number(process.env.CHAOS_POLL_DELAY_MS ?? 0);
const deliveryDelayMs = Number(process.env.CHAOS_DELIVERY_DELAY_MS ?? 0);

const inputPath = await writePlugin(sharedDir, `input-${coreName}.mjs`, `
import { appendFile } from "node:fs/promises";

export default {
  apiVersion: "brainstem.input/v1",
  name: "chaos-counter",
  inputs: { default: { mode: "poll", async *poll(ctx) {
    const count = (await ctx.checkpoint.get())?.count ?? 0;
    await appendFile(${JSON.stringify(events)}, "poll-start ${coreName} " + count + "\\n");
    yield ctx.observation({
      id: "chaos:" + count,
      source: { type: "chaos", name: "counter" },
      type: "item",
      state: "new",
      title: "Item " + count,
      message: "Item " + count
    });
    ctx.checkpoint.defer({ count: count + 1 });
    await new Promise(resolve => setTimeout(resolve, ${pollDelayMs}));
  } } }
};`);

const destinationPath = await writePlugin(sharedDir, `destination-${coreName}.mjs`, `
import { appendFile } from "node:fs/promises";

export default {
  apiVersion: "brainstem.destination/v2",
  name: "chaos-receiver",
  destinations: { default: { async handle(ctx, output) {
    await appendFile(${JSON.stringify(events)}, "effect ${coreName} " + ctx.idempotencyKey + " " + output.payload.observation.payload.id + "\\n");
    await new Promise(resolve => setTimeout(resolve, ${deliveryDelayMs}));
  } } }
};`);

const runtime = new BrainstemRuntime({
  brainstem: fakeBrainstem(),
  config: {
    runtime: {
      coreId: coreName,
      database: { url: process.env.CORE_DATABASE_URL, importLegacy: false, pool: { connectionTimeoutMillis: 1_000 } },
      records: { type: "memory" },
      checkpoints: { type: "database", legacyPath: false },
      retry: { attempts: 1, minDelayMs: 0, maxDelayMs: 0, factor: 1 },
      queue: {
        pollIntervalMs: 50,
        leaseMs: 1_500,
        deliver: { concurrency: 2, retry: { attempts: 50, minDelayMs: 50, maxDelayMs: 200, factor: 2 } },
        decide: { concurrency: 2, retry: { attempts: 50, minDelayMs: 50, maxDelayMs: 200, factor: 2 } }
      },
      inputs: { leaseMs: 1_000, checkIntervalMs: 50 },
      cores: { heartbeatMs: 200 },
      shutdown: { timeoutMs: 3_000 }
    }
  },
  logger: silentLogger,
  plugins: [{ id: "chaos-counter", module: inputPath, intervalMs: Number(process.env.CHAOS_INTERVAL_MS ?? 50) }],
  destinations: [{
    id: "receiver",
    module: destinationPath,
    decisions: ["queue"],
    retry: { attempts: 50, minDelayMs: 50, maxDelayMs: 200, factor: 2 }
  }]
});

process.on("unhandledRejection", () => {});
process.once("SIGTERM", async () => {
  await runtime.drain().catch(() => {});
  await runtime.close().catch(() => {});
  process.exit(0);
});

await runtime.start();
process.send?.("ready");
