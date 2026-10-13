import { createDeferredCheckpoint } from "./checkpoints.mjs";
import { eventMatchesDestination } from "./destinations.mjs";
import { createRuntimeLogger } from "./logger.mjs";
import {
  loadDestinationPlugin,
  loadInputPlugin
} from "./plugin-loader.mjs";
import {
  checkpointKeyForEntry,
  toAsyncIterable
} from "./polling.mjs";
import {
  DEFAULT_RETRY,
  normalizeRetry,
  sleep
} from "./retry.mjs";
import {
  createCheckpointStore,
  createDatabaseProvider,
  createRecordStore,
  storeInfo
} from "./stores.mjs";
import {
  createTelemetrySink,
  telemetryEvent,
  telemetryValue
} from "./telemetry.mjs";
import { Brainstem } from "../core/brainstem.mjs";
export { loadDestinationPlugin, loadInputPlugin } from "./plugin-loader.mjs";
import {
  assertObservation,
  createDestinationContext,
  createInputContext
} from "../sdk/index.mjs";

const DEFAULT_INTERVAL_MS = 60_000;

export class BrainstemRuntime {
  constructor({
    config,
    brainstem,
    plugins = [],
    destinations = [],
    baseDir = process.cwd(),
    logger,
    onDecision = defaultOnDecision,
    checkpointStore,
    recordStore,
    database
  } = {}) {
    if (!brainstem && !config) {
      throw new Error(
        "BrainstemRuntime requires either config or brainstem"
      );
    }

    this.config = config ?? {};

    /*
     * One database handle shared by the
     * database-backed stores. An injected
     * handle (`database`) is never closed by
     * the runtime; a handle the runtime opens
     * itself (lazily) is closed in close().
     */
    this.database =
      createDatabaseProvider(
        this.config,
        baseDir,
        { database }
      );

    this.recordStore =
      recordStore ??
      (
        brainstem
          ? null
          : createRecordStore(
              this.config,
              baseDir,
              { provider: this.database }
            )
      );

    this.brainstem =
      brainstem ?? new Brainstem(
        config,
        {
          store: this.recordStore
        }
      );

    this.plugins = plugins;
    this.destinations = destinations;
    this.baseDir = baseDir;
    this.logger =
      logger ??
      createRuntimeLogger(
        this.config.runtime?.logging ?? {}
      );
    this.onDecision = onDecision;
    this.checkpointStore =
      checkpointStore ??
      createCheckpointStore(
        this.config,
        this.baseDir,
        { provider: this.database }
      );

    this.abortController = null;
    this.tasks = [];
    this.destinationEntries = [];
    this.loadedInputs = new Map();
    this.telemetry = createTelemetrySink(
      this.config.runtime?.telemetry
    );
    this.telemetryInterval = null;
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

    this.logger.info?.(
      "runtime starting",
      {
        inputs: this.plugins.length,
        destinations: this.destinations.length,
        records: storeInfo(this.recordStore),
        checkpoints: storeInfo(this.checkpointStore)
      }
    );
    this.#emitTelemetry("brainstem.runtime.starting", {
      inputs: this.plugins.length,
      destinations: this.destinations.length
    });

    await this.#startBrainstem(
      this.abortController.signal
    );

    this.destinationEntries =
      await this.#loadDestinationEntries();

    this.#emitSnapshot();
    this.#startTelemetrySnapshots();

    this.tasks = this.plugins.map((entry, index) =>
      this.#runPluginEntry(
        entry,
        index,
        this.abortController.signal
      )
    );

    this.logger.info?.(
      "runtime started",
      {
        inputs: this.plugins.length,
        destinations: this.destinationEntries.length
      }
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
      this.logger.info?.(
        "runtime run-once starting",
        {
          inputs: this.plugins.length,
          destinations: this.destinations.length,
          records: storeInfo(this.recordStore),
          checkpoints: storeInfo(this.checkpointStore)
        }
      );
      this.#emitTelemetry("brainstem.runtime.starting", {
        once: true,
        inputs: this.plugins.length,
        destinations: this.destinations.length
      });

      await this.#startBrainstem(
        this.abortController.signal
      );

      this.destinationEntries =
        await this.#loadDestinationEntries();

      this.#emitSnapshot();

      await Promise.all(
        this.plugins.map((entry, index) =>
          this.#runPluginEntryOnce(
            entry,
            index,
            this.abortController.signal
          )
        )
      );

      this.logger.info?.(
        "runtime run-once completed"
      );
    }
    finally {
      await this.close();
    }
  }

  async wait() {
    await Promise.all(this.tasks);
  }

  async #startBrainstem(signal) {
    const retry =
      this.#startupRetryConfig();

    let attempt = 0;
    let delayMs = retry.minDelayMs;

    while (true) {
      attempt += 1;

      try {
        this.logger.debug?.(
          "core starting",
          {
            attempt,
            attempts: retry.attempts
          }
        );

        await this.brainstem.start();

        this.logger.info?.(
          "core started"
        );

        return;
      }
      catch (error) {
        if (
          attempt >= retry.attempts ||
          signal?.aborted
        ) {
          this.logger.error?.(
            "core failed to start",
            {
              attempt,
              attempts: retry.attempts,
              error
            }
          );

          throw error;
        }

        this.logger.warn?.(
          "core start failed; retrying",
          {
            attempt,
            attempts: retry.attempts,
            retryInMs: delayMs,
            error
          }
        );

        await sleep(delayMs, signal);

        delayMs = Math.min(
          retry.maxDelayMs,
          delayMs * retry.factor
        );
      }
    }
  }

  async close() {
    if (
      !this.abortController &&
      this.tasks.length === 0 &&
      this.destinationEntries.length === 0
    ) {
      return;
    }

    this.logger.info?.(
      "runtime stopping"
    );

    if (this.abortController) {
      this.abortController.abort();
    }

    if (this.telemetryInterval) {
      clearInterval(this.telemetryInterval);
      this.telemetryInterval = null;
    }

    this.#emitTelemetry("brainstem.runtime.stopping", {});

    await Promise.allSettled(
      this.tasks
    );

    await this.brainstem.close();
    await this.checkpointStore.close?.();
    await this.database.close();

    this.abortController = null;
    this.tasks = [];
    this.destinationEntries = [];
    this.loadedInputs.clear();

    this.#emitTelemetry("brainstem.runtime.stopped", {});

    this.logger.info?.(
      "runtime stopped"
    );
  }

  async #runPluginEntry(entry, index, signal) {
    const loaded =
      await this.#loadEntry(entry, index);

    while (!signal.aborted) {
      try {
        await this.#pollInputWithRetry({
          ...loaded,
          signal
        });
      }
      catch (error) {
        this.logger.error?.(
          "input poll failed",
          {
            plugin: loaded.plugin.name,
            input: loaded.inputName,
            id: loaded.checkpointKey,
            error
          }
        );
      }

      await sleep(loaded.intervalMs, signal);
    }
  }

  async #runPluginEntryOnce(entry, index, signal) {
    const loaded =
      await this.#loadEntry(entry, index);

    await this.#pollInputWithRetry({
      ...loaded,
      signal
    });
  }

  async #loadEntry(entry, index) {
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

    const checkpointKey =
      checkpointKeyForEntry(
        entry,
        plugin,
        inputName,
        index
      );

    const loadedInput = {
      id: checkpointKey,
      plugin: plugin.name,
      input: inputName,
      module: entry.module,
      intervalMs
    };

    this.loadedInputs.set(
      checkpointKey,
      loadedInput
    );

    this.logger.info?.(
      "input loaded",
      {
        id: checkpointKey,
        plugin: plugin.name,
        input: inputName,
        intervalMs
      }
    );
    this.#emitTelemetry(
      "brainstem.input.loaded",
      loadedInput
    );
    this.#emitSnapshot();

    return {
      entry,
      plugin,
      inputName,
      input,
      intervalMs,
      checkpointKey,
      retry: this.#retryConfig(entry)
    };
  }

  #scopedPluginLogger(scope) {
    const log = (level, message, fields) => {
      const normalizedFields = telemetryValue(fields ?? {});

      this.logger[level]?.(
        message,
        {
          ...scope,
          ...(
            normalizedFields &&
            typeof normalizedFields === "object" &&
            !Array.isArray(normalizedFields)
              ? normalizedFields
              : { value: normalizedFields }
          )
        }
      );

      this.#emitTelemetry("brainstem.plugin.log", {
        level,
        message: String(message),
        ...scope,
        fields: normalizedFields
      });
    };

    return {
      debug(message, fields) {
        log("debug", message, fields);
      },
      info(message, fields) {
        log("info", message, fields);
      },
      warn(message, fields) {
        log("warn", message, fields);
      },
      error(message, fields) {
        log("error", message, fields);
      }
    };
  }

  #emitTelemetry(kind, payload = {}) {
    this.telemetry?.send(telemetryEvent(kind, payload));
  }

  #emitSnapshot() {
    this.#emitTelemetry("brainstem.snapshot", {
      inputs: this.plugins.map((entry, index) => {
        const id =
          entry.id ??
          this.loadedInputs.get(entry.id)?.id ??
          `input.${index}`;

        return {
          id,
          module: entry.module,
          input: entry.input ?? "default",
          ...(this.loadedInputs.get(id) ?? {})
        };
      }),
      core: {
        status: this.brainstem?.laya ? "running" : "starting"
      },
      destinations: this.destinationEntries.map(item => ({
        plugin: item.plugin.name,
        destination: item.destinationName,
        module: item.entry.module,
        decisions: item.entry.decisions ?? ["queue", "dispatch", "escalate"],
        routes: item.entry.routes ?? "all",
        sources: item.entry.sources ?? "all",
        types: item.entry.types ?? "all"
      }))
    });
  }

  #startTelemetrySnapshots() {
    if (
      this.telemetryInterval ||
      !this.telemetry
    ) {
      return;
    }

    const intervalMs =
      this.config.runtime?.telemetry?.snapshotIntervalMs ??
      5_000;

    this.telemetryInterval = setInterval(
      () => this.#emitSnapshot(),
      intervalMs
    );

    this.telemetryInterval.unref?.();
  }

  #destinationFailuresBlockInput() {
    return this.config.runtime
      ?.destinations
      ?.blockInputOnFailure === true;
  }

  #startupRetryConfig() {
    return normalizeRetry({
      ...DEFAULT_RETRY,
      ...(this.config.runtime?.retry ?? {}),
      ...(this.config.runtime?.startupRetry ?? {})
    });
  }

  #retryConfig(entry) {
    const retry = {
      ...DEFAULT_RETRY,
      ...(this.config.runtime?.retry ?? {}),
      ...(entry.retry ?? {}),
      ...(entry.config?.retry ?? {})
    };

    return normalizeRetry(retry);
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
          "input poll failed; retrying",
          {
            plugin: args.plugin.name,
            input: args.inputName,
            id: args.checkpointKey,
            attempt,
            attempts: args.retry.attempts,
            retryInMs: delayMs,
            error
          }
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
    signal,
    checkpointKey
  }) {
    const checkpoint =
      createDeferredCheckpoint({
        store: this.checkpointStore,
        key: checkpointKey
      });

    const ctx =
      createInputContext({
        config: entry.config ?? {},
        signal,
        logger: this.#scopedPluginLogger({
          scope: "input",
          id: checkpointKey,
          plugin: plugin.name,
          input: inputName
        }),
        checkpoint: checkpoint.api
      });

    const pollId = `${checkpointKey}:${Date.now()}`;

    this.logger.info?.(
      "input poll started",
      {
        id: checkpointKey,
        plugin: plugin.name,
        input: inputName,
        pollId
      }
    );
    this.#emitTelemetry("brainstem.input.poll.started", {
      id: checkpointKey,
      plugin: plugin.name,
      input: inputName,
      pollId
    });

    const observations =
      input.poll(ctx);

    let observationCount = 0;

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

      observationCount += 1;

      this.#emitTelemetry("brainstem.input.observation", {
        id: checkpointKey,
        plugin: plugin.name,
        input: inputName,
        pollId,
        observation
      });

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
        signal,
        pollId
      });
    }

    if (!signal.aborted) {
      await checkpoint.commit();

      const level = observationCount > 0
        ? "info"
        : "debug";

      this.logger[level]?.(
        "input poll completed",
        {
          id: checkpointKey,
          plugin: plugin.name,
          input: inputName,
          pollId,
          observations: observationCount
        }
      );
      this.#emitTelemetry("brainstem.input.poll.completed", {
        id: checkpointKey,
        plugin: plugin.name,
        input: inputName,
        pollId,
        observations: observationCount
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

    const loadedDestination = {
      plugin: plugin.name,
      destination: destinationName,
      module: entry.module,
      decisions: entry.decisions ?? ["queue", "dispatch", "escalate"],
      routes: entry.routes ?? "all",
      sources: entry.sources ?? "all",
      types: entry.types ?? "all"
    };

    this.logger.info?.(
      "destination loaded",
      loadedDestination
    );
    this.#emitTelemetry(
      "brainstem.destination.loaded",
      loadedDestination
    );

    return {
      entry,
      plugin,
      destinationName,
      destination
    };
  }

  async #handleDecision(event) {
    await this.onDecision?.(event);

    const decisionPayload =
      event.decision.payload;

    const observationPayload =
      event.observation.payload;

    const decisionLogLevel =
      decisionPayload.decision === "ignore"
        ? "debug"
        : "info";

    const decisionInfo = {
      observationId: observationPayload.id,
      source: observationPayload.source.type,
      type: observationPayload.type,
      state: observationPayload.state,
      inputId: event.entry.id ?? null,
      inputPlugin: event.plugin.name,
      inputName: event.input,
      pollId: event.pollId ?? null,
      decision: decisionPayload.decision,
      route: decisionPayload.route,
      reason: decisionPayload.reason
    };

    this.logger[decisionLogLevel]?.(
      "observation decided",
      decisionInfo
    );
    this.#emitTelemetry(
      "brainstem.core.decision",
      {
        ...decisionInfo,
        decision: event.decision,
        observation: event.observation
      }
    );

    const failures = [];

    for (const destinationEntry of this.destinationEntries) {
      if (
        !eventMatchesDestination(
          event,
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
            logger: this.#scopedPluginLogger({
              scope: "destination",
              plugin: destinationEntry.plugin.name,
              destination: destinationEntry.destinationName
            })
          });

        const destinationInfo = {
          plugin: destinationEntry.plugin.name,
          destination: destinationEntry.destinationName,
          observationId: observationPayload.id,
          decision: decisionPayload.decision,
          pollId: event.pollId ?? null,
          decisionEnvelope: event.decision,
          observationEnvelope: event.observation
        };

        this.logger.debug?.(
          "destination handling decision",
          destinationInfo
        );
        this.#emitTelemetry(
          "brainstem.destination.running",
          destinationInfo
        );

        await destinationEntry.destination.handle(
          ctx,
          {
            decision: event.decision,
            observation: event.observation,
            pollId: event.pollId ?? null,
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

        this.logger.debug?.(
          "destination handled decision",
          destinationInfo
        );
        this.#emitTelemetry(
          "brainstem.destination.completed",
          destinationInfo
        );
      }
      catch (error) {
        failures.push(error);

        const failureInfo = {
          plugin: destinationEntry.plugin.name,
          destination: destinationEntry.destinationName,
          observationId: observationPayload.id,
          decision: decisionPayload.decision,
          pollId: event.pollId ?? null,
          decisionEnvelope: event.decision,
          observationEnvelope: event.observation,
          error
        };

        this.logger.error?.(
          "destination failed",
          failureInfo
        );
        this.#emitTelemetry(
          "brainstem.destination.failed",
          failureInfo
        );
      }
    }

    if (
      failures.length > 0 &&
      this.#destinationFailuresBlockInput()
    ) {
      throw new AggregateError(
        failures,
        `One or more destinations failed for observation '${observationPayload.id}'`
      );
    }
  }
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

function defaultOnDecision() {}
