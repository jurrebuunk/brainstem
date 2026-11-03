import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { openDatabase } from "../src/db/database.mjs";
import { withSingletonLock } from "../src/db/locks.mjs";
import { createInputLeaseStore, InputLeaseLostError, nextDueAt } from "../src/runtime/input-leases.mjs";
import { createCoreRegistry } from "../src/runtime/cores.mjs";
import { BrainstemRuntime, normalizeCoreQueues } from "../src/runtime/runtime.mjs";
import { createHealthServer } from "../src/runtime/health-server.mjs";
import { createConfigVersionStore, ConfigConflictError } from "../src/config/versions.mjs";
import { mergeBootstrap, validateConfigSpec } from "../src/config/schema.mjs";
import { specFromConfig } from "../src/config/source.mjs";
import { watchActiveConfig } from "../src/config/watch.mjs";
import { validate } from "../src/config/json-schema.mjs";
import { runCli } from "../src/cli/index.mjs";
import exampleConfig from "../brainstem.config.example.mjs";
import { TEST_PG_URL, dialectTest, isolatedDatabaseUrl } from "./helpers/database.mjs";
import {
  countingInputSource,
  fakeBrainstem,
  readLines,
  recordingDestinationSource,
  silentLogger,
  tempDir,
  waitFor,
  writePlugin
} from "./helpers/fixtures.mjs";

// Input leases.

dialectTest("only one core leases a due input, and the epoch fences stale pollers", async ({ handle }) => {
  const leases = createInputLeaseStore({ database: handle });
  await leases.declare([{ id: "in", plugin: "p", input: "default", intervalMs: 1_000 }], { at: 1_000 });

  const [a] = await leases.claim({ ids: ["in"], owner: "a", leaseMs: 500, at: 1_000 });
  assert.equal(a.epoch, 1);
  assert.deepEqual(await leases.claim({ ids: ["in"], owner: "b", leaseMs: 500, at: 1_100 }), [], "leased by a");

  // a stalls past its lease; b takes over with a higher epoch.
  const [b] = await leases.claim({ ids: ["in"], owner: "b", leaseMs: 500, at: 1_600 });
  assert.equal(b.epoch, 2);

  await assert.rejects(leases.fence(a), InputLeaseLostError, "a's checkpoint commit is refused");
  assert.equal(await leases.extend(a, { at: 1_700 }), false);
  await leases.fence(b);

  assert.equal(await leases.release(a, { nextDueAt: 5_000, polled: true }), false, "a cannot reschedule");
  assert.equal(await leases.release(b, { nextDueAt: 5_000, polled: true }), true);
  assert.deepEqual(await leases.claim({ ids: ["in"], owner: "a", at: 4_000 }), [], "not due yet");
  assert.equal(await leases.nextClaimAt(["in"]), 5_000);

  const [input] = await leases.list();
  assert.equal(input.leaseOwner, null);
  assert.equal(input.leaseEpoch, 2);
  assert.ok(input.lastPollAt);
});

dialectTest("leases of stopped or lost cores are reclaimed before they expire", async ({ handle }) => {
  const leases = createInputLeaseStore({ database: handle });
  const cores = createCoreRegistry({ database: async () => handle });
  const now = Date.now();
  await leases.declare([{ id: "x", intervalMs: 1_000 }, { id: "y", intervalMs: 1_000 }], { at: now });

  await cores.register({ id: "stopped-core", heartbeatMs: 1_000, now });
  await cores.register({ id: "lost-core", heartbeatMs: 100, now: now - 10_000 });
  await leases.claim({ ids: ["x"], owner: "stopped-core", leaseMs: 60_000, at: now });
  await leases.claim({ ids: ["y"], owner: "lost-core", leaseMs: 60_000, at: now });
  await cores.stop("stopped-core", { now });

  const taken = await leases.claim({ ids: ["x", "y"], owner: "live", limit: 5, leaseMs: 1_000, at: now + 10 });
  assert.deepEqual(taken.map(lease => lease.id).sort(), ["x", "y"]);
});

dialectTest("a forced claim ignores the schedule but never a live lease", async ({ handle }) => {
  const leases = createInputLeaseStore({ database: handle });
  await leases.declare([{ id: "z", intervalMs: 60_000 }], { at: 0 });
  const [first] = await leases.claim({ ids: ["z"], owner: "a", at: 0 });
  await leases.release(first, { nextDueAt: 999_999 });

  assert.equal((await leases.claim({ ids: ["z"], owner: "a", force: true, at: 10 })).length, 1);
  assert.equal((await leases.claim({ ids: ["z"], owner: "b", force: true, at: 20 })).length, 0);
});

test("next due times are jittered by at most 10% (5 s cap)", () => {
  assert.equal(nextDueAt(1_000, { at: 0, random: () => 0 }), 1_000);
  assert.equal(nextDueAt(1_000, { at: 0, random: () => 1 }), 1_100);
  assert.equal(nextDueAt(600_000, { at: 0, random: () => 1 }), 605_000);
});

dialectTest("jobs held by a stopped or lost core are reclaimed before their lease expires", async ({ handle }) => {
  const { DatabaseTransport } = await import("../src/queue/index.mjs");
  const transport = new DatabaseTransport({ database: handle });
  const cores = createCoreRegistry({ database: async () => handle });
  const now = Date.now();

  await cores.register({ id: "gone", heartbeatMs: 100, now: now - 10_000 });
  await cores.register({ id: "alive", heartbeatMs: 60_000, now });
  await transport.enqueue([{ queue: "deliver", maxAttempts: 3 }, { queue: "deliver", maxAttempts: 3 }]);

  const [lostJob] = await transport.claim({ queues: ["deliver"], limit: 1, leaseMs: 600_000, workerId: "gone" });
  const [liveJob] = await transport.claim({ queues: ["deliver"], limit: 1, leaseMs: 600_000, workerId: "alive" });

  const reclaimed = await transport.reclaimStalled();
  assert.deepEqual(reclaimed.map(job => [job.id, job.state]), [[lostJob.id, "ready"]]);
  await assert.rejects(transport.ack(lostJob), /lost/, "the lost core can no longer ack it");
  await transport.ack(liveJob);
});

// Runtimes sharing one database.

dialectTest("two runtimes on one database poll a shared input one at a time", async ({ handle }) => {
  const dir = await tempDir("cluster-runtimes");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource({ prefix: "c" }));
  const output = join(dir, "deliveries.log");
  const destinationPath = await writePlugin(dir, "destination.mjs", recordingDestinationSource(output));

  const make = name => new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    database: handle,
    logger: silentLogger,
    config: clusterConfig(name),
    plugins: [{ id: "counter", module: inputPath, intervalMs: 30 }],
    destinations: [{ id: "rec", module: destinationPath, decisions: ["queue"], config: { name } }]
  });

  const a = make("a");
  const b = make("b");
  await a.start();
  await b.start();

  try {
    await waitFor(async () => (await readLines(output)).length >= 8, { timeoutMs: 10_000 });
  }
  finally {
    await a.drain({ timeoutMs: 2_000 });
    await b.drain({ timeoutMs: 2_000 });
    await a.close();
    await b.close();
  }

  const ids = (await readLines(output)).map(line => line.split(" ")[1]);
  assert.equal(new Set(ids).size, ids.length, `duplicate deliveries: ${ids.join(", ")}`);

  const [input] = await createInputLeaseStore({ database: handle }).list();
  assert.equal(input.leaseOwner, null, "leases are released on shutdown");
});

dialectTest("drain lets an in-flight delivery finish and stops claiming", async ({ handle }) => {
  const dir = await tempDir("cluster-drain");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource({ prefix: "d" }));
  const output = join(dir, "deliveries.log");
  const destinationPath = await writePlugin(dir, "slow.mjs", `
import { appendFile } from "node:fs/promises";
export default {
  apiVersion: "brainstem.destination/v2",
  name: "slow",
  destinations: { default: { async handle(ctx, output) {
    await appendFile(${JSON.stringify(output)}, "start " + output.payload.observation.payload.id + "\\n");
    await new Promise(resolve => setTimeout(resolve, 400));
    await appendFile(${JSON.stringify(output)}, "done " + output.payload.observation.payload.id + "\\n");
  } } }
};`);

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    database: handle,
    logger: silentLogger,
    config: clusterConfig("drainer"),
    plugins: [{ id: "counter", module: inputPath, intervalMs: 60_000 }],
    destinations: [{ id: "slow", module: destinationPath, decisions: ["queue"] }]
  });

  await runtime.start();
  await waitFor(async () => (await readLines(output)).some(line => line.startsWith("start")), { timeoutMs: 10_000 });

  const draining = runtime.drain({ timeoutMs: 5_000 });
  assert.equal(runtime.health().draining, true);
  assert.equal(await runtime.ready(), false, "not ready while draining");
  await draining;
  await runtime.close();

  assert.deepEqual(await readLines(output), ["start d:0", "done d:0"]);
  const jobs = await handle.db.selectFrom("jobs").selectAll().execute();
  assert.deepEqual(jobs, [], "the delivery committed instead of being released");
});

dialectTest("queues split the pipeline across cores", async ({ handle }) => {
  const dir = await tempDir("cluster-queues");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource({ prefix: "q" }));
  const output = join(dir, "deliveries.log");
  const destinationPath = await writePlugin(dir, "destination.mjs", recordingDestinationSource(output));
  const started = [];

  const make = (name, queues) => new BrainstemRuntime({
    brainstem: { ...fakeBrainstem(), async start() { started.push(name); } },
    database: handle,
    logger: silentLogger,
    config: clusterConfig(name),
    queues,
    plugins: [{ id: "counter", module: inputPath, intervalMs: 50 }],
    destinations: [{ id: "rec", module: destinationPath, decisions: ["queue"], config: { name } }]
  });

  const poller = make("poller", ["poll"]);
  const decider = make("decider", ["decide"]);
  const deliverer = make("deliverer", "deliver");

  await poller.start();
  assert.equal(poller.runner, null, "a poll-only core runs no job queues");
  await decider.start();
  await deliverer.start();

  try {
    await waitFor(async () => (await readLines(output)).length >= 2, { timeoutMs: 10_000 });
  }
  finally {
    for (const runtime of [poller, decider, deliverer]) await runtime.close();
  }

  assert.deepEqual(started, ["decider"], "only the decide core loads the model");
  assert.ok((await readLines(output)).every(line => line.startsWith("deliverer ")), "only the deliver core delivers");

  const cores = await createCoreRegistry({ database: async () => handle }).list();
  assert.deepEqual(
    Object.fromEntries(cores.map(core => [core.id, core.queues])),
    { poller: ["poll"], decider: ["decide"], deliverer: ["deliver"] }
  );
});

test("queue lists are validated", () => {
  assert.deepEqual(normalizeCoreQueues(undefined), ["poll", "decide", "deliver"]);
  assert.deepEqual(normalizeCoreQueues("deliver,poll"), ["poll", "deliver"]);
  assert.throws(() => new BrainstemRuntime({ brainstem: fakeBrainstem(), config: { runtime: { checkpoints: { type: "memory" } } }, queues: ["poll"] }), /needs the database transport/);
  assert.throws(() => new BrainstemRuntime({ brainstem: fakeBrainstem(), config: {}, queues: ["fetch"] }), /Unknown queue/);
});

dialectTest("reconfigure swaps destinations without a restart and records the version", async ({ handle }) => {
  const dir = await tempDir("cluster-reconfigure");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource({ prefix: "r" }));
  const first = join(dir, "first.log");
  const second = join(dir, "second.log");
  const firstPath = await writePlugin(dir, "first.mjs", recordingDestinationSource(first));
  const secondPath = await writePlugin(dir, "second.mjs", recordingDestinationSource(second));

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    database: handle,
    logger: silentLogger,
    config: clusterConfig("reloader"),
    configVersion: 1,
    plugins: [{ id: "counter", module: inputPath, intervalMs: 40 }],
    destinations: [{ id: "one", module: firstPath, decisions: ["queue"] }]
  });

  await runtime.start();

  try {
    await waitFor(async () => (await readLines(first)).length >= 1, { timeoutMs: 10_000 });

    await runtime.reconfigure({
      config: clusterConfig("reloader"),
      plugins: [{ id: "counter", module: inputPath, intervalMs: 40 }],
      destinations: [{ id: "two", module: secondPath, decisions: ["queue"] }],
      configVersion: 2
    });

    const before = (await readLines(first)).length;
    await waitFor(async () => (await readLines(second)).length >= 2, { timeoutMs: 10_000 });
    assert.equal((await readLines(first)).length, before, "the removed destination gets nothing new");
    assert.equal(runtime.health().configVersion, 2);

    // A config that fails to load keeps the running one.
    await assert.rejects(runtime.reconfigure({
      config: clusterConfig("reloader"),
      plugins: [],
      destinations: [{ id: "broken", module: join(dir, "missing.mjs") }],
      configVersion: 3
    }));
    assert.equal(runtime.health().configVersion, 2);
    const count = (await readLines(second)).length;
    await waitFor(async () => (await readLines(second)).length > count, { timeoutMs: 10_000 });
  }
  finally {
    await runtime.close();
  }

  const [core] = await createCoreRegistry({ database: async () => handle }).list();
  assert.equal(core.configVersion, 2);
});

// Notifications and singletons.

test("postgres notifications reach other connections, scoped by schema", { skip: !TEST_PG_URL && "needs BRAINSTEM_TEST_PG_URL" }, async () => {
  const one = await isolatedDatabaseUrl("postgres");

  try {
    const a = await openDatabase({ url: one.url });
    const b = await openDatabase({ url: one.url });
    const other = await openDatabase({ url: TEST_PG_URL });

    try {
      const received = [];
      const foreign = [];
      b.notifier.listen("events", ids => received.push(...ids));
      other.notifier.listen("events", ids => foreign.push(...ids));
      await b.notifier.ready();
      await other.notifier.ready();

      const own = [];
      a.notifier.listen("events", ids => own.push(...ids));
      a.notifier.notify("events", [1, 2]);
      a.notifier.notify("events", [3]);

      await waitFor(() => received.length === 3, { timeoutMs: 5_000 });
      assert.deepEqual(received, [1, 2, 3], "coalesced and delivered to the other process");
      assert.deepEqual(own, [1, 2, 3], "delivered locally once, not again via LISTEN");
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepEqual(foreign, [], "another schema never sees it");
    }
    finally {
      await a.close();
      await b.close();
      await other.close();
    }
  }
  finally {
    await one.drop();
  }
});

dialectTest("singleton locks let one holder run at a time", async ({ handle, dialect }) => {
  let release;
  const holding = new Promise(resolve => { release = resolve; });
  const first = withSingletonLock(handle, "test.singleton", () => holding);

  await new Promise(resolve => setTimeout(resolve, 50));

  let second;
  if (dialect === "postgres") {
    // Another connection pool: as another process would.
    const other = await openDatabase({ url: handle.url });
    try {
      second = await withSingletonLock(other, "test.singleton", async () => "ran");
    }
    finally {
      await other.close();
    }
  }
  else {
    second = await withSingletonLock(handle, "test.singleton", async () => "ran");
  }

  assert.deepEqual(second, { ran: false });
  release("done");
  assert.deepEqual(await first, { ran: true, result: "done" });
  assert.deepEqual(await withSingletonLock(handle, "test.singleton", async () => "again"), { ran: true, result: "again" });
});

// Config as data.

test("the example config is valid; mistakes are reported with their path", () => {
  const { spec, left } = specFromConfig(exampleConfig);
  assert.deepEqual(validateConfigSpec(spec), []);
  assert.ok(left.includes("runtime.database") && left.includes("runtime.api"));

  const errors = validateConfigSpec({
    ...spec,
    destinations: [{ id: "bad id!", decisions: ["maybe"] }],
    runtime: { queue: { decide: { concurrency: 0 } } },
    extra: true
  });

  assert.deepEqual(errors.sort(), [
    "/destinations/0/decisions: must be \"all\" or a list",
    "/destinations/0/id: must match ^[A-Za-z0-9._:-]+$",
    "/destinations/0: must have property 'module'",
    "/extra: is not a known property",
    "/runtime/queue/decide/concurrency: must be >= 1"
  ].sort());

  const withFunction = validateConfigSpec({
    ...spec,
    destinations: [{ module: "x", config: { tools: { send: { run() {} } } } }]
  });
  assert.match(withFunction[0], /\/destinations\/0\/config\/tools\/send\/run: is a function/);
});

test("the json schema validator handles refs, unions and nested errors", () => {
  const schema = {
    $defs: { name: { type: "string", minLength: 2 } },
    type: "object",
    properties: {
      name: { $ref: "#/$defs/name" },
      list: { type: "array", items: { type: "integer", minimum: 0 }, uniqueItems: true },
      mode: { anyOf: [{ const: "all" }, { type: "array" }] }
    },
    required: ["name"]
  };

  assert.deepEqual(validate(schema, { name: "ok", list: [1, 2], mode: "all" }), []);
  assert.deepEqual(
    validate(schema, { name: "x", list: [1, 1, -1], mode: 3 }).map(error => `${error.path} ${error.message}`),
    ["/name must be at least 2 characters", "/list must not contain duplicates", "/list/2 must be >= 0", "/mode does not match any allowed form"]
  );
});

test("bootstrap settings stay per process", () => {
  const merged = mergeBootstrap(
    { runtime: { database: { url: "postgres://local" }, logging: { level: "debug" } } },
    { inputs: [], runtime: { database: { url: "sqlite:stored" }, queue: { pollIntervalMs: 500 } } }
  );

  assert.deepEqual(merged.runtime, {
    database: { url: "postgres://local" },
    logging: { level: "debug" },
    queue: { pollIntervalMs: 500 }
  });
});

dialectTest("config versions are immutable, guarded and announced", async ({ handle }) => {
  const store = createConfigVersionStore({ database: handle });
  const spec = specFromConfig(exampleConfig).spec;
  const announced = [];
  handle.notifier.listen("config", message => announced.push(message.versionId));

  assert.equal(await store.active(), null);

  const v1 = await store.create(spec, { author: "test", expectedActiveId: null });
  assert.equal(v1.id, 1);
  assert.equal((await store.active()).id, 1);

  await assert.rejects(store.create({ ...spec, inputs: [] }, { expectedActiveId: null }), ConfigConflictError);

  const draft = await store.create({ ...spec, inputs: [] }, { activate: false });
  assert.equal((await store.active()).id, 1, "a draft is not active");

  await store.activate(draft.id, { expectedActiveId: 1 });
  assert.equal((await store.activeId()), draft.id);
  await store.activate(1);

  await waitFor(() => announced.length === 3, { timeoutMs: 2_000 });
  assert.deepEqual(announced, [1, draft.id, 1]);
  assert.equal((await store.get(1)).spec.policy.dispatch.attention, spec.policy.dispatch.attention);
});

dialectTest("the config watcher follows the active version", async ({ handle }) => {
  const store = createConfigVersionStore({ database: handle });
  const spec = specFromConfig(exampleConfig).spec;
  const seen = [];

  const watcher = watchActiveConfig({
    store,
    notifier: handle.notifier,
    intervalMs: 0,
    onChange: async version => {
      seen.push(version.id);
      if (version.spec.comment === "explode") throw new Error("reload failed");
    }
  });

  try {
    await store.create(spec);
    await waitFor(() => seen.length === 1, { timeoutMs: 2_000 });
    await store.create({ ...spec, comment: "explode" });
    await waitFor(() => seen.length === 2, { timeoutMs: 2_000 });
    assert.equal(watcher.currentId, 1, "a failed reload is retried later");
  }
  finally {
    await watcher.stop();
  }
});

test("brainstem config import, list, export and activate", async () => {
  const dir = await tempDir("cli-config");
  const database = `sqlite:${join(dir, "brainstem.sqlite")}`;
  const file = join(dir, "brainstem.config.mjs");
  await writePlugin(dir, "brainstem.config.mjs", `
import example from ${JSON.stringify(new URL("../brainstem.config.example.mjs", import.meta.url).href)};
export default { ...example, inputs: [{ id: "a", module: "./x.mjs" }] };`);

  const io = { lines: [], errors: [], out(line) { this.lines.push(line); }, err(line) { this.errors.push(line); } };
  const run = argv => runCli(argv, io);

  assert.equal(await run(["config", "validate", "--file", file, "--database", database]), 0);
  assert.equal(await run(["config", "import", "--file", file, "--database", database, "--comment", "first"]), 0, io.errors.join("\n"));
  assert.match(io.lines.join("\n"), /Stored config version 1 \(active\): 1 inputs, 1 destinations/);
  assert.match(io.lines.join("\n"), /Kept per process, not stored: runtime.database, runtime.api/);

  assert.equal(await run(["config", "import", "--file", file, "--database", database]), 0);
  assert.match(io.lines.at(-2) ?? "", /Unchanged/);

  // Seeding (Helm): never overwrites what is there.
  await writePlugin(dir, "seed.mjs", `
import example from ${JSON.stringify(new URL("../brainstem.config.example.mjs", import.meta.url).href)};
export default { ...example, inputs: [] };`);
  assert.equal(await run(["config", "import", "--if-empty", "--file", join(dir, "seed.mjs"), "--database", database]), 0);
  assert.match(io.lines.at(-1), /Skipped: config version 1 already exists/);

  const out = join(dir, "exported.mjs");
  assert.equal(await run(["config", "export", "--database", database, "--out", out]), 0);
  const exported = (await import(`${new URL(`file://${out}`).href}?t=1`)).default;
  assert.deepEqual(exported.inputs, [{ id: "a", module: "./x.mjs" }]);
  assert.match(await readFile(out, "utf8"), /^\/\/ Brainstem config version 1/);

  assert.equal(await run(["config", "list", "--database", database]), 0);
  assert.match(io.lines.at(-1), /\*\s+1 .* first/);

  assert.equal(await run(["config", "activate", "7", "--database", database]), 1);
  assert.match(io.errors.at(-1), /does not exist/);

  await writePlugin(dir, "bad.mjs", "export default { policy: {}, laya: {} };");
  assert.equal(await run(["config", "validate", "--file", join(dir, "bad.mjs"), "--database", database]), 1);
  assert.match(io.errors.at(-1), /\/policy: must have property 'dispatch'/);
});

// Health endpoints.

dialectTest("core health endpoints report liveness, readiness and startup", async ({ handle }) => {
  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    database: handle,
    logger: silentLogger,
    config: clusterConfig("probed"),
    plugins: [],
    destinations: []
  });
  const health = createHealthServer({ host: "127.0.0.1", port: 0, runtime });
  await health.listen();

  try {
    const get = async path => {
      const response = await fetch(`${health.url}${path}`);
      return { status: response.status, body: await response.json() };
    };

    assert.equal((await get("/livez")).status, 200);
    assert.equal((await get("/readyz")).status, 503, "not started");
    assert.equal((await get("/startupz")).status, 503);

    await runtime.start();
    assert.equal((await get("/readyz")).status, 200);
    const startup = await get("/startupz");
    assert.equal(startup.status, 200);
    assert.equal(startup.body.coreId, "probed");

    await runtime.drain({ timeoutMs: 1_000 });
    assert.equal((await get("/readyz")).status, 503, "draining");
    assert.equal((await get("/livez")).status, 200, "still alive while draining");
  }
  finally {
    await runtime.close();
    await health.close();
  }
});

function clusterConfig(coreId) {
  return {
    runtime: {
      coreId,
      records: { type: "memory" },
      checkpoints: { type: "database", legacyPath: false },
      retry: { attempts: 1, minDelayMs: 0, maxDelayMs: 0, factor: 1 },
      queue: { pollIntervalMs: 20, leaseMs: 2_000 },
      inputs: { leaseMs: 1_000, checkIntervalMs: 20 },
      cores: { heartbeatMs: 200 },
      shutdown: { timeoutMs: 2_000 }
    }
  };
}
