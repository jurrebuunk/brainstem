import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Brainstem, createObservation } from "../src/core/brainstem.mjs";
import { BrainstemRuntime } from "../src/runtime/runtime.mjs";
import {
  countingInputSource,
  failingDestinationSource,
  fakeBrainstem,
  minimalPolicyConfig,
  readLines,
  recordingDestinationSource,
  runtimeConfig,
  silentLogger,
  tempDir,
  waitFor,
  writePlugin
} from "./helpers/fixtures.mjs";

test("start() keeps polling on the input interval until close()", async () => {
  const dir = await tempDir("lifecycle-loop");
  const outputPath = join(dir, "deliveries.log");
  const checkpointPath = join(dir, "checkpoints.json");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource());
  const destinationPath = await writePlugin(dir, "destination.mjs", recordingDestinationSource(outputPath));

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: runtimeConfig(checkpointPath),
    logger: silentLogger,
    plugins: [{ id: "counter", module: inputPath, intervalMs: 20 }],
    destinations: [{ module: destinationPath, decisions: ["queue"] }]
  });

  await runtime.start();

  try {
    await waitFor(async () => (await readLines(outputPath)).length >= 3);
  }
  finally {
    await runtime.close();
  }

  const lines = await readLines(outputPath);
  assert.deepEqual(
    lines.slice(0, 3),
    ["default counter:0", "default counter:1", "default counter:2"]
  );

  const saved = JSON.parse(await readFile(checkpointPath, "utf8"));
  assert.equal(saved.counter.count, lines.length);
});

test("close() stops the polling loop promptly and is idempotent", async () => {
  const dir = await tempDir("lifecycle-close");
  const outputPath = join(dir, "deliveries.log");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource());
  const destinationPath = await writePlugin(dir, "destination.mjs", recordingDestinationSource(outputPath));

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: runtimeConfig(join(dir, "checkpoints.json")),
    logger: silentLogger,
    plugins: [{ id: "counter", module: inputPath, intervalMs: 60_000 }],
    destinations: [{ module: destinationPath, decisions: ["queue"] }]
  });

  await runtime.start();
  await waitFor(async () => (await readLines(outputPath)).length === 1);

  const started = Date.now();
  await runtime.close();
  assert.ok(Date.now() - started < 1_000, "close() must not wait for the 60s interval");

  await runtime.close();
  assert.equal((await readLines(outputPath)).length, 1);
});

test("an external abort signal stops the runtime", async () => {
  const dir = await tempDir("lifecycle-signal");
  const outputPath = join(dir, "deliveries.log");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource());
  const destinationPath = await writePlugin(dir, "destination.mjs", recordingDestinationSource(outputPath));
  const controller = new AbortController();

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: runtimeConfig(join(dir, "checkpoints.json")),
    logger: silentLogger,
    plugins: [{ id: "counter", module: inputPath, intervalMs: 20 }],
    destinations: [{ module: destinationPath, decisions: ["queue"] }]
  });

  await runtime.start({ signal: controller.signal });
  await waitFor(async () => (await readLines(outputPath)).length >= 1);

  controller.abort();
  await Promise.allSettled(runtime.tasks);
  const countAfterAbort = (await readLines(outputPath)).length;

  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await readLines(outputPath)).length, countAfterAbort);

  await runtime.close();
});

test("start() cannot be called twice", async () => {
  const dir = await tempDir("lifecycle-twice");
  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: runtimeConfig(join(dir, "checkpoints.json")),
    logger: silentLogger,
    plugins: []
  });

  await runtime.start();

  try {
    await assert.rejects(() => runtime.start(), /already been started/);
  }
  finally {
    await runtime.close();
  }
});

/*
 * Characterization test for 1.x behaviour.
 *
 * With blockInputOnFailure, a failing destination makes the
 * whole poll retry, so destinations that already succeeded
 * receive the same decision again. Phase 2 (per-destination
 * delivery jobs, roadmap §4.2) changes this: update the
 * expectation to a single delivery then.
 */
test("1.x: poll retries re-deliver to destinations that already succeeded", async () => {
  const dir = await tempDir("retry-redelivery");
  const outputPath = join(dir, "deliveries.log");
  const checkpointPath = join(dir, "checkpoints.json");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource());
  const okPath = await writePlugin(dir, "ok.mjs", recordingDestinationSource(outputPath));
  const failingPath = await writePlugin(dir, "failing.mjs", failingDestinationSource());

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: runtimeConfig(checkpointPath, {
      retry: { attempts: 3 },
      runtime: { destinations: { blockInputOnFailure: true } }
    }),
    logger: silentLogger,
    plugins: [{ id: "counter", module: inputPath }],
    destinations: [
      { module: okPath, decisions: ["queue"], config: { name: "ok" } },
      { module: failingPath, decisions: ["queue"] }
    ]
  });

  await assert.rejects(() => runtime.runOnce(), /destinations failed/i);

  assert.deepEqual(
    await readLines(outputPath),
    ["ok counter:0", "ok counter:0", "ok counter:0"]
  );
});

test("core serializes updates for the same observation id in arrival order", async () => {
  const brainstem = new Brainstem(minimalPolicyConfig);
  const evaluated = [];
  let active = 0;
  let maxActive = 0;

  brainstem.laya = {
    async systemOne(state, questions) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      evaluated.push(state);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;

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

  const states = ["open", "triaged", "in_progress", "blocked", "closed"];
  const observations = states.map(state => createObservation({
    id: "order:test:1",
    source: { type: "test", name: "order" },
    type: "status",
    state,
    title: `State ${state}`,
    message: `Observation is ${state}`
  }));

  const decisions = await Promise.all(
    observations.map(observation => brainstem.process(observation))
  );

  assert.deepEqual(
    decisions.map(decision => decision.payload.revision),
    [1, 2, 3, 4, 5]
  );
  assert.equal(maxActive, 1, "Laya evaluations must never overlap");
  assert.equal(brainstem.records.get("order:test:1").revision, 5);

  await brainstem.close();
});

test("core reuses the cached decision for unchanged concurrent observations", async () => {
  const brainstem = new Brainstem(minimalPolicyConfig);
  const counter = { count: 0 };

  brainstem.laya = {
    async systemOne(_state, questions) {
      counter.count += 1;
      const name = Object.keys(questions)[0];
      return { answers: { [name]: name === "route" ? { choice: "coding", probabilities: { coding: 1 } } : name === "severity" ? { score: 2 } : { noul: 0.9 } } };
    },
    async close() {}
  };

  const observation = createObservation({
    id: "cache:test:1",
    source: { type: "test", name: "cache" },
    type: "status",
    state: "open",
    title: "Same",
    message: "Same"
  });

  await brainstem.process(observation);
  const afterFirst = counter.count;

  const repeats = await Promise.all(
    Array.from({ length: 5 }, () => brainstem.process(observation))
  );

  assert.equal(counter.count, afterFirst, "unchanged observations must not hit Laya");
  assert.ok(repeats.every(decision => decision.payload.revision === 1));

  await brainstem.close();
});
