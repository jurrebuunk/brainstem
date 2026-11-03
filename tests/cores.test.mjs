import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { BrainstemRuntime } from "../src/runtime/runtime.mjs";
import { createCoreRegistry, topologyFromCores } from "../src/runtime/cores.mjs";
import { dialectTest } from "./helpers/database.mjs";
import {
  countingInputSource,
  fakeBrainstem,
  minimalPolicyConfig,
  silentLogger,
  tempDir,
  writePlugin
} from "./helpers/fixtures.mjs";

const topology = (destinations = ["log-triage"]) => ({
  inputs: [{ id: "app-log", plugin: "@brainstem/log-file", input: "lines" }],
  destinations: destinations.map(id => ({ id, plugin: "@brainstem/agentos-runner", destination: "default" }))
});

dialectTest("core registry tracks running, lost and stopped cores", async ({ handle }) => {
  const registry = createCoreRegistry({ database: async () => handle });
  const t0 = Date.parse("2026-11-02T12:00:00.000Z");

  await registry.register({ id: "core-a", queues: ["poll", "decide", "deliver"], heartbeatMs: 10_000, topology: topology(), now: t0 });
  await registry.register({ id: "core-b", heartbeatMs: 10_000, topology: topology(), now: t0 });
  await registry.register({ id: "core-c", heartbeatMs: 10_000, topology: topology(), now: t0 });

  await registry.heartbeat("core-a", { now: t0 + 60_000 });
  await registry.stop("core-c", { now: t0 + 5_000 });

  const cores = await registry.list({ now: t0 + 61_000 });
  const byId = Object.fromEntries(cores.map(core => [core.id, core]));

  assert.deepEqual(cores.map(core => core.id), ["core-a", "core-c", "core-b"], "most recently seen first");
  assert.equal(byId["core-a"].status, "running");
  assert.deepEqual(byId["core-a"].queues, ["poll", "decide", "deliver"]);
  assert.equal(byId["core-a"].lastSeenAt, "2026-11-02T12:01:00.000Z");
  assert.equal(byId["core-b"].status, "lost", "no heartbeat for more than 3 intervals");
  assert.equal(byId["core-c"].status, "stopped");
  assert.equal(byId["core-c"].stoppedAt, "2026-11-02T12:00:05.000Z");
  assert.equal(byId["core-a"].pid, process.pid);
  assert.match(byId["core-a"].version, /^\d+\.\d+\.\d+/);

  // Re-registering the same id (a restart with a fixed coreId) updates the row.
  await registry.register({ id: "core-c", heartbeatMs: 10_000, topology: topology(), now: t0 + 61_000 });
  assert.equal((await registry.list({ now: t0 + 61_000 })).find(core => core.id === "core-c").status, "running");

  assert.equal(await registry.prune({ olderThanMs: 30_000, now: t0 + 61_000 }), 1, "only core-b went silent long enough");
  assert.deepEqual((await registry.list({ now: t0 + 61_000 })).map(core => core.id).sort(), ["core-a", "core-c"]);
});

test("topologyFromCores serves the freshest running core and flags disagreement", () => {
  const core = (id, status, destinations) => ({ id, status, topologyHash: destinations.join(","), topology: topology(destinations) });

  const agreeing = topologyFromCores([core("a", "running", ["x"]), core("b", "running", ["x"]), core("c", "stopped", ["old"])]);
  assert.equal(agreeing.source.coreId, "a");
  assert.equal(agreeing.consistent, true);
  assert.deepEqual(agreeing.destinations.map(destination => destination.id), ["x"]);

  const drifting = topologyFromCores([core("a", "running", ["x"]), core("b", "running", ["y"])]);
  assert.equal(drifting.consistent, false, "running cores loaded different configs");

  const allStopped = topologyFromCores([core("c", "stopped", ["old"])]);
  assert.equal(allStopped.source.coreId, "c", "falls back to the last core seen");

  assert.deepEqual(topologyFromCores([]), { source: null, configVersion: null, consistent: true, inputs: [], destinations: [] });

  // Cores running different queues: merged, still consistent.
  const deliverOnly = { ...core("d", "running", ["x"]), queues: ["deliver"], topology: { inputs: [], destinations: topology(["x"]).destinations } };
  const pollOnly = { ...core("p", "running", []), queues: ["poll"], topology: { inputs: topology(["x"]).inputs, destinations: [] } };
  const split = topologyFromCores([pollOnly, deliverOnly]);
  assert.equal(split.consistent, true, "cores running different queues agree");
  assert.equal(topologyFromCores([
    { ...pollOnly, configVersion: 2 },
    { ...deliverOnly, configVersion: 2, topology: { inputs: [{ id: "only-ids" }], destinations: [] } }
  ]).consistent, true, "same config version");
  assert.deepEqual(split.destinations.map(destination => destination.id), ["x"]);
  assert.equal(split.inputs.length, topology(["x"]).inputs.length);

  const versions = topologyFromCores([
    { ...core("a", "running", ["x"]), configVersion: 3 },
    { ...core("b", "running", ["x"]), configVersion: 4 }
  ]);
  assert.equal(versions.consistent, false, "running cores on different config versions");
  assert.equal(versions.configVersion, null);
});

dialectTest("a runtime registers itself with its topology and marks itself stopped", async ({ handle }) => {
  const dir = await tempDir("cores-runtime");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource());
  const destinationPath = await writePlugin(dir, "destination.mjs", `
export default {
  apiVersion: "brainstem.destination/v2",
  name: "noop-destination",
  destinations: { default: { async handle() {} } }
};
`);

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: {
      ...minimalPolicyConfig,
      runtime: {
        coreId: "core-test",
        checkpoints: { type: "database", legacyPath: false },
        retry: { attempts: 1, minDelayMs: 0, maxDelayMs: 0, factor: 1 }
      }
    },
    logger: silentLogger,
    database: handle,
    plugins: [{ id: "counter", module: inputPath }],
    destinations: [
      { id: "task-a", module: destinationPath },
      { id: "task-b", module: destinationPath }
    ]
  });

  await runtime.runOnce();

  const [core] = await createCoreRegistry({ database: async () => handle }).list();
  assert.equal(core.id, "core-test");
  assert.equal(core.status, "stopped");
  assert.equal(core.role, "all");
  assert.deepEqual(core.topology.inputs.map(input => input.id), ["counter"]);
  assert.deepEqual(
    core.topology.destinations.map(destination => [destination.id, destination.plugin]),
    [["task-a", "noop-destination"], ["task-b", "noop-destination"]],
    "two entries of one plugin keep their own ids"
  );
});

test("a runtime without a database does not open one for the registry", async () => {
  const dir = await tempDir("cores-memory");
  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: {
      ...minimalPolicyConfig,
      runtime: {
        records: { type: "memory" },
        checkpoints: { type: "json", path: join(dir, "checkpoints.json") }
      }
    },
    logger: silentLogger
  });

  assert.equal(runtime.coreRegistry, null);
});

test("inputs come from the cores that poll them, destinations from the cores that run them", () => {
  const core = (id, queues, topology) => ({ id, status: "running", queues, configVersion: 3, topologyHash: id, topology });
  const topology = topologyFromCores([
    core("deliver", ["deliver"], {
      inputs: [{ id: "health", module: "./plugins/http-health/index.mjs", input: "check" }],
      destinations: [{ id: "tickets", plugin: "@brainstem/http-json", destination: "default" }]
    }),
    core("poll", ["poll"], {
      inputs: [{ id: "health", module: "./plugins/http-health/index.mjs", input: "check", plugin: "@brainstem/http-health", intervalMs: 20000 }],
      destinations: [{ id: "tickets" }]
    })
  ]);

  assert.equal(topology.inputs[0].plugin, "@brainstem/http-health");
  assert.equal(topology.inputs[0].intervalMs, 20000);
  assert.equal(topology.destinations[0].plugin, "@brainstem/http-json");
});
