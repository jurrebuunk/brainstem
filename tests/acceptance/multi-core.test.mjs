/*
 * Brainstem 2.0 acceptance tests (roadmap Phase 0).
 *
 * These run several real core processes against shared state
 * and assert cluster-level guarantees. Tests marked `todo`
 * describe 2.0 behaviour that 1.x does not provide yet; they
 * run and report, but do not fail the suite. Remove `todo`
 * as each phase lands. Run with `npm run test:acceptance`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { readLines, tempDir } from "../helpers/fixtures.mjs";

const CORE = fileURLToPath(new URL("./fixtures/core.mjs", import.meta.url));

test("single core delivers each observation exactly once", async () => {
  const { deliveries } = await runCluster({ cores: 1, durationMs: 600 });

  assert.ok(deliveries.length >= 3, `expected several polls, got ${deliveries.length}`);
  assert.deepEqual(duplicates(deliveries), []);
});

test(
  "N cores sharing state deliver each observation exactly once",
  { todo: "2.0 Phase 3: lease-based input scheduling + delivery idempotency" },
  async () => {
    const { deliveries } = await runCluster({ cores: 3, durationMs: 1_000 });

    assert.ok(deliveries.length >= 3, `expected several polls, got ${deliveries.length}`);
    assert.deepEqual(duplicates(deliveries), []);
  }
);

test(
  "N cores share the polling load",
  { todo: "2.0 Phase 3: inputs are claimed by whichever core is free" },
  async () => {
    const cluster = await runCluster({ cores: 3, durationMs: 1_000 });
    const singleCore = await runCluster({ cores: 1, durationMs: 1_000 });
    const total = cluster.deliveries.length;

    // Polling one input must not multiply with the number of cores.
    assert.ok(
      total <= singleCore.deliveries.length * 1.5,
      `3 cores produced ${total} deliveries vs ${singleCore.deliveries.length} for 1 core`
    );
  }
);

async function runCluster({ cores, durationMs }) {
  const dir = await tempDir("acceptance-cluster");
  const children = [];

  try {
    for (let index = 0; index < cores; index += 1) {
      const child = fork(CORE, [dir, `core-${index}`], {
        stdio: ["ignore", "inherit", "inherit", "ipc"]
      });
      children.push(child);
      await once(child, "message");
    }

    await new Promise(resolve => setTimeout(resolve, durationMs));
  }
  finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }));
  }

  const deliveries = (await readLines(join(dir, "deliveries.log")))
    .map(line => {
      const [core, observationId] = line.split(" ");
      return { core, observationId };
    });

  return { dir, deliveries };
}

function duplicates(deliveries) {
  const seen = new Map();
  for (const { observationId } of deliveries) {
    seen.set(observationId, (seen.get(observationId) ?? 0) + 1);
  }
  return [...seen].filter(([, count]) => count > 1).map(([id, count]) => `${id} ×${count}`);
}
