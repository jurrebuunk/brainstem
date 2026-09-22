import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Brainstem } from "./core.mjs";
import {
  assertObservation,
  createDestinationContext,
  createInputContext,
  validateDestinationPlugin,
  validateInputPlugin
} from "./sdk.mjs";

const DEFAULT_INTERVAL_MS = 60_000;

const DEFAULT_RETRY = {
  attempts: 3,
  minDelayMs: 1_000,
  maxDelayMs: 30_000,
  factor: 2
};

export class BrainstemRuntime {
  constructor({
    config,
    brainstem,
    plugins = [],
    destinations = [],
    baseDir = process.cwd(),
    logger = console,
    onDecision = defaultOnDecision
  } = {}) {
    if (!brainstem && !config) {
      throw new Error(
        "BrainstemRuntime requires either config or brainstem"
      );
    }

    this.config = config ?? {};

    this.brainstem =
      brainstem ?? new Brainstem(config);

    this.plugins = plugins;
    this.destinations = destinations;
    this.baseDir = baseDir;
    this.logger = logger;
    this.onDecision = onDecision;

    this.abortController = null;
    this.tasks = [];
    this.destinationEntries = [];
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

    this.destinationEntries =
      await this.#loadDestinationEntries();

    this.tasks = this.plugins.map(entry =>
      this.#runPluginEntry(
        entry,
        this.abortController.signal
      )
    );

    return this;
  }

  async runOnce({ signal } = {}) {
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

    try {
      await this.brainstem.start();

      this.destinationEntries =
        await this.#loadDestinationEntries();

      await Promise.all(
        this.plugins.map(entry =>
          this.#runPluginEntryOnce(
            entry,
            this.abortController.signal
          )
        )
      );
    }
    finally {
      await this.close();
    }
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

    this.abortController = null;
    this.tasks = [];
    this.destinationEntries = [];
  }

  async #runPluginEntry(entry, signal) {
    const loaded =
      await this.#loadEntry(entry);

    while (!signal.aborted) {
      try {
        await this.#pollInputWithRetry({
          ...loaded,
          signal
        });
      }
      catch (error) {
        this.logger.error?.(
          `[brainstem] input '${loaded.plugin.name}.${loaded.inputName}' failed`,
          error
        );
      }

      await sleep(loaded.intervalMs, signal);
    }
  }

  async #runPluginEntryOnce(entry, signal) {
    const loaded =
      await this.#loadEntry(entry);

    await this.#pollInputWithRetry({
      ...loaded,
      signal
    });
  }

  async #loadEntry(entry) {
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

    return {
      entry,
      plugin,
      inputName,
      input,
      intervalMs,
      retry: this.#retryConfig(entry)
    };
  }

  #retryConfig(entry) {
    const retry = {
      ...DEFAULT_RETRY,
      ...(this.config.runtime?.retry ?? {}),
      ...(entry.retry ?? {}),
      ...(entry.config?.retry ?? {})
    };

    retry.attempts = Math.max(
      1,
      Number(retry.attempts ?? 1)
    );

    retry.minDelayMs = Math.max(
      0,
      Number(retry.minDelayMs ?? 0)
    );

    retry.maxDelayMs = Math.max(
      retry.minDelayMs,
      Number(retry.maxDelayMs ?? retry.minDelayMs)
    );

    retry.factor = Math.max(
      1,
      Number(retry.factor ?? 1)
    );

    return retry;
  }

  async #pollInputWithRetry(args) {
    let attempt = 0;
    let delayMs = args.retry.minDelayMs;

    while (true) {
      attempt += 1;

      try {
        await this.#pollInput(args);
        return;
      }
      catch (error) {
        if (
          attempt >= args.retry.attempts ||
          args.signal.aborted
        ) {
          throw error;
        }

        this.logger.warn?.(
          `[brainstem] input '${args.plugin.name}.${args.inputName}' failed; retrying in ${delayMs}ms (${attempt}/${args.retry.attempts})`,
          error
        );

        await sleep(delayMs, args.signal);

        delayMs = Math.min(
          args.retry.maxDelayMs,
          delayMs * args.retry.factor
        );
      }
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

      await this.#handleDecision({
        decision,
        observation,
        plugin,
        input: inputName,
        entry,
        signal
      });
    }
  }

  async #loadDestinationEntries() {
    return await Promise.all(
      this.destinations.map(entry =>
        this.#loadDestinationEntry(entry)
      )
    );
  }

  async #loadDestinationEntry(entry) {
    const { plugin } =
      await loadDestinationPlugin(
        entry.module,
        {
          baseDir:
            entry.baseDir ?? this.baseDir
        }
      );

    const destinationName =
      entry.destination ?? "default";

    const destination =
      plugin.destinations[destinationName];

    if (!destination) {
      throw new Error(
        `Destination plugin '${plugin.name}' does not define destination '${destinationName}'`
      );
    }

    return {
      entry,
      plugin,
      destinationName,
      destination
    };
  }

  async #handleDecision(event) {
    await this.onDecision?.(event);

    for (const destinationEntry of this.destinationEntries) {
      if (
        !decisionMatchesDestination(
          event.decision,
          destinationEntry.entry
        )
      ) {
        continue;
      }

      try {
        const ctx =
          createDestinationContext({
            config: destinationEntry.entry.config ?? {},
            signal: event.signal,
            logger: this.logger
          });

        await destinationEntry.destination.handle(
          ctx,
          {
            decision: event.decision,
            observation: event.observation,
            input: {
              plugin: event.plugin,
              name: event.input,
              entry: event.entry
            },
            destination: {
              plugin: destinationEntry.plugin,
              name: destinationEntry.destinationName,
              entry: destinationEntry.entry
            }
          }
        );
      }
      catch (error) {
        this.logger.error?.(
          `[brainstem] destination '${destinationEntry.plugin.name}.${destinationEntry.destinationName}' failed`,
          error
        );
      }
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

export async function loadDestinationPlugin(
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

  validateDestinationPlugin(
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
    if (options?.once) {
      await runtime.runOnce({
        signal: options?.signal
      });
    }
    else {
      await runtime.start({
        signal: options?.signal
      });

      await runtime.wait();
    }
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

function decisionMatchesDestination(decision, entry) {
  return (
    decisionLevelMatches(decision, entry) &&
    routeMatches(decision, entry)
  );
}

function decisionLevelMatches(decision, entry) {
  const allowed =
    entry.decisions ?? [
      "queue",
      "dispatch",
      "escalate"
    ];

  if (allowed === "all") {
    return true;
  }

  return allowed.includes(
    decision.payload.decision
  );
}

function routeMatches(decision, entry) {
  const allowed =
    entry.routes;

  if (!allowed || allowed === "all") {
    return true;
  }

  return allowed.includes(
    decision.payload.route
  );
}

function defaultOnDecision() {}
