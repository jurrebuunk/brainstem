import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { LayaPool } from "../src/core/laya-pool.mjs";
import { Brainstem, createObservation } from "../src/core/brainstem.mjs";
import { minimalPolicyConfig } from "./helpers/fixtures.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-laya.mjs", import.meta.url));
const question = { attention: { type: "noul", instructions: "?" } };

test("a Laya pool answers in parallel across worker threads", async () => {
  const pool = await LayaPool.load({ delayMs: 150, modelDir: "/models" }, { size: 3, module: FAKE });

  try {
    const started = Date.now();
    const results = await Promise.all([1, 2, 3].map(() => pool.systemOne({ title: "x" }, question)));
    const elapsed = Date.now() - started;

    assert.equal(new Set(results.map(result => result.threadId)).size, 3, "one call per worker");
    assert.ok(elapsed < 400, `three 150 ms calls on three workers took ${elapsed} ms`);
    assert.equal(results[0].modelDir, "/models");
    assert.equal(results[0].answers.attention.noul, 0.9);
  }
  finally {
    await pool.close();
  }
});

test("a failing evaluation rejects only that call", async () => {
  const pool = await LayaPool.load({ delayMs: 1, modelDir: "/m" }, { size: 1, module: FAKE });

  try {
    await assert.rejects(pool.systemOne({ title: "fail" }, question), /fake evaluation failure/);
    assert.equal((await pool.systemOne({ title: "ok" }, question)).answers.attention.noul, 0.9);
  }
  finally {
    await pool.close();
  }
});

test("a crashed worker fails its call and is replaced", async () => {
  const pool = await LayaPool.load({ delayMs: 1, modelDir: "/m" }, { size: 1, module: FAKE });

  try {
    await assert.rejects(pool.systemOne({ title: "crash" }, question), /exited/);
    const result = await pool.systemOne({ title: "after" }, question);
    assert.equal(result.answers.attention.noul, 0.9);
  }
  finally {
    await pool.close();
  }
});

test("a pool that cannot load the model fails to start", async () => {
  await assert.rejects(
    LayaPool.load({ failLoad: true, modelDir: "/m" }, { size: 2, module: FAKE }),
    /fake load failure/
  );
});

test("Brainstem evaluates changed observations concurrently with runtime.laya.workers", async () => {
  const config = {
    ...minimalPolicyConfig,
    runtime: { laya: { workers: 2, modelDir: "/m", delayMs: 100 } }
  };
  const brainstem = new Brainstem(config, { layaModule: FAKE });
  await brainstem.start();

  try {
    assert.ok(brainstem.laya instanceof LayaPool);
    assert.equal(brainstem.evaluationConcurrency, 2);

    const observation = id => createObservation({
      id,
      source: { type: "test", name: "t" },
      type: "item",
      state: "new",
      title: `Item ${id}`,
      message: "m"
    });

    const started = Date.now();
    const decisions = await Promise.all(["a", "b"].map(id => brainstem.process(observation(id))));
    const elapsed = Date.now() - started;

    assert.deepEqual(decisions.map(decision => decision.payload.observation_id), ["a", "b"]);
    // Each evaluation asks several questions of 100 ms; two in parallel
    // take about as long as one.
    const single = Date.now();
    await brainstem.process(observation("c"));
    const one = Date.now() - single;
    assert.ok(elapsed < one * 1.6, `two evaluations took ${elapsed} ms, one took ${one} ms`);
  }
  finally {
    await brainstem.close();
  }
});

test("Brainstem.reconfigure keeps the model unless its load options change", async () => {
  const brainstem = new Brainstem(
    { ...minimalPolicyConfig, runtime: { laya: { workers: 1, modelDir: "/m", delayMs: 1 } } },
    { layaModule: FAKE }
  );
  await brainstem.start();

  try {
    const first = brainstem.laya;
    const key = brainstem.cacheKey;

    await brainstem.reconfigure({
      ...minimalPolicyConfig,
      policy: { ...minimalPolicyConfig.policy, dispatch: { ...minimalPolicyConfig.policy.dispatch, attention: 0.99 } },
      runtime: { laya: { workers: 1, modelDir: "/m", delayMs: 1 } }
    });
    assert.equal(brainstem.laya, first, "policy change keeps the loaded model");
    assert.notEqual(brainstem.cacheKey, key, "decision cache is invalidated");

    await brainstem.reconfigure({ ...minimalPolicyConfig, runtime: { laya: { workers: 2, modelDir: "/m", delayMs: 1 } } });
    assert.notEqual(brainstem.laya, first, "worker count change reloads");
    assert.equal(brainstem.evaluationConcurrency, 2);
  }
  finally {
    await brainstem.close();
  }
});
