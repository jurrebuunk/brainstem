import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import config from "../brainstem.config.example.mjs";
import { Brainstem, createObservation } from "../src/core/brainstem.mjs";
import { SqliteRecordStore } from "../src/core/record-stores.mjs";
import { BrainstemRuntime } from "../src/runtime/runtime.mjs";
import httpHealthPlugin from "../plugins/http-health/index.mjs";
import matrixPlugin from "../plugins/matrix/index.mjs";
import { resetNotificationState } from "../plugins/matrix/notify.mjs";
import { evaluateCertificate } from "../plugins/tls-certificate/check.mjs";

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

test("http health input emits unhealthy observations", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    status: 503,
    statusText: "Service Unavailable"
  });

  try {
    const observations = [];

    for await (
      const observation of httpHealthPlugin.inputs.check.poll({
        config: {
          url: "https://example.com/health",
          name: "example",
          minimumDecisionOnFailure: "dispatch"
        },
        signal: new AbortController().signal,
        observation: createObservation
      })
    ) {
      observations.push(observation);
    }

    assert.equal(observations.length, 1);
    assert.equal(observations[0].payload.source.type, "http");
    assert.equal(observations[0].payload.type, "health_check");
    assert.equal(observations[0].payload.state, "unhealthy");
    assert.equal(observations[0].payload.facts.minimum_decision, "dispatch");
    assert.equal(observations[0].payload.data.status, 503);
  }
  finally {
    globalThis.fetch = originalFetch;
  }
});

test("http health input respects failure and recovery thresholds", async () => {
  const originalFetch = globalThis.fetch;
  const statuses = [503, 503, 503, 200, 200];
  let checkpoint;
  const emitted = [];

  globalThis.fetch = async () => {
    const status = statuses.shift();

    return {
      status,
      statusText:
        status === 200
          ? "OK"
          : "Service Unavailable"
    };
  };

  try {
    for (let index = 0; index < 5; index += 1) {
      const deferred = { value: undefined };

      const ctx = {
        config: {
          url: "https://example.com/health",
          name: "example",
          failureThreshold: 3,
          recoveryThreshold: 2,
          minimumDecisionOnFailure: "dispatch"
        },
        signal: new AbortController().signal,
        observation: createObservation,
        checkpoint: {
          async get() {
            return checkpoint;
          },
          defer(value) {
            deferred.value = value;
          }
        }
      };

      for await (const observation of httpHealthPlugin.inputs.check.poll(ctx)) {
        emitted.push(observation.payload.state);
      }

      checkpoint = deferred.value;
    }
  }
  finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(emitted, [
    "unhealthy",
    "healthy"
  ]);
});

test("tls certificate evaluation detects expiring certificates", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");

  const result = evaluateCertificate(
    {
      warnDays: 14,
      criticalDays: 3,
      checkAuthorization: true
    },
    {
      authorized: true,
      authorizationError: null,
      certificate: {
        valid_to: "Jan 05 00:00:00 2026 GMT",
        fingerprint256: "AA:BB"
      }
    },
    now
  );

  assert.equal(result.state, "expiring");
  assert.equal(result.daysRemaining, 4);
});

test("matrix destination sends room messages", async () => {
  resetNotificationState();

  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });

    return {
      ok: true,
      status: 200,
      statusText: "OK"
    };
  };

  try {
    await matrixPlugin.destinations.room.handle(
      {
        config: {
          homeserver: "https://matrix.example",
          roomId: "!room:example",
          accessToken: "secret",
          notify: {
            statePath: false
          }
        },
        signal: new AbortController().signal,
        logger: console
      },
      {
        decision: {
          payload: {
            decision: "dispatch",
            route: "infrastructure",
            reason: "test reason"
          }
        },
        observation: {
          payload: {
            id: "http:example:health",
            source: {
              type: "http",
              name: "example"
            },
            type: "health_check",
            state: "unhealthy",
            title: "example is unhealthy",
            data: {
              url: "https://example.com/health"
            }
          }
        }
      }
    );

    assert.equal(calls.length, 1);
    assert.match(
      calls[0].url,
      /^https:\/\/matrix\.example\/_matrix\/client\/v3\/rooms\//
    );
    assert.equal(calls[0].options.method, "PUT");
    assert.equal(calls[0].options.headers.authorization, "Bearer secret");

    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.msgtype, "m.text");
    assert.match(body.body, /Brainstem alert/);
    assert.match(body.body, /example is unhealthy/);
    assert.match(body.body, /Decision: DISPATCH/);
  }
  finally {
    globalThis.fetch = originalFetch;
  }
});

test("matrix destination suppresses repeats and sends recovery", async () => {
  resetNotificationState();

  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });

    return {
      ok: true,
      status: 200,
      statusText: "OK"
    };
  };

  const ctx = {
    config: {
      homeserver: "https://matrix.example",
      roomId: "!room:example",
      accessToken: "secret",
      notify: {
        repeatAfterMs: 60 * 60 * 1000,
        onRecovery: true,
        statePath: false
      }
    },
    signal: new AbortController().signal,
    logger: console
  };

  const alertEvent = matrixEvent({
    id: "http:repeat-test",
    decision: "dispatch",
    state: "unhealthy"
  });

  await matrixPlugin.destinations.room.handle(ctx, alertEvent);
  await matrixPlugin.destinations.room.handle(ctx, alertEvent);

  const recoveryEvent = matrixEvent({
    id: "http:repeat-test",
    decision: "ignore",
    state: "healthy"
  });

  await matrixPlugin.destinations.room.handle(ctx, recoveryEvent);

  globalThis.fetch = originalFetch;

  assert.equal(calls.length, 2);

  const firstBody = JSON.parse(calls[0].options.body).body;
  const secondBody = JSON.parse(calls[1].options.body).body;

  assert.match(firstBody, /Brainstem alert/);
  assert.match(firstBody, /Decision: DISPATCH/);
  assert.match(secondBody, /Brainstem recovery/);
});

test("matrix destination retries rate limits and threads repeats", async () => {
  resetNotificationState();

  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (_url, options) => {
    calls.push(options);

    if (calls.length === 1) {
      return {
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: {
          get() {
            return null;
          }
        },
        async text() {
          return JSON.stringify({
            error: "rate limited",
            retry_after_ms: 1
          });
        }
      };
    }

    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return {
          event_id: `$event${calls.length}`
        };
      }
    };
  };

  const ctx = {
    config: {
      homeserver: "https://matrix.example",
      roomId: "!room:example",
      accessToken: "secret",
      notify: {
        repeatAfterMs: 0,
        statePath: false
      },
      retry: {
        attempts: 2,
        minDelayMs: 0,
        maxDelayMs: 1,
        factor: 1
      },
      threading: true
    },
    signal: new AbortController().signal,
    logger: console
  };

  const event = matrixEvent({
    id: "http:thread-test",
    decision: "dispatch",
    state: "unhealthy"
  });

  await matrixPlugin.destinations.room.handle(ctx, event);
  await matrixPlugin.destinations.room.handle(ctx, event);

  globalThis.fetch = originalFetch;

  assert.equal(calls.length, 3);

  const repeated = JSON.parse(calls[2].body);

  assert.equal(
    repeated["m.relates_to"].event_id,
    "$event2"
  );
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
        module: "./plugins/static-observations/index.mjs",
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

function matrixEvent({
  id,
  decision,
  state
}) {
  return {
    decision: {
      payload: {
        observation_id: id,
        decision,
        route:
          decision === "ignore"
            ? null
            : "infrastructure",
        reason: "test reason",
        fingerprint: `${id}:${state}`
      }
    },
    observation: {
      payload: {
        id,
        source: {
          type: "http",
          name: "example"
        },
        type: "health_check",
        state,
        title: `example is ${state}`,
        data: {
          url: "https://example.com/health"
        }
      }
    }
  };
}

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
