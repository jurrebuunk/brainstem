import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "../src/db/database.mjs";
import {
  DatabasePluginStateStore,
  MemoryPluginStateStore,
  pluginStateNamespace
} from "../src/runtime/plugin-state.mjs";
import { BrainstemRuntime } from "../src/runtime/runtime.mjs";
import { createDestinationContext, createInputContext } from "../src/sdk/index.mjs";
import matrixPlugin from "../plugins/matrix/index.mjs";
import { dialectTest } from "./helpers/database.mjs";
import {
  countingInputSource,
  fakeBrainstem,
  runtimeConfig,
  silentLogger,
  tempDir,
  writePlugin
} from "./helpers/fixtures.mjs";

const WORKER = fileURLToPath(new URL("./helpers/plugin-state-worker.mjs", import.meta.url));

async function exerciseStore(store) {
  assert.equal(await store.get("ns", "missing"), undefined);

  assert.deepEqual(await store.set("ns", "a", { n: 1, list: [1, 2] }), { n: 1, list: [1, 2] });
  assert.deepEqual(await store.get("ns", "a"), { n: 1, list: [1, 2] });
  assert.equal(await store.get("other", "a"), undefined);

  await store.set("ns", "a", "replaced");
  assert.equal(await store.get("ns", "a"), "replaced");

  assert.equal(await store.update("ns", "u", current => (current ?? 0) + 1), 1);
  assert.equal(await store.update("ns", "u", current => current + 1), 2);
  assert.equal(await store.update("ns", "u", () => undefined), 2, "undefined leaves value unchanged");
  assert.equal(await store.update("ns", "none", () => undefined), undefined);
  assert.equal(await store.get("ns", "none"), undefined);

  await assert.rejects(
    () => store.update("ns", "u", () => {
      throw new Error("boom");
    }),
    /boom/
  );
  assert.equal(await store.get("ns", "u"), 2, "failed update does not write");

  await assert.rejects(() => store.set("ns", "x", undefined), /JSON-serializable/);

  assert.equal(await store.delete("ns", "a"), true);
  assert.equal(await store.delete("ns", "a"), false);
  assert.equal(await store.get("ns", "a"), undefined);
}

async function concurrentIncrements(stores, perStore) {
  await Promise.all(
    stores.flatMap(store =>
      Array.from({ length: perStore }, () =>
        store.update("counter", "value", async current => {
          // Yield so a non-atomic implementation would interleave.
          await new Promise(resolve => setImmediate(resolve));
          return (current ?? 0) + 1;
        })
      )
    )
  );
}

test("memory plugin state store round-trips values", async () => {
  await exerciseStore(new MemoryPluginStateStore());
});

test("memory plugin state store update is atomic", async () => {
  const store = new MemoryPluginStateStore();
  await concurrentIncrements([store], 50);
  assert.equal(await store.get("counter", "value"), 50);
});

dialectTest("database plugin state store round-trips values", async ({ handle }) => {
  await exerciseStore(new DatabasePluginStateStore(handle));
});

dialectTest("database plugin state store update loses no concurrent updates", async ({ handle }) => {
  const store = new DatabasePluginStateStore(handle);

  await concurrentIncrements([store], 30);
  assert.equal(await store.get("counter", "value"), 30);
});

dialectTest("database plugin state store update is atomic across processes", async ({ handle }) => {
  const children = Array.from({ length: 3 }, () =>
    fork(WORKER, [handle.url, "15"], { stdio: "inherit" })
  );

  const codes = await Promise.all(
    children.map(async child => (await once(child, "exit"))[0])
  );

  assert.deepEqual(codes, [0, 0, 0]);
  assert.equal(
    await new DatabasePluginStateStore(handle).get("counter", "value"),
    45
  );
});

/*
 * A second store standing in for another process. node:sqlite is
 * synchronous, so two SQLite connections in one thread would block
 * each other on busy_timeout; SQLite shares the handle (cross-process
 * SQLite is covered by the forked-worker test above).
 */
async function otherProcessHandle(handle, dialect) {
  if (dialect === "sqlite") {
    return { ...handle, async close() {} };
  }

  return openDatabase({ url: handle.url });
}

test("plugin context state is namespaced per plugin and entry", async () => {
  const store = new MemoryPluginStateStore();

  const a = createDestinationContext({ stateStore: store, plugin: "p", destination: "room" });
  const b = createDestinationContext({ stateStore: store, plugin: "p", destination: "room", id: "ops" });
  const c = createInputContext({ stateStore: store, plugin: "p", input: "room" });

  assert.equal(a.state.namespace, "destination:p:room");
  assert.equal(b.state.namespace, "destination:p:room:ops");
  assert.equal(c.state.namespace, "input:p:room");

  await a.state.set("k", 1);
  await b.state.set("k", 2);
  await c.state.update("k", current => (current ?? 0) + 3);

  assert.equal(await a.state.get("k"), 1);
  assert.equal(await b.state.get("k"), 2);
  assert.equal(await c.state.get("k"), 3);
  assert.equal(await store.get("destination:p:room", "k"), 1);

  assert.equal(await a.state.delete("k"), true);
  assert.equal(await a.state.get("k"), undefined);

  assert.throws(() => a.state.get(""), /non-empty strings/);

  // Without a store, contexts fall back to a process-local memory store.
  const fallback = createDestinationContext({ plugin: "p", destination: "fallback" });
  await fallback.state.set("k", "v");
  assert.equal(
    await createDestinationContext({ plugin: "p", destination: "fallback" }).state.get("k"),
    "v"
  );

  assert.equal(
    pluginStateNamespace({ kind: "input", plugin: "x", name: "y", id: "" }),
    "input:x:y"
  );
});

test("runtime passes its plugin state store to destination and input contexts", async () => {
  const dir = await tempDir("plugin-state-runtime");
  const store = new MemoryPluginStateStore();

  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource());
  const destinationPath = await writePlugin(dir, "destination.mjs", `
export default {
  apiVersion: "brainstem.destination/v1",
  name: "stateful-destination",
  destinations: {
    default: {
      async handle(ctx, event) {
        await ctx.state.update("seen", current => [...(current ?? []), event.observation.payload.id]);
      }
    }
  }
};
`);

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    config: runtimeConfig(join(dir, "checkpoints.json")),
    logger: silentLogger,
    pluginState: store,
    plugins: [{ id: "counter", module: inputPath }],
    destinations: [{ id: "main", module: destinationPath, decisions: "all" }]
  });

  await runtime.runOnce();
  await runtime.close();

  assert.deepEqual(
    await store.get("destination:stateful-destination:default:main", "seen"),
    ["counter:0"]
  );
});

function matrixEvent({ id, decision, state }) {
  return {
    decision: {
      payload: {
        observation_id: id,
        decision,
        route: decision === "ignore" ? null : "infrastructure",
        reason: "test reason",
        fingerprint: `${id}:${state}`
      }
    },
    observation: {
      payload: {
        id,
        source: { type: "http", name: "example" },
        type: "health_check",
        state,
        title: `example is ${state}`,
        data: { url: "https://example.com/health" }
      }
    }
  };
}

function matrixConfig(notify = {}) {
  return {
    homeserver: "https://matrix.example",
    roomId: "!room:example",
    accessToken: "secret",
    notify: {
      repeatAfterMs: 60 * 60 * 1000,
      statePath: false,
      ...notify
    }
  };
}

function matrixContext(store, notify) {
  return createDestinationContext({
    config: matrixConfig(notify),
    signal: new AbortController().signal,
    logger: silentLogger,
    stateStore: store,
    plugin: matrixPlugin.name,
    destination: "room"
  });
}

async function withFetch(fake, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake;

  try {
    return await fn();
  }
  finally {
    globalThis.fetch = originalFetch;
  }
}

function okFetch(calls) {
  return async (url, options) => {
    calls.push({ url, options });

    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return { event_id: `$event${calls.length}` };
      }
    };
  };
}

dialectTest("matrix suppresses a repeat sent from another process", async ({ handle, dialect }) => {
  const other = await otherProcessHandle(handle, dialect);
  const calls = [];

  try {
    const processA = matrixContext(new DatabasePluginStateStore(handle));
    const processB = matrixContext(new DatabasePluginStateStore(other));
    const alert = matrixEvent({ id: "http:shared", decision: "dispatch", state: "unhealthy" });

    await withFetch(okFetch(calls), async () => {
      await matrixPlugin.destinations.room.handle(processA, alert);
      await matrixPlugin.destinations.room.handle(processB, alert);

      // Concurrent duplicates across both processes: still nothing new.
      await Promise.all([
        matrixPlugin.destinations.room.handle(processA, alert),
        matrixPlugin.destinations.room.handle(processB, alert)
      ]);

      await matrixPlugin.destinations.room.handle(
        processB,
        matrixEvent({ id: "http:shared", decision: "ignore", state: "healthy" })
      );
    });

    assert.equal(calls.length, 2);
    assert.match(JSON.parse(calls[0].options.body).body, /Brainstem alert/);

    const recovery = JSON.parse(calls[1].options.body);
    assert.match(recovery.body, /Brainstem recovery/);
    assert.equal(recovery["m.relates_to"].event_id, "$event1", "recovery threads on the alert sent by the other process");
  }
  finally {
    await other.close();
  }
});

dialectTest("matrix sends an alert only once when two processes race", async ({ handle, dialect }) => {
  const other = await otherProcessHandle(handle, dialect);
  const calls = [];

  try {
    const processA = matrixContext(new DatabasePluginStateStore(handle));
    const processB = matrixContext(new DatabasePluginStateStore(other));
    const alert = matrixEvent({ id: "http:race", decision: "dispatch", state: "unhealthy" });

    await withFetch(okFetch(calls), () => Promise.all([
      matrixPlugin.destinations.room.handle(processA, alert),
      matrixPlugin.destinations.room.handle(processB, alert)
    ]));

    assert.equal(calls.length, 1);
  }
  finally {
    await other.close();
  }
});

test("matrix releases its claim when sending fails", async () => {
  const store = new MemoryPluginStateStore();
  const ctx = matrixContext(store);
  const alert = matrixEvent({ id: "http:fail", decision: "dispatch", state: "unhealthy" });
  const calls = [];

  await withFetch(async () => {
    throw new Error("network down");
  }, () => assert.rejects(
    () => matrixPlugin.destinations.room.handle(
      { ...ctx, config: { ...ctx.config, retry: { attempts: 1 } } },
      alert
    ),
    /network down/
  ));

  await withFetch(okFetch(calls), () =>
    matrixPlugin.destinations.room.handle(ctx, alert)
  );

  assert.equal(calls.length, 1, "alert is retried after the failed send");
});

test("matrix ignores a stale claim from a crashed process", async () => {
  const store = new MemoryPluginStateStore();
  const ctx = matrixContext(store, { claimTimeoutMs: 1_000 });
  const key = "notification:!room:example|http|example|health_check|http:stale";
  const calls = [];

  await ctx.state.set(key, {
    status: "active",
    fingerprint: "http:stale:unhealthy",
    lastSentAt: Date.now() - 10_000,
    pending: { id: "crashed", at: Date.now() - 10_000, previous: null }
  });

  await withFetch(okFetch(calls), () =>
    matrixPlugin.destinations.room.handle(
      ctx,
      matrixEvent({ id: "http:stale", decision: "dispatch", state: "unhealthy" })
    )
  );

  assert.equal(calls.length, 1);
  assert.match(JSON.parse(calls[0].options.body).body, /Brainstem alert/);
  assert.equal((await ctx.state.get(key)).pending, undefined);
});

test("matrix imports the legacy notification state file once", async () => {
  const dir = await tempDir("matrix-legacy");
  const statePath = join(dir, "matrix-notifications.json");
  const legacyKey = "!room:example|http|example|health_check|http:legacy";
  const legacy = {
    [legacyKey]: {
      status: "active",
      fingerprint: "http:legacy:unhealthy",
      decision: "dispatch",
      observationState: "unhealthy",
      rootEventId: "$legacy",
      eventId: "$legacy",
      lastSentAt: Date.now(),
      updatedAt: new Date().toISOString()
    }
  };
  const legacyJson = JSON.stringify(legacy, null, 2) + "\n";
  await writeFile(statePath, legacyJson);

  const store = new MemoryPluginStateStore();
  const ctx = matrixContext(store, { statePath });
  const calls = [];

  await withFetch(okFetch(calls), async () => {
    // Already active in the legacy file: suppressed, not resent.
    await matrixPlugin.destinations.room.handle(
      ctx,
      matrixEvent({ id: "http:legacy", decision: "dispatch", state: "unhealthy" })
    );

    await matrixPlugin.destinations.room.handle(
      ctx,
      matrixEvent({ id: "http:legacy", decision: "ignore", state: "healthy" })
    );
  });

  assert.equal(calls.length, 1);
  const recovery = JSON.parse(calls[0].options.body);
  assert.match(recovery.body, /Brainstem recovery/);
  assert.equal(recovery["m.relates_to"].event_id, "$legacy");

  assert.equal((await ctx.state.get(`notification:${legacyKey}`)).status, "resolved");
  assert.equal((await ctx.state.get("legacy-import")).imported, 1);
  assert.equal(await readFile(statePath, "utf8"), legacyJson, "legacy file is left untouched");

  // A changed file is not re-imported over database state.
  await writeFile(statePath, legacyJson);
  await withFetch(okFetch(calls), () =>
    matrixPlugin.destinations.room.handle(
      ctx,
      matrixEvent({ id: "http:legacy", decision: "ignore", state: "healthy" })
    )
  );
  assert.equal(calls.length, 1);
});
