/*
 * Brainstem 2.0 acceptance tests (roadmap Phase 0, passing since
 * Phase 3).
 *
 * These run several real core processes against one shared
 * database and assert cluster-level guarantees. Postgres is used
 * when BRAINSTEM_TEST_PG_URL is set (CI), SQLite otherwise. Run with
 * `npm run test:acceptance`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { readLines, tempDir } from "../helpers/fixtures.mjs";
import { TEST_PG_URL, isolatedDatabaseUrl } from "../helpers/database.mjs";

const CORE = fileURLToPath(new URL("./fixtures/core.mjs", import.meta.url));
const DIALECT = TEST_PG_URL ? "postgres" : "sqlite";

test(`[${DIALECT}] single core delivers each observation exactly once`, async () => {
  const { deliveries } = await runCluster({ cores: 1, durationMs: 600 });

  assert.ok(deliveries.length >= 3, `expected several polls, got ${deliveries.length}`);
  assert.deepEqual(duplicates(deliveries), []);
});

test(`[${DIALECT}] N cores sharing state deliver each observation exactly once`, async () => {
  const { deliveries } = await runCluster({ cores: 3, durationMs: 1_000 });

  assert.ok(deliveries.length >= 3, `expected several polls, got ${deliveries.length}`);
  assert.deepEqual(duplicates(deliveries), []);
  assert.deepEqual(gaps(deliveries), [], "no observation is lost");
});

test(`[${DIALECT}] N cores share the polling load`, async () => {
  const cluster = await runCluster({ cores: 3, durationMs: 1_000 });
  const singleCore = await runCluster({ cores: 1, durationMs: 1_000 });

  // Only deliveries made while every core was up: cores start one
  // after another, so earlier ones poll alone for a while.
  const total = cluster.deliveries.length - cluster.atStart;
  const single = singleCore.deliveries.length - singleCore.atStart;

  // Polling one input must not multiply with the number of cores.
  assert.ok(
    total <= single * 1.5 + 2,
    `3 cores produced ${total} deliveries vs ${single} for 1 core`
  );
  assert.ok(
    new Set(cluster.deliveries.map(delivery => delivery.core)).size > 1,
    "deliveries are spread across cores"
  );
});

test(`[${DIALECT}] polling continues when a core is killed`, async () => {
  const { deliveries, atKill } = await runCluster({
    cores: 3,
    durationMs: 3_500,
    killAfterMs: 500
  });

  // The killed core's input lease and jobs are taken over once it
  // counts as lost (3 missed heartbeats), so the others keep polling
  // and finish its work.
  assert.ok(
    deliveries.length > atKill + 3,
    `only ${deliveries.length - atKill} deliveries after the kill`
  );
  // At-least-once: a kill between sending and committing may repeat
  // one delivery, but nothing is lost.
  assert.deepEqual(gaps(deliveries), [], "no observation is lost");
});

async function runCluster({ cores, durationMs, killAfterMs = null }) {
  const dir = await tempDir("acceptance-cluster");
  const database = TEST_PG_URL ? await isolatedDatabaseUrl("postgres") : null;
  const children = [];
  let atKill = 0;
  let atStart = 0;

  try {
    for (let index = 0; index < cores; index += 1) {
      const child = fork(CORE, [dir, `core-${index}`], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: { ...process.env, ...(database ? { CORE_DATABASE_URL: database.url } : {}) }
      });
      children.push(child);
      await once(child, "message");
    }

    atStart = (await readLines(join(dir, "deliveries.log"))).length;

    if (killAfterMs !== null) {
      await sleep(killAfterMs);
      atKill = (await readLines(join(dir, "deliveries.log"))).length;
      children[0].kill("SIGKILL");
      await sleep(durationMs - killAfterMs);
    }
    else {
      await sleep(durationMs);
    }
  }
  finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }));
    await database?.drop();
  }

  const deliveries = (await readLines(join(dir, "deliveries.log")))
    .map(line => {
      const [core, observationId] = line.split(" ");
      return { core, observationId };
    });

  return { dir, deliveries, atKill, atStart };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function duplicates(deliveries) {
  const seen = new Map();
  for (const { observationId } of deliveries) {
    seen.set(observationId, (seen.get(observationId) ?? 0) + 1);
  }
  return [...seen].filter(([, count]) => count > 1).map(([id, count]) => `${id} ×${count}`);
}

// Counter values missing between 0 and the highest delivered one.
function gaps(deliveries) {
  const numbers = new Set(deliveries.map(({ observationId }) => Number(observationId.split(":")[1])));
  const max = Math.max(-1, ...numbers);
  const missing = [];
  for (let n = 0; n <= max; n += 1) if (!numbers.has(n)) missing.push(n);
  return missing;
}
