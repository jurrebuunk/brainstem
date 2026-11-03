#!/usr/bin/env node
/*
 * Pipeline load test (roadmap Phase 5).
 *
 *   BRAINSTEM_LOAD_PG_URL=postgres://... node scripts/load-test.mjs \
 *     [--jobs 2000] [--cores 1,2,4] [--concurrency 4,16] [--delivery-ms 50]
 *
 * For every (cores, concurrency) pair: a fresh Postgres schema,
 * <jobs> observations enqueued as decide jobs at once (a burst), and
 * <cores> core processes running decide + deliver with a fake
 * decision (Laya's own cost depends on CPU and is measured
 * separately) and a destination that takes --delivery-ms, like a
 * network call. It reports how long the burst took to drain, the
 * throughput, and the enqueue-to-delivered latency.
 *
 * This measures what Brainstem adds: claims, commits, the delivery
 * log, wakeups. Use it to size `concurrency`, cores per queue and the
 * KEDA `readyPerReplica` target (docs/load-testing.md).
 */
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);

if (process.argv[2] === "--core") {
  await runCore(...process.argv.slice(3));
}
else {
  await main();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.BRAINSTEM_LOAD_PG_URL ?? process.env.BRAINSTEM_TEST_PG_URL;

  if (!baseUrl) {
    console.error("Set BRAINSTEM_LOAD_PG_URL to a Postgres database the test may create schemas in.");
    process.exit(2);
  }

  const jobs = Number(args.jobs ?? 2_000);
  const coreCounts = String(args.cores ?? "1,2,4").split(",").map(Number);
  const concurrencies = String(args.concurrency ?? "4,16").split(",").map(Number);
  const deliveryMs = Number(args["delivery-ms"] ?? 50);

  console.log(`Burst of ${jobs} observations, destination latency ${deliveryMs} ms, fake decisions.\n`);
  console.log("| cores | concurrency | drain (s) | decisions/s | deliveries/s | latency p50 (ms) | p95 (ms) | max (ms) |");
  console.log("|---:|---:|---:|---:|---:|---:|---:|---:|");

  for (const cores of coreCounts) {
    for (const concurrency of concurrencies) {
      const result = await scenario({ baseUrl, jobs, cores, concurrency, deliveryMs });
      console.log(`| ${cores} | ${concurrency} | ${result.drainS.toFixed(1)} | ${Math.round(jobs / result.decideS)} | ${Math.round(jobs / result.drainS)} | ${result.p50} | ${result.p95} | ${result.max} |`);
    }
  }
}

async function scenario({ baseUrl, jobs, cores, concurrency, deliveryMs }) {
  const { openDatabase } = await import("../src/db/database.mjs");
  const { migrateToLatest } = await import("../src/db/migrate.mjs");
  const { createPipelineStorage } = await import("../src/queue/index.mjs");
  const { createObservation } = await import("../src/core/brainstem.mjs");

  const schema = `load_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const admin = await openDatabase({ url: baseUrl, pool: { max: 1 } });
  await admin.db.executeQuery({ sql: `create schema "${schema}"`, parameters: [], query: { kind: "RawNode" } });
  await admin.close();

  const url = new URL(baseUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const handle = await openDatabase({ url: url.toString() });
  const dir = await mkdtemp(join(tmpdir(), "brainstem-load-"));
  const children = [];

  try {
    await migrateToLatest(handle);

    const { transport } = createPipelineStorage({ type: "database", database: handle });
    const now = Date.now();
    const batch = [];

    for (let index = 0; index < jobs; index += 1) {
      batch.push({
        queue: "decide",
        queueKey: `observation:load:${index}`,
        maxAttempts: 5,
        payload: {
          observation: createObservation({
            id: `load:${index}`,
            source: { type: "load", name: "burst" },
            type: "item",
            state: "new",
            title: `Item ${index}`,
            message: `Item ${index}`,
            data: { enqueuedAt: now }
          }),
          emissionId: `load-${index}`,
          origin: { kind: "input", id: "load" },
          input: { id: "load", plugin: "load", name: "default" }
        }
      });
    }

    // Insert everything before the cores start, in one transaction.
    await transport.transaction(executor => transport.enqueue(batch, { executor }));

    const destination = join(dir, "destination.mjs");
    await writeFile(destination, `export default {
  apiVersion: "brainstem.destination/v2",
  name: "load-receiver",
  destinations: { default: { async handle() { await new Promise(resolve => setTimeout(resolve, ${deliveryMs})); } } }
};`);

    const started = Date.now();

    for (let index = 0; index < cores; index += 1) {
      const child = fork(SELF, ["--core", url.toString(), `core-${index}`, String(concurrency), destination], {
        stdio: ["ignore", "inherit", "inherit", "ipc"]
      });
      children.push(child);
    }
    await Promise.all(children.map(child => once(child, "message")));

    let decidedAt = null;

    while (true) {
      const rows = await handle.db.selectFrom("jobs")
        .select(eb => ["queue", eb.fn.countAll().as("count")])
        .groupBy("queue")
        .execute();
      const left = Object.fromEntries(rows.map(row => [row.queue, Number(row.count)]));

      if (!left.decide && decidedAt === null) decidedAt = Date.now();
      if (!left.decide && !left.deliver) break;

      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const finished = Date.now();
    const deliveries = await handle.db.selectFrom("deliveries")
      .select(["status", "delivered_at"])
      .execute();

    const delivered = deliveries.filter(row => row.status === "delivered");
    if (delivered.length !== jobs) throw new Error(`expected ${jobs} deliveries, got ${delivered.length}`);

    const latencies = delivered.map(row => Date.parse(row.delivered_at) - now).sort((a, b) => a - b);
    const quantile = q => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];

    return {
      drainS: (finished - started) / 1000,
      decideS: (decidedAt - started) / 1000,
      p50: quantile(0.5),
      p95: quantile(0.95),
      max: latencies.at(-1)
    };
  }
  finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }));
    await handle.close();
    const cleanup = await openDatabase({ url: baseUrl, pool: { max: 1 } });
    await cleanup.db.executeQuery({ sql: `drop schema "${schema}" cascade`, parameters: [], query: { kind: "RawNode" } });
    await cleanup.close();
  }
}

async function runCore(databaseUrl, coreId, concurrency, destination) {
  const { BrainstemRuntime } = await import("../src/runtime/runtime.mjs");
  const { MetricsRegistry } = await import("../src/observability/metrics.mjs");

  const runtime = new BrainstemRuntime({
    brainstem: {
      async start() {},
      async close() {},
      async process(observation) {
        return {
          version: "1",
          kind: "decision",
          payload: { observation_id: observation.payload.id, revision: 1, decision: "queue", route: "coding" }
        };
      }
    },
    config: {
      runtime: {
        coreId,
        database: { url: databaseUrl, importLegacy: false },
        records: { type: "memory" },
        checkpoints: { type: "database", legacyPath: false },
        queues: ["decide", "deliver"],
        queue: {
          decide: { concurrency: Number(concurrency) },
          deliver: { concurrency: Number(concurrency) }
        },
        cores: { heartbeatMs: 1_000 },
        telemetry: false
      }
    },
    logger: { debug() {}, info() {}, warn() {}, error: (message, fields) => console.error(coreId, message, fields?.error?.message ?? "") },
    metrics: new MetricsRegistry(),
    destinations: [{ id: "receiver", module: destination, decisions: ["queue"] }]
  });

  process.once("SIGTERM", async () => {
    await runtime.drain({ timeoutMs: 2_000 }).catch(() => {});
    await runtime.close().catch(() => {});
    process.exit(0);
  });

  await runtime.start();
  process.send?.("ready");
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith("--")) {
      const [name, inline] = argv[index].slice(2).split("=");
      result[name] = inline ?? argv[index + 1];
      if (inline === undefined) index += 1;
    }
  }
  return result;
}
