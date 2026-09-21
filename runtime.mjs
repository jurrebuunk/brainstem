import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Brainstem } from "./core.mjs";
import {
  assertObservation,
  createInputContext,
  validateInputPlugin
} from "./sdk.mjs";

const DEFAULT_INTERVAL_MS = 60_000;

export class BrainstemRuntime {
  constructor({
    config,
    brainstem,
    plugins = [],
    baseDir = process.cwd(),
    logger = console,
    onDecision = defaultOnDecision
  } = {}) {
    if (!brainstem && !config) {
      throw new Error(
        "BrainstemRuntime requires either config or brainstem"
      );
    }

    this.brainstem =
      brainstem ?? new Brainstem(config);

    this.plugins = plugins;
    this.baseDir = baseDir;
    this.logger = logger;
    this.onDecision = onDecision;

    this.abortController = null;
    this.tasks = [];
  }

  async start({ signal } = {}) {
    if (this.abortController) {
      throw new Error(
        "BrainstemRuntime has already been started"
      );
    }

    this.abortController =
      new AbortController();

    if (signal) {
      if (signal.aborted) {
        this.abortController.abort(
          signal.reason
        );
      }
      else {
        signal.addEventListener(
          "abort",
          () => this.abortController.abort(
            signal.reason
          ),
          { once: true }
        );
      }
    }

    await this.brainstem.start();

    this.tasks = this.plugins.map(entry =>
      this.#runPluginEntry(
        entry,
        this.abortController.signal
      )
    );

    return this;
  }

  async wait() {
    await Promise.all(this.tasks);
  }

  async close() {
    if (this.abortController) {
      this.abortController.abort();
    }

    await Promise.allSettled(
      this.tasks
    );

    await this.brainstem.close();
  }

  async #runPluginEntry(entry, signal) {
    const { plugin } =
      await loadInputPlugin(
        entry.module,
        {
          baseDir:
            entry.baseDir ?? this.baseDir
        }
      );

    const inputName =
      entry.input ?? "default";

    const input =
      plugin.inputs[inputName];

    if (!input) {
      throw new Error(
        `Input plugin '${plugin.name}' does not define input '${inputName}'`
      );
    }

    if (input.mode !== "poll") {
      throw new Error(
        `Input '${plugin.name}.${inputName}' uses unsupported mode '${input.mode}'`
      );
    }

    const intervalMs =
      entry.intervalMs ??
      entry.config?.intervalMs ??
      input.defaultIntervalMs ??
      DEFAULT_INTERVAL_MS;

    while (!signal.aborted) {
      try {
        await this.#pollInput({
          entry,
          plugin,
          inputName,
          input,
          signal
        });
      }
      catch (error) {
        this.logger.error?.(
          `[brainstem] input '${plugin.name}.${inputName}' failed`,
          error
        );
      }

      await sleep(intervalMs, signal);
    }
  }

  async #pollInput({
    entry,
    plugin,
    inputName,
    input,
    signal
  }) {
    const ctx =
      createInputContext({
        config: entry.config ?? {},
        signal,
        logger: this.logger
      });

    const observations =
      input.poll(ctx);

    for await (
      const observation of toAsyncIterable(
        observations
      )
    ) {
      if (signal.aborted) {
        break;
      }

      assertObservation(
        observation
      );

      const decision =
        await this.brainstem.process(
          observation
        );

      await this.onDecision({
        decision,
        observation,
        plugin,
        input: inputName,
        entry
      });
    }
  }
}

export async function loadInputPlugin(
  specifier,
  { baseDir = process.cwd() } = {}
) {
  const url =
    resolveLocalModuleUrl(
      specifier,
      baseDir
    );

  const module =
    await import(url);

  const plugin =
    module.default;

  validateInputPlugin(
    plugin
  );

  return {
    plugin,
    url
  };
}

export async function runBrainstemRuntime(options) {
  const runtime =
    new BrainstemRuntime(options);

  try {
    await runtime.start({
      signal: options?.signal
    });

    await runtime.wait();
  }
  finally {
    await runtime.close();
  }
}

function resolveLocalModuleUrl(specifier, baseDir) {
  if (typeof specifier !== "string") {
    throw new TypeError(
      "Plugin module specifier must be a string"
    );
  }

  if (specifier.startsWith("file:")) {
    return specifier;
  }

  if (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/")
  ) {
    throw new Error(
      "Phase 1 only supports local file input plugins. Use './plugin.mjs' or an absolute path."
    );
  }

  const filePath = isAbsolute(specifier)
    ? specifier
    : resolve(baseDir, specifier);

  return pathToFileURL(
    filePath
  ).href;
}

async function* toAsyncIterable(value) {
  const resolved =
    await value;

  if (!resolved) {
    return;
  }

  if (
    typeof resolved[Symbol.asyncIterator] ===
    "function"
  ) {
    yield* resolved;
    return;
  }

  if (
    typeof resolved[Symbol.iterator] ===
    "function"
  ) {
    for (const item of resolved) {
      yield item;
    }

    return;
  }

  throw new TypeError(
    "poll(ctx) must return an iterable, async iterable, or array of observations"
  );
}

function sleep(ms, signal) {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    const timeout =
      setTimeout(resolve, ms);

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

function defaultOnDecision({ decision }) {
  if (
    decision.payload.decision !==
    "ignore"
  ) {
    console.log(decision);
  }
}
