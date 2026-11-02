import { createObservation } from "../core/brainstem.mjs";
import {
  MemoryPluginStateStore,
  createPluginState,
  pluginStateNamespace
} from "../runtime/plugin-state.mjs";

export {
  createPluginState,
  pluginStateNamespace
};

export const INPUT_PLUGIN_API_VERSION =
  "brainstem.input/v1";

export const DESTINATION_PLUGIN_API_VERSION =
  "brainstem.destination/v2";

/*
 * v1 destinations receive live plugin objects. They keep working
 * through an adapter until 3.0 (ADR-0004), without idempotency
 * keys.
 */
export const DESTINATION_PLUGIN_API_VERSION_V1 =
  "brainstem.destination/v1";

export const DESTINATION_PLUGIN_API_VERSIONS = [
  DESTINATION_PLUGIN_API_VERSION,
  DESTINATION_PLUGIN_API_VERSION_V1
];

export const OUTPUT_ENVELOPE_VERSION = "1";

/*
 * Adapter author helper.
 *
 * This intentionally does very little: it gives plugin authors
 * one stable shape to export and fails early when the shape is wrong.
 */
export function defineInputPlugin(plugin) {
  validateInputPlugin(plugin);

  return plugin;
}

export function validateInputPlugin(plugin) {
  validatePluginBase(
    plugin,
    INPUT_PLUGIN_API_VERSION,
    "Input"
  );

  if (!plugin.inputs || typeof plugin.inputs !== "object") {
    throw new TypeError(
      "Input plugin must define inputs"
    );
  }

  for (const [name, input] of Object.entries(plugin.inputs)) {
    if (!input || typeof input !== "object") {
      throw new TypeError(
        `Input '${name}' must be an object`
      );
    }

    if (input.mode !== "poll") {
      throw new TypeError(
        `Input '${name}' must use mode 'poll' in phase 1`
      );
    }

    if (typeof input.poll !== "function") {
      throw new TypeError(
        `Input '${name}' must define poll(ctx)`
      );
    }
  }
}

export function defineDestinationPlugin(plugin) {
  validateDestinationPlugin(plugin);

  return plugin;
}

export function validateDestinationPlugin(plugin) {
  validatePluginBase(
    plugin,
    DESTINATION_PLUGIN_API_VERSIONS,
    "Destination"
  );

  if (
    !plugin.destinations ||
    typeof plugin.destinations !== "object"
  ) {
    throw new TypeError(
      "Destination plugin must define destinations"
    );
  }

  for (const [name, destination] of Object.entries(plugin.destinations)) {
    if (!destination || typeof destination !== "object") {
      throw new TypeError(
        `Destination '${name}' must be an object`
      );
    }

    if (typeof destination.handle !== "function") {
      throw new TypeError(
        `Destination '${name}' must define handle(ctx, output)`
      );
    }
  }
}

function validatePluginBase(plugin, apiVersions, label) {
  if (!plugin || typeof plugin !== "object") {
    throw new TypeError(
      `${label} plugin must export an object`
    );
  }

  const allowed =
    [apiVersions].flat();

  if (!allowed.includes(plugin.apiVersion)) {
    throw new TypeError(
      `${label} plugin apiVersion must be ${allowed.map(version => `'${version}'`).join(" or ")}`
    );
  }

  if (
    typeof plugin.name !== "string" ||
    plugin.name.length === 0
  ) {
    throw new TypeError(
      `${label} plugin must have a name`
    );
  }
}

/*
 * Used when a context is created without a state store
 * (tests, ad-hoc scripts). Process-local and not durable.
 */
const fallbackStateStore =
  new MemoryPluginStateStore();

export function createInputContext({
  config = {},
  signal,
  logger = console,
  checkpoint,
  stateStore,
  plugin,
  input,
  id
} = {}) {
  return {
    config,
    signal,
    logger,
    checkpoint,
    state: contextState(stateStore, {
      kind: "input",
      plugin,
      name: input,
      id
    }),

    observation(input) {
      return createObservation(input);
    }
  };
}

/*
 * ctx for destination.handle(ctx, output).
 *
 * idempotencyKey is stable across every retry of one delivery and
 * unique per (decision, destination) emission. Pass it on to the
 * receiving system (Idempotency-Key header, Matrix txnId, ...) so
 * a retried delivery has no second effect. attempt starts at 1.
 */
export function createDestinationContext({
  config = {},
  signal,
  logger = console,
  stateStore,
  plugin,
  destination,
  id,
  idempotencyKey = null,
  attempt = 1,
  emit
} = {}) {
  return {
    config,
    signal,
    logger,
    idempotencyKey,
    attempt,
    // emit(observation): hand an observation back to the core
    // (see docs/delivery-pipeline.md). Only set by the runtime.
    ...(emit ? { emit } : {}),
    state: contextState(stateStore, {
      kind: "destination",
      plugin,
      name: destination,
      id
    })
  };
}

/*
 * The brainstem.output envelope a v2 destination receives.
 *
 *   {
 *     version: "1",
 *     kind: "brainstem.output",
 *     payload: {
 *       timestamp, pollId, idempotencyKey,
 *       decision,      // decision envelope
 *       observation,   // observation envelope
 *       input:       { id, plugin, name, module },
 *       destination: { id, plugin, name, module }
 *     }
 *   }
 *
 * Plain JSON, so it can be queued, logged and redelivered.
 */
export function createOutputEnvelope({
  decision,
  observation,
  pollId = null,
  idempotencyKey = null,
  input = {},
  destination = {},
  timestamp = new Date().toISOString()
}) {
  return {
    version: OUTPUT_ENVELOPE_VERSION,
    kind: "brainstem.output",
    payload: {
      timestamp,
      pollId,
      idempotencyKey,
      decision,
      observation,
      input: {
        id: input.id ?? null,
        plugin: input.plugin ?? null,
        name: input.name ?? null,
        module: input.module ?? null
      },
      destination: {
        id: destination.id ?? null,
        plugin: destination.plugin ?? null,
        name: destination.name ?? null,
        module: destination.module ?? null
      }
    }
  };
}

export function isOutputEnvelope(value) {
  return (
    value?.kind === "brainstem.output" &&
    value?.version === OUTPUT_ENVELOPE_VERSION &&
    isPlainObject(value.payload)
  );
}

/*
 * ctx.state: { get(key), set(key, value), update(key, fn), delete(key) }
 * namespaced per plugin + input/destination name (+ entry id).
 */
function contextState(stateStore, { kind, plugin, name, id }) {
  return createPluginState(
    stateStore ?? fallbackStateStore,
    pluginStateNamespace({
      kind,
      plugin: plugin ?? "unknown",
      name: name ?? "default",
      id
    })
  );
}

export function assertObservation(observation) {
  if (!observation || typeof observation !== "object") {
    throw new TypeError(
      "Adapter emitted a non-object observation"
    );
  }

  if (observation.version !== "1") {
    throw new TypeError(
      "Adapter emitted an observation with unsupported version"
    );
  }

  if (observation.kind !== "observation") {
    throw new TypeError(
      "Adapter emitted an envelope whose kind is not 'observation'"
    );
  }

  const payload =
    observation.payload;

  if (!payload || typeof payload !== "object") {
    throw new TypeError(
      "Adapter emitted an observation without payload"
    );
  }

  requireString(payload.id, "payload.id");
  requireObject(payload.source, "payload.source");
  requireString(payload.source.type, "payload.source.type");
  requireString(payload.source.name, "payload.source.name");
  requireString(payload.type, "payload.type");
  requireString(payload.state, "payload.state");
  requireString(payload.timestamp, "payload.timestamp");
  requireString(payload.title, "payload.title");
  requireString(payload.message, "payload.message");

  if (
    payload.facts !== undefined &&
    !isPlainObject(payload.facts)
  ) {
    throw new TypeError(
      "Adapter emitted observation payload.facts that is not an object"
    );
  }

  if (
    payload.data !== undefined &&
    !isPlainObject(payload.data)
  ) {
    throw new TypeError(
      "Adapter emitted observation payload.data that is not an object"
    );
  }

  return observation;
}

function requireString(value, path) {
  if (
    typeof value !== "string" ||
    value.length === 0
  ) {
    throw new TypeError(
      `Adapter emitted observation with invalid ${path}`
    );
  }
}

function requireObject(value, path) {
  if (!isPlainObject(value)) {
    throw new TypeError(
      `Adapter emitted observation with invalid ${path}`
    );
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
