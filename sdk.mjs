import { createObservation } from "./core.mjs";

export const INPUT_PLUGIN_API_VERSION =
  "brainstem.input/v1";

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
  if (!plugin || typeof plugin !== "object") {
    throw new TypeError(
      "Input plugin must export an object"
    );
  }

  if (plugin.apiVersion !== INPUT_PLUGIN_API_VERSION) {
    throw new TypeError(
      `Input plugin apiVersion must be '${INPUT_PLUGIN_API_VERSION}'`
    );
  }

  if (
    typeof plugin.name !== "string" ||
    plugin.name.length === 0
  ) {
    throw new TypeError(
      "Input plugin must have a name"
    );
  }

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

export function createInputContext({
  config = {},
  signal,
  logger = console
} = {}) {
  return {
    config,
    signal,
    logger,

    observation(input) {
      return createObservation(input);
    }
  };
}

export function assertObservation(observation) {
  if (!observation || typeof observation !== "object") {
    throw new TypeError(
      "Adapter emitted a non-object observation"
    );
  }

  if (observation.kind !== "observation") {
    throw new TypeError(
      "Adapter emitted an envelope whose kind is not 'observation'"
    );
  }

  if (
    !observation.payload ||
    typeof observation.payload.id !== "string" ||
    observation.payload.id.length === 0
  ) {
    throw new TypeError(
      "Adapter emitted an observation without payload.id"
    );
  }

  return observation;
}
