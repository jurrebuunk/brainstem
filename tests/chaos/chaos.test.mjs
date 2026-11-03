/*
 * Chaos tests (roadmap Phase 5): real core processes on one Postgres
 * database, each through a TCP proxy, while cores are killed, frozen
 * or cut off and Postgres "fails over".
 *
 * Every scenario checks the cluster guarantees:
 *
 *   - no lost observations: every counter value up to the last one
 *     polled reaches the receiver;
 *   - no observation emitted twice: a stale poller can never commit
 *     (lease fencing), so each observation has exactly one
 *     idempotency key;
 *   - no duplicate effects beyond the documented window: a delivery
 *     repeats only when its core died (or lost the database) after
 *     the receiver acted and before the commit, and then under the
 *     same key, so a receiver that honours the key acts once.
 *
 * Postgres only (BRAINSTEM_TEST_PG_URL). Run with `npm run test:chaos`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { readLines, tempDir } from "../helpers/fixtures.mjs";
import { TEST_PG_URL, isolatedDatabaseUrl } from "../helpers/database.mjs";
import { startProxy } from "./proxy.mjs";

const CORE = fileURLToPath(new URL("./fixtures/core.mjs", import.meta.url));
const options = { skip: TEST_PG_URL ? false : "needs BRAINSTEM_TEST_PG_URL", timeout: 90_000 };

test("SIGKILL mid-poll: another core re-polls from the committed checkpoint", options, async () => {
  const result = await chaos({ cores: 3, env: { CHAOS_POLL_DELAY_MS: 300 } }, async cluster => {
    await cluster.waitFor(line => line.startsWith("poll-start core-0 "), "core-0 polling");
    cluster.kill("core-0", "SIGKILL");
    await cluster.progress(10);
  });

  assertGuarantees(result, { suspects: ["core-0"] });
});

test("SIGKILL mid-delivery: the delivery is retried under the same key", options, async () => {
  let interrupted;

  const result = await chaos({ cores: 3, env: { CHAOS_DELIVERY_DELAY_MS: 400 } }, async cluster => {
    await cluster.waitFor(line => line.startsWith("effect core-0 "), "core-0 delivering");
    cluster.kill("core-0", "SIGKILL");
    await cluster.waitUntil(() => cluster.effects().some(effect => effect.core === "core-0"), "the log read");
    interrupted = cluster.effects().findLast(effect => effect.core === "core-0");

    // The receiver acted, the commit never happened: another core
    // must repeat it, with the same idempotency key.
    await cluster.waitUntil(
      () => cluster.effects().some(effect => effect.key === interrupted.key && effect.core !== "core-0"),
      "another core to complete the interrupted delivery",
      20_000
    );
    await cluster.progress(5);
  });

  assertGuarantees(result, { suspects: ["core-0"] });
});

test("SIGSTOP mid-poll (a long GC pause): the stale poller's commit is fenced", options, async () => {
  const result = await chaos({ cores: 2, env: { CHAOS_POLL_DELAY_MS: 300 } }, async cluster => {
    await cluster.waitFor(line => line.startsWith("poll-start core-0 "), "core-0 polling");
    cluster.kill("core-0", "SIGSTOP");
    // Well past the input lease (1 s) and 3 missed heartbeats.
    await cluster.progress(8);
    cluster.kill("core-0", "SIGCONT");
    await cluster.progress(8);
  });

  assertGuarantees(result, { suspects: ["core-0"] });
  assert.ok(
    result.polls.filter(poll => poll.core === "core-0").length > 1,
    "core-0 rejoined and polled again after the pause"
  );
});

test("Postgres failover: every core loses its connections, then recovers", options, async () => {
  const result = await chaos({ cores: 2, env: { CHAOS_DELIVERY_DELAY_MS: 50 } }, async cluster => {
    await cluster.progress(5);
    for (const proxy of cluster.proxies.values()) proxy.cut();
    await sleep(3_000);
    const before = cluster.effectCount();
    for (const proxy of cluster.proxies.values()) proxy.heal();
    await cluster.progress(10, { from: before, timeoutMs: 30_000 });
  });

  assertGuarantees(result, { suspects: ["core-0", "core-1"] });
});

test("Network partition: a cut-off core's work moves to the others, and it rejoins", options, async () => {
  const result = await chaos({ cores: 2, env: { CHAOS_POLL_DELAY_MS: 100, CHAOS_DELIVERY_DELAY_MS: 100 } }, async cluster => {
    await cluster.progress(5);
    cluster.proxies.get("core-0").partition();
    const before = cluster.effectCount();
    // core-1 keeps the pipeline going on its own.
    await cluster.progress(10, { from: before });
    assert.ok(
      cluster.effects().slice(before).every(effect => effect.core === "core-1"),
      "only core-1 delivers while core-0 is partitioned"
    );
    cluster.proxies.get("core-0").heal();
    const healed = cluster.pollCount("core-0");
    await cluster.waitUntil(() => cluster.pollCount("core-0") > healed, "core-0 polls again", 30_000);
  });

  assertGuarantees(result, { suspects: ["core-0"] });
});

/*
 * Run `cores` processes, then the scenario; afterwards stop every
 * core gracefully (SIGCONT first, in case one is frozen) and parse
 * the shared event log.
 */
async function chaos({ cores, env = {} }, scenario) {
  const dir = await tempDir("chaos");
  const database = await isolatedDatabaseUrl("postgres");
  const target = new URL(database.url);
  const children = new Map();
  const proxies = new Map();
  const log = join(dir, "events.log");

  const lines = async () => readLines(log);
  const parsed = async () => parseEvents(await lines());

  const cluster = {
    proxies,

    kill(name, signal) {
      children.get(name).kill(signal);
    },

    async waitFor(predicate, what, timeoutMs = 15_000) {
      await this.waitUntil(async () => (await lines()).some(predicate), what, timeoutMs);
    },

    async waitUntil(predicate, what, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
        await sleep(25);
      }
    },

    // Wait until `count` more distinct observations got an effect.
    async progress(count, { from = null, timeoutMs = 20_000 } = {}) {
      const start = from ?? this.effectCount();
      await this.waitUntil(
        () => new Set(this.effects().slice(start).map(effect => effect.observationId)).size >= count,
        `${count} more deliveries`,
        timeoutMs
      );
    },

    // Synchronous views over the last read of the log.
    snapshot: { polls: [], effects: [] },
    effects() {
      return this.snapshot.effects;
    },
    effectCount() {
      return this.snapshot.effects.length;
    },
    pollCount(core) {
      return this.snapshot.polls.filter(poll => poll.core === core).length;
    }
  };

  // Keep the synchronous snapshot fresh.
  let refreshing = true;
  const refresher = (async () => {
    while (refreshing) {
      cluster.snapshot = await parsed();
      await sleep(20);
    }
  })();
  const originalWaitUntil = cluster.waitUntil.bind(cluster);
  cluster.waitUntil = async (predicate, what, timeoutMs) => originalWaitUntil(async () => {
    cluster.snapshot = await parsed();
    return predicate();
  }, what, timeoutMs);

  try {
    for (let index = 0; index < cores; index += 1) {
      const name = `core-${index}`;
      const proxy = await startProxy({ host: target.hostname, port: Number(target.port || 5432) });
      proxies.set(name, proxy);

      const url = new URL(database.url);
      url.hostname = "127.0.0.1";
      url.port = String(proxy.port);

      const child = fork(CORE, [dir, name], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: { ...process.env, ...env, CORE_DATABASE_URL: url.toString() }
      });
      children.set(name, child);
      await once(child, "message");
    }

    await scenario(cluster);

    // The guarantees are eventual: give the survivors time to finish
    // what the victims left behind (reclaimed jobs, retried
    // deliveries) before judging. Never settling is a failure.
    await cluster.waitUntil(
      () => gaps(cluster.effects()).length === 0,
      "the cluster to deliver every polled observation",
      30_000
    );
  }
  finally {
    refreshing = false;
    await refresher;

    for (const proxy of proxies.values()) proxy.heal();

    await Promise.all([...children.values()].map(async child => {
      if (child.exitCode !== null || child.signalCode === "SIGKILL") return;
      child.kill("SIGCONT");
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    }));

    for (const proxy of proxies.values()) await proxy.close();
    await database.drop();
  }

  return parsed();
}

function parseEvents(lines) {
  const polls = [];
  const effects = [];

  for (const line of lines) {
    const [kind, core, ...rest] = line.split(" ");
    if (kind === "poll-start") polls.push({ core, count: Number(rest[0]) });
    if (kind === "effect") effects.push({ core, key: rest[0], observationId: rest[1] });
  }

  return { polls, effects };
}

function assertGuarantees({ effects }, { suspects }) {
  assert.ok(effects.length > 0, "something was delivered");

  // No lost observations: every counter value up to the highest
  // delivered one reached the receiver.
  assert.deepEqual(gaps(effects), [], "lost observations");

  // No observation emitted twice: one idempotency key each.
  const keysPerObservation = new Map();
  for (const effect of effects) {
    const keys = keysPerObservation.get(effect.observationId) ?? new Set();
    keys.add(effect.key);
    keysPerObservation.set(effect.observationId, keys);
  }
  const reEmitted = [...keysPerObservation].filter(([, keys]) => keys.size > 1).map(([id]) => id);
  assert.deepEqual(reEmitted, [], "observations emitted twice (a stale poller committed)");

  // Repeated effects only inside the window: the repeated key was
  // first attempted by a core that was killed or lost the database.
  const byKey = new Map();
  for (const effect of effects) byKey.set(effect.key, [...(byKey.get(effect.key) ?? []), effect.core]);
  const unexplained = [...byKey]
    .filter(([, cores]) => cores.length > 1 && !suspects.includes(cores[0]))
    .map(([key, cores]) => `${key} by ${cores.join(", ")}`);
  assert.deepEqual(unexplained, [], "repeated effects outside the at-least-once window");
}

// Counter values missing below the highest delivered one.
function gaps(effects) {
  const delivered = new Set(effects.map(effect => Number(effect.observationId.split(":")[1])));
  const highest = Math.max(-1, ...delivered);
  const missing = [];
  for (let n = 0; n <= highest; n += 1) if (!delivered.has(n)) missing.push(n);
  return missing;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
