import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { BrainstemRuntime, deliveryKey } from "../src/runtime/runtime.mjs";
import { dialectTest } from "./helpers/database.mjs";
import {
  countingInputSource,
  fakeBrainstem,
  minimalPolicyConfig,
  readLines,
  recordingDestinationSource,
  silentLogger,
  tempDir,
  waitFor,
  writePlugin
} from "./helpers/fixtures.mjs";

/*
 * v2 destination that records "<key> <observation id> <attempt>"
 * and fails while <dir>/fail exists.
 */
function v2DestinationSource(dir) {
  return `
import { appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export default {
  apiVersion: "brainstem.destination/v2",
  name: "v2-destination",
  destinations: {
    default: {
      async handle(ctx, output) {
        if (output.kind !== "brainstem.output") throw new Error("expected an output envelope");
        if (existsSync(${JSON.stringify(join(dir, "fail"))})) throw new Error("receiver down");
        await appendFile(
          ${JSON.stringify(join(dir, "v2.log"))},
          \`\${ctx.idempotencyKey} \${output.payload.observation.payload.id} \${ctx.attempt} \${output.payload.idempotencyKey === ctx.idempotencyKey}\\n\`
        );
      }
    }
  }
};
`;
}

/*
 * Input that emits the same observation on every poll (like an
 * input re-emitting an unresolved alert as a reminder).
 */
const repeatingInputSource = `
export default {
  apiVersion: "brainstem.input/v1",
  name: "repeating-input",
  inputs: {
    default: {
      mode: "poll",
      async *poll(ctx) {
        yield ctx.observation({
          id: "alert:1",
          source: { type: "test", name: "repeat" },
          type: "alert",
          state: "firing",
          title: "Disk full",
          message: "Disk is full"
        });
      }
    }
  }
};
`;

function databaseConfig(overrides = {}) {
  return {
    ...minimalPolicyConfig,
    runtime: {
      // Never import the repo's own data/checkpoints.json.
      checkpoints: { type: "database", legacyPath: false },
      retry: { attempts: 1, minDelayMs: 0, maxDelayMs: 0, factor: 1 },
      queue: {
        deliver: { retry: { attempts: 5, minDelayMs: 0, maxDelayMs: 0 } }
      },
      ...overrides
    }
  };
}

dialectTest("a run commits observations, decisions and deliveries through the database queue", async ({ handle }) => {
  const dir = await tempDir("pipeline-db");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource());
  const destinationPath = await writePlugin(dir, "destination.mjs", v2DestinationSource(dir));

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: databaseConfig(),
    logger: silentLogger,
    database: handle,
    plugins: [{ id: "counter", module: inputPath }],
    destinations: [{ id: "receiver", module: destinationPath, decisions: ["queue"] }]
  });

  assert.equal(runtime.transport.type, "database");
  assert.equal(runtime.checkpointsInTransaction, true);

  await runtime.runOnce();

  const [line] = await readLines(join(dir, "v2.log"));
  const [key, observationId, attempt, keyInEnvelope] = line.split(" ");
  assert.equal(observationId, "counter:0");
  assert.equal(attempt, "1");
  assert.equal(keyInEnvelope, "true");
  assert.match(key, /^receiver:counter:0:r1:[0-9a-f-]{36}$/);

  const checkpoint = await handle.db.selectFrom("checkpoints").selectAll().where("key", "=", "counter").executeTakeFirst();
  assert.deepEqual(JSON.parse(checkpoint.value_json), { count: 1 });

  assert.deepEqual(await handle.db.selectFrom("jobs").selectAll().execute(), []);

  const delivery = await handle.db.selectFrom("deliveries").selectAll().executeTakeFirst();
  assert.equal(delivery.key, key);
  assert.equal(delivery.status, "delivered");
  assert.equal(delivery.destination, "receiver");
  assert.equal(JSON.parse(delivery.output_json).payload.destination.id, "receiver");
});

dialectTest("a failed delivery survives a restart and is delivered once by the next run", async ({ handle }) => {
  const dir = await tempDir("pipeline-restart");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource());
  const destinationPath = await writePlugin(dir, "destination.mjs", v2DestinationSource(dir));
  const failFlag = join(dir, "fail");
  const options = {
    brainstem: fakeBrainstem(),
    logger: silentLogger,
    database: handle,
    plugins: [{ id: "counter", module: inputPath }],
    destinations: [{ id: "receiver", module: destinationPath, decisions: ["queue"] }]
  };

  await writePlugin(dir, "fail", "");

  const first = new BrainstemRuntime({
    ...options,
    config: databaseConfig({
      queue: { deliver: { retry: { attempts: 5, minDelayMs: 50, maxDelayMs: 50, jitter: false } } }
    })
  });
  await assert.rejects(() => first.runOnce(), /receiver down/);

  const [failed] = await first.deliveries.list({});
  assert.equal(failed.status, "failed");
  assert.equal(failed.lastError, "receiver down");

  const { rm } = await import("node:fs/promises");
  await rm(failFlag);
  await new Promise(resolve => setTimeout(resolve, 80));

  const second = new BrainstemRuntime({ ...options, config: databaseConfig() });
  await second.runOnce();

  const lines = await readLines(join(dir, "v2.log"));
  const byObservation = lines.map(line => line.split(" ")).map(([key, id, attempt]) => ({ key, id, attempt }));

  // counter:0 from the first run is retried (attempt 2) by the
  // second run; counter:1 is the second run's own poll.
  assert.deepEqual(byObservation.map(item => [item.id, item.attempt]).sort(), [["counter:0", "2"], ["counter:1", "1"]]);
  assert.equal(byObservation.find(item => item.id === "counter:0").key, failed.key);

  const statuses = (await second.deliveries.list({})).map(row => row.status);
  assert.deepEqual(statuses, ["delivered", "delivered"]);
});

dialectTest("re-emitted unchanged observations are delivered again with a new key", async ({ handle }) => {
  const dir = await tempDir("pipeline-reemit");
  const inputPath = await writePlugin(dir, "input.mjs", repeatingInputSource);
  const destinationPath = await writePlugin(dir, "destination.mjs", v2DestinationSource(dir));

  for (let run = 0; run < 2; run += 1) {
    const runtime = new BrainstemRuntime({
      brainstem: fakeBrainstem(),
      config: databaseConfig(),
      logger: silentLogger,
      database: handle,
      plugins: [{ id: "repeat", module: inputPath }],
      destinations: [{ id: "receiver", module: destinationPath, decisions: ["queue"] }]
    });

    await runtime.runOnce();
  }

  const keys = (await readLines(join(dir, "v2.log"))).map(line => line.split(" ")[0]);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

dialectTest("a deliver job that runs again after its delivery was recorded does not resend", async ({ handle }) => {
  const dir = await tempDir("pipeline-dedupe");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource());
  const destinationPath = await writePlugin(dir, "destination.mjs", v2DestinationSource(dir));

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: databaseConfig(),
    logger: silentLogger,
    database: handle,
    plugins: [{ id: "counter", module: inputPath }],
    destinations: [{ id: "receiver", module: destinationPath, decisions: ["queue"] }]
  });

  await runtime.runOnce();

  // Simulate a job whose ack was lost after the delivery was
  // recorded: the same key is queued again.
  const [delivery] = await runtime.deliveries.list({});
  await handle.db.insertInto("jobs").values({
    queue: "deliver",
    job_key: null,
    queue_key: null,
    payload_json: JSON.stringify({ key: delivery.key, destination: "receiver" }),
    state: "ready",
    attempts: 0,
    max_attempts: 3,
    run_at: Date.now(),
    locked_by: null,
    locked_until: null,
    last_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).execute();

  const again = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: databaseConfig(),
    logger: silentLogger,
    database: handle,
    plugins: [],
    destinations: [{ id: "receiver", module: destinationPath, decisions: ["queue"] }]
  });
  await again.runOnce();

  assert.equal((await readLines(join(dir, "v2.log"))).length, 1);
  assert.deepEqual(await handle.db.selectFrom("jobs").selectAll().execute(), []);
});

dialectTest("dead deliveries can be redriven", async ({ handle }) => {
  const dir = await tempDir("pipeline-redrive");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource());
  const destinationPath = await writePlugin(dir, "destination.mjs", v2DestinationSource(dir));
  const options = {
    brainstem: fakeBrainstem(),
    logger: silentLogger,
    database: handle,
    destinations: [{ id: "receiver", module: destinationPath, decisions: ["queue"], retry: { attempts: 2 } }]
  };

  await writePlugin(dir, "fail", "");

  const first = new BrainstemRuntime({ ...options, config: databaseConfig(), plugins: [{ id: "counter", module: inputPath }] });
  await assert.rejects(() => first.runOnce(), /receiver down/);

  const [dead] = await first.transport.listJobs({ state: "dead" });
  assert.equal(dead.queue, "deliver");
  assert.equal(dead.attempts, 2);
  assert.equal((await first.deliveries.get(dead.payload.key)).status, "dead");

  const { rm } = await import("node:fs/promises");
  await rm(join(dir, "fail"));

  const second = new BrainstemRuntime({ ...options, config: databaseConfig(), plugins: [] });
  await second.pipelineAdmin.redrive(dead.id);
  assert.equal((await second.deliveries.get(dead.payload.key)).status, "pending");

  await second.runOnce();
  assert.equal((await second.deliveries.get(dead.payload.key)).status, "delivered");
  assert.equal((await readLines(join(dir, "v2.log"))).length, 1);
});

test("v1 destinations get the legacy event through the adapter", async () => {
  const dir = await tempDir("pipeline-v1");
  const outputPath = join(dir, "deliveries.log");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource());
  const destinationPath = await writePlugin(dir, "destination.mjs", `
import { appendFile } from "node:fs/promises";

export default {
  apiVersion: "brainstem.destination/v1",
  name: "legacy-destination",
  destinations: {
    default: {
      async handle(ctx, event) {
        await appendFile(${JSON.stringify(outputPath)}, JSON.stringify({
          input: [event.input.plugin.name, event.input.name, event.input.entry.id],
          destination: [event.destination.plugin.name, event.destination.name, event.destination.entry.id],
          observation: event.observation.payload.id,
          decision: event.decision.payload.decision,
          hasKey: typeof ctx.idempotencyKey === "string"
        }) + "\\n");
      }
    }
  }
};
`);
  const warnings = [];

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: {
      ...minimalPolicyConfig,
      runtime: { records: { type: "memory" }, checkpoints: { type: "memory" } }
    },
    logger: { ...silentLogger, warn: message => warnings.push(message) },
    plugins: [{ id: "counter", module: inputPath }],
    destinations: [{ id: "legacy", module: destinationPath, decisions: ["queue"] }]
  });

  assert.equal(runtime.transport.type, "memory");

  await runtime.runOnce();

  assert.deepEqual((await readLines(outputPath)).map(line => JSON.parse(line)), [{
    input: ["counting-input", "default", "counter"],
    destination: ["legacy-destination", "default", "legacy"],
    observation: "counter:0",
    decision: "queue",
    hasKey: true
  }]);
  assert.ok(warnings.some(message => /brainstem\.destination\/v1/.test(message)));
});

test("start() runs the pipeline continuously and close() drains in-flight work", async () => {
  const dir = await tempDir("pipeline-start");
  const outputPath = join(dir, "deliveries.log");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource());
  const destinationPath = await writePlugin(dir, "destination.mjs", recordingDestinationSource(outputPath));

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: {
      ...minimalPolicyConfig,
      runtime: { records: { type: "memory" }, checkpoints: { type: "memory" }, queue: { pollIntervalMs: 5_000 } }
    },
    logger: silentLogger,
    plugins: [{ id: "counter", module: inputPath, intervalMs: 10 }],
    destinations: [{ module: destinationPath, decisions: ["queue"] }]
  });

  await runtime.start();

  try {
    // Wakeups, not the 5s poll interval, move jobs along.
    await waitFor(async () => (await readLines(outputPath)).length >= 5, { timeoutMs: 2_000 });
  }
  finally {
    await runtime.close();
  }

  const lines = await readLines(outputPath);
  assert.deepEqual(lines.slice(0, 5), [0, 1, 2, 3, 4].map(n => `default counter:${n}`));
});

test("destination ids must be unique", async () => {
  const dir = await tempDir("pipeline-ids");
  const destinationPath = await writePlugin(dir, "destination.mjs", recordingDestinationSource(join(dir, "x.log")));

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: { ...minimalPolicyConfig, runtime: { records: { type: "memory" }, checkpoints: { type: "memory" } } },
    logger: silentLogger,
    plugins: [],
    destinations: [
      { id: "same", module: destinationPath },
      { id: "same", module: destinationPath }
    ]
  });

  await assert.rejects(() => runtime.runOnce(), /Duplicate destination id 'same'/);
});

test("delivery keys combine destination, observation, revision and emission", () => {
  assert.equal(
    deliveryKey({ destinationId: "matrix", observationId: "obs:1", revision: 3, emissionId: "e1" }),
    "matrix:obs:1:r3:e1"
  );
});

/*
 * Destination that records what it receives and, when `emitAs`
 * is set, hands a report observation back to the core.
 */
function handoffDestinationSource(dir, name, { emitAs = null, fail = false } = {}) {
  return `
import { appendFile } from "node:fs/promises";

export default {
  apiVersion: "brainstem.destination/v2",
  name: "${name}",
  destinations: {
    default: {
      async handle(ctx, output) {
        const observation = output.payload.observation.payload;
        let note = "";

        if (${JSON.stringify(emitAs)}) {
          try {
            ctx.emit({
              version: "1",
              kind: "observation",
              payload: {
                id: \`${emitAs}:\${observation.id}\`,
                source: { type: "agent", name: "${name}" },
                type: "report",
                state: "reported",
                timestamp: new Date().toISOString(),
                title: \`Report on \${observation.title}\`,
                message: "summary",
                facts: {},
                data: {}
              }
            });
          }
          catch (error) {
            note = \` emit-error:\${error.message}\`;
          }
        }

        await appendFile(${JSON.stringify(join(dir, "handoff.log"))}, \`${name} \${observation.id} \${output.payload.input.id}\${note}\\n\`);
        if (${fail}) throw new Error("${name} failed after emitting");
      }
    }
  }
};
`;
}

dialectTest("a destination hands an observation back to the core, and it never returns to that destination", async ({ handle }) => {
  const dir = await tempDir("pipeline-handoff");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource());
  const agentPath = await writePlugin(dir, "agent.mjs", handoffDestinationSource(dir, "agent", { emitAs: "report" }));
  const bigPath = await writePlugin(dir, "big.mjs", handoffDestinationSource(dir, "big"));

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: databaseConfig(),
    logger: silentLogger,
    database: handle,
    plugins: [{ id: "counter", module: inputPath }],
    destinations: [
      { id: "agent", module: agentPath, decisions: ["queue"] },
      { id: "big", module: bigPath, decisions: ["queue"] }
    ]
  });

  await runtime.runOnce();

  assert.deepEqual((await readLines(join(dir, "handoff.log"))).sort(), [
    "agent counter:0 counter",
    "big counter:0 counter",
    "big report:counter:0 destination:agent"
  ], "the report reaches 'big' but not the agent that wrote it");

  assert.deepEqual(await handle.db.selectFrom("jobs").selectAll().execute(), []);
});

dialectTest("handoff stops at runtime.handoff.maxDepth and emits nothing from a failed delivery", async ({ handle }) => {
  const dir = await tempDir("pipeline-handoff-depth");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource());
  const firstPath = await writePlugin(dir, "first.mjs", handoffDestinationSource(dir, "first", { emitAs: "a" }));
  const secondPath = await writePlugin(dir, "second.mjs", handoffDestinationSource(dir, "second", { emitAs: "b" }));
  const brokenPath = await writePlugin(dir, "broken.mjs", handoffDestinationSource(dir, "broken", { emitAs: "c", fail: true }));

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: databaseConfig({
      handoff: { maxDepth: 1 },
      queue: { deliver: { retry: { attempts: 1, minDelayMs: 0, maxDelayMs: 0 } } }
    }),
    logger: silentLogger,
    database: handle,
    plugins: [{ id: "counter", module: inputPath }],
    destinations: [
      { id: "first", module: firstPath, decisions: ["queue"], sources: ["counter"] },
      { id: "second", module: secondPath, decisions: ["queue"], sources: ["agent"] },
      { id: "broken", module: brokenPath, decisions: ["queue"], sources: ["counter"] }
    ]
  });

  await runtime.runOnce().catch(() => {});

  const lines = await readLines(join(dir, "handoff.log"));

  assert.ok(lines.includes("first counter:0 counter"));
  assert.ok(
    lines.includes("second a:counter:0 destination:first emit-error:ctx.emit: handoff depth 1 reached (runtime.handoff.maxDepth)"),
    "a depth-1 delivery cannot emit when maxDepth is 1"
  );
  assert.ok(lines.includes("broken counter:0 counter"));
  assert.ok(!lines.some(line => line.includes("c:counter:0")), "the failed delivery's emit was discarded");
});
