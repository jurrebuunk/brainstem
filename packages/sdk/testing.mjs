/*
 * Test helpers for plugin authors: run a plugin the way the runtime
 * does, without a runtime.
 *
 *   import { runInput, runDestination, createTestOutput } from "@brainstem-dev/sdk/testing";
 *
 *   const { observations, checkpoint } = await runInput(plugin, {
 *     config: { url: "http://127.0.0.1:9999/health" },
 *     checkpoint: { since: "2026-01-01" }
 *   });
 *
 *   const { emitted, logs } = await runDestination(plugin, createTestOutput({
 *     observation: observations[0],
 *     decision: "dispatch"
 *   }), { config: { url: "http://127.0.0.1:9999/hook" } });
 *
 * Pass the same `state` (a MemoryPluginStateStore) to several runs to
 * test plugins that keep state between polls or deliveries, and the
 * returned `checkpoint` as the next run's checkpoint.
 */
import {
  MemoryPluginStateStore,
  assertObservation,
  createDestinationContext,
  createInputContext,
  createObservation,
  createOutputEnvelope,
  validateDestinationPlugin,
  validateInputPlugin
} from "./index.mjs";

/*
 * One poll. Resolves to the emitted observations (validated like
 * the runtime does), the checkpoint after the poll (the deferred one
 * if the input set it, else the one passed in), and the plugin's logs.
 */
export async function runInput(plugin, {
  input = "default",
  id = input,
  config = {},
  checkpoint,
  state = new MemoryPluginStateStore(),
  signal = new AbortController().signal,
  lease = null
} = {}) {
  validateInputPlugin(plugin);

  const definition = plugin.inputs[input];
  if (!definition) throw new Error(`Input plugin '${plugin.name}' has no input '${input}'`);

  const logs = createTestLogger();
  let deferred = false;
  let next;

  const ctx = createInputContext({
    config,
    signal,
    logger: logs.logger,
    checkpoint: {
      async get() {
        return clone(checkpoint);
      },
      defer(value) {
        if (value === undefined) throw new TypeError("checkpoint cannot be undefined");
        deferred = true;
        next = clone(value);
      }
    },
    stateStore: state,
    plugin: plugin.name,
    input,
    id,
    lease
  });

  const observations = [];
  for await (const observation of toAsyncIterable(definition.poll(ctx))) {
    observations.push(assertObservation(observation));
  }

  return {
    observations,
    checkpoint: deferred ? next : checkpoint,
    checkpointDeferred: deferred,
    logs: logs.entries,
    state
  };
}

/*
 * One delivery. Resolves to the observations the destination handed
 * back (ctx.emit) and its logs; rejects with the error it threw.
 */
export async function runDestination(plugin, output, {
  destination = "default",
  id = destination,
  config = {},
  idempotencyKey = output?.payload?.idempotencyKey ?? "test-delivery-key",
  attempt = 1,
  traceparent = null,
  state = new MemoryPluginStateStore(),
  signal = new AbortController().signal
} = {}) {
  validateDestinationPlugin(plugin);

  const definition = plugin.destinations[destination];
  if (!definition) throw new Error(`Destination plugin '${plugin.name}' has no destination '${destination}'`);

  const logs = createTestLogger();
  const emitted = [];

  const ctx = createDestinationContext({
    config,
    signal,
    logger: logs.logger,
    stateStore: state,
    plugin: plugin.name,
    destination,
    id,
    idempotencyKey,
    attempt,
    traceparent,
    emit(observation) {
      emitted.push(clone(assertObservation(observation)));
    }
  });

  await definition.handle(ctx, clone(output));

  return { emitted, logs: logs.entries, state };
}

/*
 * A brainstem.output envelope like the runtime delivers, from an
 * observation (envelope or payload fields) and a decision name.
 */
export function createTestOutput({
  observation = {},
  decision = "dispatch",
  route = "default",
  reason = "test",
  revision = 1,
  pollId = "test-poll",
  idempotencyKey = "test-delivery-key",
  input = { id: "test-input", plugin: "test", name: "default", module: null },
  destination = { id: "test-destination", plugin: "test", name: "default", module: null }
} = {}) {
  const envelope = observation.kind === "observation"
    ? observation
    : createObservation({
        id: "test:1",
        source: { type: "test", name: "test" },
        type: "item",
        state: "new",
        title: "Test observation",
        message: "A test observation",
        ...observation
      });

  return createOutputEnvelope({
    decision: {
      version: "1",
      kind: "decision",
      payload: {
        observation_id: envelope.payload.id,
        revision,
        decision,
        route,
        reason
      }
    },
    observation: envelope,
    pollId,
    idempotencyKey,
    input,
    origin: { kind: "input", id: input.id },
    destination
  });
}

function createTestLogger() {
  const entries = [];
  const log = level => (message, fields) => entries.push({ level, message, fields });

  return {
    entries,
    logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") }
  };
}

// The same rules as the runtime: an iterable, async iterable or
// array of observations, or nothing.
async function* toAsyncIterable(value) {
  const resolved = await value;
  if (!resolved) return;

  if (typeof resolved[Symbol.asyncIterator] === "function" || typeof resolved[Symbol.iterator] === "function") {
    yield* resolved;
    return;
  }

  throw new TypeError("poll(ctx) must return an iterable, async iterable, or array of observations");
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
