import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import config from "../brainstem.config.mjs";
import { Brainstem, createObservation } from "../core.mjs";
import { SqliteRecordStore } from "../record-stores.mjs";
import { BrainstemRuntime } from "../runtime.mjs";

const minimalPolicyConfig = {
  policy: config.policy,
  laya: config.laya
};

test("input checkpoints commit after successful processing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brainstem-checkpoint-success-"));
  const pluginPath = join(dir, "checkpoint-plugin.mjs");
  const checkpointPath = join(dir, "checkpoints.json");

  await writeFile(pluginPath, checkpointPluginSource());

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: checkpointConfig(checkpointPath),
    plugins: [
      {
        id: "checkpoint-test-input",
        module: pluginPath
      }
    ]
  });

  await runtime.runOnce();

  const saved = JSON.parse(
    await readFile(checkpointPath, "utf8")
  );

  assert.deepEqual(saved, {
    "checkpoint-test-input": {
      count: 1
    }
  });
});

test("input checkpoints are not committed when processing fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brainstem-checkpoint-failure-"));
  const pluginPath = join(dir, "checkpoint-plugin.mjs");
  const checkpointPath = join(dir, "checkpoints.json");

  await writeFile(pluginPath, checkpointPluginSource());

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem({ fail: true }),
    config: checkpointConfig(checkpointPath),
    plugins: [
      {
        id: "checkpoint-test-input",
        module: pluginPath,
        retry: {
          attempts: 1
        }
      }
    ]
  });

  await assert.rejects(
    () => runtime.runOnce(),
    /process failed/
  );

  assert.equal(
    existsSync(checkpointPath),
    false
  );
});

test("sqlite core records are reused after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brainstem-records-"));
  const databasePath = join(dir, "records.sqlite");

  const observation = createObservation({
    id: "persist:test:1",
    source: {
      type: "test",
      name: "persist"
    },
    type: "status",
    state: "open",
    title: "Persistent test",
    message: "Should be evaluated once"
  });

  const firstCounter = { count: 0 };
  const first = new Brainstem(minimalPolicyConfig, {
    store: new SqliteRecordStore({
      path: databasePath
    })
  });

  first.laya = fakeLaya(firstCounter);
  await first.process(observation);
  await first.close();

  const secondCounter = { count: 0 };
  const second = new Brainstem(minimalPolicyConfig, {
    store: new SqliteRecordStore({
      path: databasePath
    })
  });

  second.laya = fakeLaya(secondCounter);
  await second.process({
    ...observation,
    payload: {
      ...observation.payload,
      timestamp: new Date().toISOString()
    }
  });
  await second.close();

  assert.ok(firstCounter.count > 0);
  assert.equal(secondCounter.count, 0);
});

test("destinations can filter by decision, route, source, and type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brainstem-destination-filters-"));
  const destinationPath = join(dir, "destination.mjs");
  const outputPath = join(dir, "output.log");

  await writeFile(
    destinationPath,
    destinationPluginSource(outputPath)
  );

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem({
      decision: "queue",
      route: "coding"
    }),
    config: checkpointConfig(join(dir, "checkpoints.json")),
    plugins: [
      {
        module: "./plugins/static-observations.mjs",
        config: {
          observations: [
            {
              id: "test:filters",
              source: {
                type: "github",
                name: "repo"
              },
              type: "issue",
              state: "open",
              title: "Test",
              message: "Test"
            }
          ]
        }
      }
    ],
    destinations: [
      {
        module: destinationPath,
        decisions: ["queue"],
        routes: ["security"],
        sources: ["github"],
        types: ["issue"],
        config: { name: "wrong-route" }
      },
      {
        module: destinationPath,
        decisions: ["queue"],
        routes: ["coding"],
        sources: ["http"],
        types: ["issue"],
        config: { name: "wrong-source" }
      },
      {
        module: destinationPath,
        decisions: ["queue"],
        routes: ["coding"],
        sources: ["github"],
        types: ["pull_request"],
        config: { name: "wrong-type" }
      },
      {
        module: destinationPath,
        decisions: ["queue"],
        routes: ["coding"],
        sources: ["github"],
        types: ["issue"],
        config: { name: "matched" }
      }
    ]
  });

  await runtime.runOnce();

  const output = await readFile(outputPath, "utf8");

  assert.equal(output.trim(), "matched");
});

function checkpointConfig(path) {
  return {
    policy: config.policy,
    laya: config.laya,
    runtime: {
      records: {
        type: "memory"
      },
      checkpoints: {
        type: "json",
        path
      },
      retry: {
        attempts: 1,
        minDelayMs: 0,
        maxDelayMs: 0,
        factor: 1
      }
    }
  };
}

function fakeBrainstem({
  fail = false,
  decision = "ignore",
  route = null
} = {}) {
  return {
    async start() {},
    async close() {},
    async process(observation) {
      if (fail) {
        throw new Error("process failed");
      }

      return {
        version: "1",
        kind: "decision",
        payload: {
          observation_id: observation.payload.id,
          decision,
          route
        }
      };
    }
  };
}

function fakeLaya(counter) {
  return {
    async systemOne(_state, questions) {
      counter.count += 1;

      const name = Object.keys(questions)[0];
      const answer = name === "route"
        ? {
            choice: "coding",
            probabilities: {
              coding: 1
            }
          }
        : name === "severity"
          ? {
              score: 2
            }
          : {
              noul: 0.9
            };

      return {
        answers: {
          [name]: answer
        }
      };
    },

    async close() {}
  };
}

function checkpointPluginSource() {
  return `
export default {
  apiVersion: "brainstem.input/v1",
  name: "checkpoint-test",
  inputs: {
    default: {
      mode: "poll",
      async *poll(ctx) {
        const checkpoint = await ctx.checkpoint.get();
        const count = checkpoint?.count ?? 0;

        yield ctx.observation({
          id: \`checkpoint:test:\${count}\`,
          source: { type: "checkpoint", name: "test" },
          type: "item",
          state: "new",
          title: \`Item \${count}\`,
          message: \`Checkpoint count \${count}\`
        });

        ctx.checkpoint.defer({ count: count + 1 });
      }
    }
  }
};
`;
}

function destinationPluginSource(outputPath) {
  return `
import { appendFile } from "node:fs/promises";

export default {
  apiVersion: "brainstem.destination/v1",
  name: "destination-test",
  destinations: {
    default: {
      async handle(ctx) {
        await appendFile(${JSON.stringify(outputPath)}, ctx.config.name + "\\n");
      }
    }
  }
};
`;
}
