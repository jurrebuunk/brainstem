import test from "node:test";
import assert from "node:assert/strict";

import {
  DatabaseDeliveryStore,
  DatabaseTransport,
  JobRunner,
  LeaseLostError,
  MemoryDeliveryStore,
  MemoryTransport,
  PermanentJobError,
  backoffDelayMs,
  createPipelineAdmin,
  normalizeJobRetry
} from "../src/queue/index.mjs";
import { DIALECTS, openTestDatabase } from "./helpers/database.mjs";

/*
 * Run one test against the memory transport and against the
 * database transport on every available dialect.
 */
function transportTest(name, fn) {
  test(`[memory] ${name}`, async () => {
    await fn({
      transport: new MemoryTransport(),
      deliveries: new MemoryDeliveryStore()
    });
  });

  for (const dialect of DIALECTS) {
    test(`[${dialect}] ${name}`, async () => {
      const handle = await openTestDatabase(dialect);

      try {
        await fn({
          transport: new DatabaseTransport({ database: handle }),
          deliveries: new DatabaseDeliveryStore({ database: handle }),
          handle
        });
      }
      finally {
        await handle.close();
      }
    });
  }
}

const LEASE = { leaseMs: 60_000, workerId: "w1" };

transportTest("enqueue, claim and ack round-trip a job", async ({ transport }) => {
  const [id] = await transport.enqueue([
    { queue: "work", payload: { hello: "world" }, maxAttempts: 3 }
  ]);

  const [job] = await transport.claim({ queues: ["work"], limit: 5, ...LEASE });
  assert.equal(job.id, id);
  assert.deepEqual(job.payload, { hello: "world" });
  assert.equal(job.state, "running");
  assert.equal(job.attempts, 1);
  assert.equal(job.maxAttempts, 3);
  assert.equal(job.lockedBy, "w1");

  // A claimed job is not handed out again.
  assert.deepEqual(await transport.claim({ queues: ["work"], limit: 5, ...LEASE }), []);

  await transport.ack(job);
  assert.equal(await transport.getJob(id), null);
});

transportTest("claim only returns due jobs from the requested queues", async ({ transport }) => {
  await transport.enqueue([
    { queue: "a", payload: { n: 1 } },
    { queue: "b", payload: { n: 2 } },
    { queue: "a", payload: { n: 3 }, runAt: Date.now() + 60_000 }
  ]);

  const jobs = await transport.claim({ queues: ["a"], limit: 10, ...LEASE });
  assert.deepEqual(jobs.map(job => job.payload.n), [1]);
  assert.ok(await transport.nextRunAt(["a"]) > Date.now());
});

transportTest("job_key dedupes enqueues", async ({ transport }) => {
  const first = await transport.enqueue([{ queue: "work", jobKey: "k1", payload: { n: 1 } }]);
  const second = await transport.enqueue([{ queue: "work", jobKey: "k1", payload: { n: 2 } }]);

  assert.equal(first.length, 1);
  assert.deepEqual(second, []);

  const jobs = await transport.claim({ queues: ["work"], limit: 10, ...LEASE });
  assert.deepEqual(jobs.map(job => job.payload.n), [1]);
});

transportTest("queue_key runs jobs one at a time in order", async ({ transport }) => {
  await transport.enqueue([
    { queue: "work", queueKey: "obs:1", payload: { n: 1 } },
    { queue: "work", queueKey: "obs:1", payload: { n: 2 } },
    { queue: "work", queueKey: "obs:2", payload: { n: 3 } }
  ]);

  const first = await transport.claim({ queues: ["work"], limit: 10, ...LEASE });
  assert.deepEqual(first.map(job => job.payload.n), [1, 3]);

  // n=2 waits while n=1 runs ...
  assert.deepEqual(await transport.claim({ queues: ["work"], limit: 10, ...LEASE }), []);

  // ... and while n=1 waits for its retry.
  const one = first.find(job => job.payload.n === 1);
  await transport.nack(one, { error: new Error("boom"), runAt: Date.now() + 60_000 });
  assert.deepEqual(await transport.claim({ queues: ["work"], limit: 10, ...LEASE }), []);

  const stored = await transport.getJob(one.id);
  assert.equal(stored.state, "ready");
  assert.equal(stored.lastError, "boom");
});

transportTest("nack schedules a retry and dead jobs stop running", async ({ transport }) => {
  await transport.enqueue([{ queue: "work", queueKey: "k", payload: {}, maxAttempts: 2 }]);
  await transport.enqueue([{ queue: "work", queueKey: "k", payload: { next: true } }]);

  const [job] = await transport.claim({ queues: ["work"], limit: 1, ...LEASE });
  assert.equal(await transport.nack(job, { error: new Error("try again"), runAt: Date.now() - 1 }), true);

  const [again] = await transport.claim({ queues: ["work"], limit: 1, ...LEASE });
  assert.equal(again.id, job.id);
  assert.equal(again.attempts, 2);

  await transport.nack(again, { error: new Error("gave up"), dead: true });
  const dead = await transport.getJob(job.id);
  assert.equal(dead.state, "dead");
  assert.equal(dead.lastError, "gave up");

  const [next] = await transport.claim({ queues: ["work"], limit: 1, ...LEASE });
  assert.deepEqual(next.payload, { next: true });

  const listed = await transport.listJobs({ state: "dead" });
  assert.deepEqual(listed.map(item => item.id), [job.id]);
});

transportTest("ack and nack fail once another worker owns the job", async ({ transport }) => {
  await transport.enqueue([{ queue: "work", payload: {}, maxAttempts: 3 }]);
  const [job] = await transport.claim({ queues: ["work"], limit: 1, leaseMs: -1, workerId: "w1" });

  // The lease is already expired: reclaim hands it back out.
  const reclaimed = await transport.reclaimStalled();
  assert.deepEqual(reclaimed.map(item => [item.id, item.state]), [[job.id, "ready"]]);

  const [other] = await transport.claim({ queues: ["work"], limit: 1, leaseMs: 60_000, workerId: "w2" });
  assert.equal(other.id, job.id);

  await assert.rejects(() => transport.ack(job), LeaseLostError);
  assert.equal(await transport.nack(job, { error: new Error("late") }), false);
  assert.equal(await transport.extend(job, 60_000), false);
  assert.equal(await transport.extend(other, 60_000), true);

  await transport.ack(other);
});

transportTest("stalled jobs without attempts left move to dead", async ({ transport }) => {
  await transport.enqueue([{ queue: "work", payload: {}, maxAttempts: 1 }]);
  await transport.claim({ queues: ["work"], limit: 1, leaseMs: -1, workerId: "w1" });

  const [job] = await transport.reclaimStalled();
  assert.equal(job.state, "dead");
  assert.match(job.lastError, /Lease expired/);
});

transportTest("release gives a job back without counting the attempt", async ({ transport }) => {
  await transport.enqueue([{ queue: "work", payload: {} }]);
  const [job] = await transport.claim({ queues: ["work"], limit: 1, ...LEASE });

  assert.equal(await transport.release(job), true);
  const [again] = await transport.claim({ queues: ["work"], limit: 1, ...LEASE });
  assert.equal(again.attempts, 1);
});

transportTest("enqueue inside a transaction rolls back with it", async ({ transport, handle }) => {
  if (!handle) return; // the memory transport has no rollback

  await assert.rejects(() => transport.transaction(async executor => {
    await transport.enqueue([{ queue: "work", payload: {} }], { executor });
    throw new Error("abort");
  }), /abort/);

  assert.deepEqual(await transport.listJobs({}), []);
});

transportTest("admin redrive and discard update the job and its delivery", async ({ transport, deliveries }) => {
  const admin = createPipelineAdmin({ transport, deliveries });

  for (const key of ["d1", "d2"]) {
    await deliveries.create({
      key,
      observationId: "obs",
      revision: 1,
      destination: "dest",
      plugin: "p",
      decision: "queue",
      output: { kind: "brainstem.output" }
    });
    await transport.enqueue([{ queue: "deliver", jobKey: key, payload: { key } }]);
  }

  for (const job of await transport.claim({ queues: ["deliver"], limit: 2, ...LEASE })) {
    await transport.nack(job, { error: new Error("down"), dead: true });
    await deliveries.update(job.payload.key, { status: "dead", attempts: 1 });
  }

  const [d2, d1] = await transport.listJobs({ state: "dead" });

  const redriven = await admin.redrive(d1.id);
  assert.equal(redriven.state, "ready");
  assert.equal(redriven.attempts, 0);
  assert.equal((await deliveries.get("d1")).status, "pending");

  await admin.discard(d2.id);
  assert.equal(await transport.getJob(d2.id), null);
  assert.equal((await deliveries.get("d2")).status, "discarded");

  // Only dead jobs can be redriven or discarded.
  assert.equal(await admin.redrive(d1.id), null);

  const summary = await admin.summary();
  assert.deepEqual(summary.deliveries, { pending: 1, discarded: 1 });
  assert.deepEqual(
    summary.jobs.map(({ queue, state, count }) => ({ queue, state, count })),
    [{ queue: "deliver", state: "ready", count: 1 }]
  );
});

transportTest("delivery prune keeps dead and pending rows", async ({ deliveries }) => {
  for (const [key, status] of [["a", "delivered"], ["b", "dead"], ["c", "pending"], ["d", "discarded"]]) {
    await deliveries.create({ key, observationId: key, revision: 1, destination: "x", plugin: "p", decision: "queue", output: {} });
    await deliveries.update(key, { status });
  }

  const deleted = await deliveries.prune({ olderThan: new Date(Date.now() + 1_000).toISOString() });
  assert.equal(deleted, 2);
  assert.deepEqual((await deliveries.list({})).map(row => row.key).sort(), ["b", "c"]);
});

transportTest("concurrent claimers never share a job", async ({ transport }) => {
  await transport.enqueue(
    Array.from({ length: 40 }, (_, n) => ({ queue: "work", payload: { n } }))
  );

  const claimed = (await Promise.all(
    Array.from({ length: 8 }, (_, worker) =>
      transport.claim({ queues: ["work"], limit: 10, leaseMs: 60_000, workerId: `w${worker}` })
    )
  )).flat();

  const ids = claimed.map(job => job.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 40);
});

test("backoff grows exponentially, is capped and jittered", () => {
  const retry = normalizeJobRetry({ attempts: 5, minDelayMs: 1_000, maxDelayMs: 5_000, factor: 2, jitter: false });
  assert.deepEqual([1, 2, 3, 4].map(attempt => backoffDelayMs(retry, attempt)), [1_000, 2_000, 4_000, 5_000]);

  const jittered = normalizeJobRetry({ minDelayMs: 1_000, maxDelayMs: 1_000 });
  assert.equal(backoffDelayMs(jittered, 1, () => 0), 500);
  assert.equal(backoffDelayMs(jittered, 1, () => 1), 1_000);
});

test("runner retries failed jobs and dead-letters them after max attempts", async () => {
  const transport = new MemoryTransport();
  const failures = [];
  let calls = 0;

  const runner = new JobRunner({
    transport,
    queues: {
      work: {
        concurrency: 2,
        retry: normalizeJobRetry({ minDelayMs: 0, maxDelayMs: 0 }),
        async handler() {
          calls += 1;
          throw new Error(`fail ${calls}`);
        },
        onFailure(job, error, details) {
          failures.push({ attempts: job.attempts, message: error.message, ...details });
        }
      }
    }
  });

  await transport.enqueue([{ queue: "work", payload: {}, maxAttempts: 3 }]);
  const result = await runner.drain();

  assert.equal(calls, 3);
  assert.equal(result.processed, 0);
  assert.deepEqual(failures.map(item => [item.attempts, item.dead]), [[1, false], [2, false], [3, true]]);
  assert.equal((await transport.listJobs({ state: "dead" })).length, 1);
});

test("runner dead-letters permanent errors immediately", async () => {
  const transport = new MemoryTransport();
  const runner = new JobRunner({
    transport,
    queues: {
      work: {
        async handler() {
          throw new PermanentJobError("not configured");
        }
      }
    }
  });

  await transport.enqueue([{ queue: "work", payload: {}, maxAttempts: 10 }]);
  const result = await runner.drain();

  assert.deepEqual(result.failures.map(item => item.dead), [true]);
  const [dead] = await transport.listJobs({ state: "dead" });
  assert.equal(dead.attempts, 1);
});

test("runner commits stage outputs atomically with the ack", async () => {
  const transport = new MemoryTransport();
  const seen = [];

  const runner = new JobRunner({
    transport,
    queues: {
      first: {
        async handler(job, { commit }) {
          await commit(executor =>
            transport.enqueue([{ queue: "second", payload: { from: job.id } }], { executor })
          );
        }
      },
      second: {
        async handler(job) {
          seen.push(job.payload.from);
        }
      }
    }
  });

  const [id] = await transport.enqueue([{ queue: "first", payload: {} }]);
  const result = await runner.drain();

  assert.equal(result.processed, 2);
  assert.deepEqual(seen, [id]);
  assert.deepEqual(await transport.listJobs({}), []);
});

test("runner start() wakes on enqueue and releases jobs on shutdown", async () => {
  const transport = new MemoryTransport();
  const controller = new AbortController();
  const done = [];
  let blockedStarted;
  const blockedRunning = new Promise(resolve => { blockedStarted = resolve; });

  const runner = new JobRunner({
    transport,
    pollIntervalMs: 60_000,
    queues: {
      work: {
        concurrency: 2,
        async handler(job, { signal }) {
          if (job.payload.block) {
            blockedStarted();
            await new Promise((resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          }
          done.push(job.payload.n);
        }
      }
    }
  });

  const running = runner.start(controller.signal);

  await transport.enqueue([{ queue: "work", payload: { n: 1 } }]);
  await transport.enqueue([{ queue: "work", payload: { n: 2, block: true } }]);
  await blockedRunning;

  controller.abort();
  await running;

  assert.deepEqual(done, [1]);
  const [released] = await transport.listJobs({});
  assert.equal(released.state, "ready");
  assert.equal(released.attempts, 0);
});

test("runner does not spin while a due job waits behind its queue_key", async () => {
  const transport = new MemoryTransport();
  const controller = new AbortController();
  let claims = 0;
  const claim = transport.claim.bind(transport);
  transport.claim = async options => {
    claims += 1;
    return await claim(options);
  };

  const order = [];
  let release;
  const blocking = new Promise(resolve => { release = resolve; });

  const runner = new JobRunner({
    transport,
    pollIntervalMs: 200,
    queues: {
      work: {
        concurrency: 4,
        async handler(job) {
          if (job.payload.n === 1) await blocking;
          order.push(job.payload.n);
        }
      }
    }
  });

  await transport.enqueue([
    { queue: "work", queueKey: "same", payload: { n: 1 } },
    { queue: "work", queueKey: "same", payload: { n: 2 } }
  ]);

  const running = runner.start(controller.signal);
  await new Promise(resolve => setTimeout(resolve, 300));
  const claimsWhileBlocked = claims;
  release();

  const deadline = Date.now() + 2_000;
  while (order.length < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  controller.abort();
  await running;

  assert.deepEqual(order, [1, 2]);
  assert.ok(claimsWhileBlocked <= 5, `expected a few claims while blocked, got ${claimsWhileBlocked}`);
});
