import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { DatabaseCheckpointStore, createDeferredCheckpoint } from "./checkpoints.mjs";
import { LazyPluginStateStore, MemoryPluginStateStore } from "./plugin-state.mjs";
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
  DESTINATION_PLUGIN_API_VERSION_V1,
  assertObservation,
  createDestinationContext,
  createInputContext,
  createOutputEnvelope
} from "../sdk/index.mjs";
import {
  DEFAULT_DELIVERY_PRUNE_AFTER_DAYS,
  JobRunner,
  PermanentJobError,
  createPipelineAdmin,
  createPipelineStorage,
  deliveryChanges,
  normalizeJobRetry
} from "../queue/index.mjs";

const DEFAULT_INTERVAL_MS = 60_000;

const DELIVERY_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/*
 * Pipeline defaults (runtime.queue). Decisions retry quickly
 * (Laya or the record store being briefly unavailable);
 * deliveries back off for longer because the receiving system
 * may be down for a while.
 */
export const DEFAULT_QUEUE_CONFIG = {
  pollIntervalMs: 1_000,
  leaseMs: 60_000,
  decide: {
    concurrency: 4,
    retry: {
      attempts: 5,
      minDelayMs: 1_000,
      maxDelayMs: 60_000,
      factor: 2
    }
  },
  deliver: {
    concurrency: 4,
    retry: {
      attempts: 8,
      minDelayMs: 5_000,
      maxDelayMs: 15 * 60_000,
      factor: 3
    }
  }
};

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
    pluginState,
    database,
    pipeline
  } = {}) {
    if (!brainstem && !config) {
      throw new Error(
        "BrainstemRuntime requires either config or brainstem"
      );
    }

    this.config = config ?? {};

    /*
     * Identifies this runtime process in telemetry and as the job
     * worker. Stable for the process lifetime; with several cores
     * each one reports its own id.
     */
    this.coreId =
      this.config.runtime?.coreId ??
      process.env.BRAINSTEM_CORE_ID ??
      `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

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
    /*
     * Plugin state is durable whenever
     * checkpoints live in the database;
     * otherwise it stays in memory.
     */
    this.pluginState =
      pluginState ??
      (
        this.checkpointStore instanceof DatabaseCheckpointStore
          ? new LazyPluginStateStore(
              () => this.database.get()
            )
          : new MemoryPluginStateStore()
      );

    /*
     * Pipeline storage: the job transport and the
     * delivery log. Durable (database) whenever
     * checkpoints live in the database, so a
     * checkpoint never advances past observations
     * that are not stored yet.
     */
    this.queueConfig =
      normalizeQueueConfig(
        this.config.runtime?.queue
      );

    /*
     * Destinations can hand observations back to the core
     * (ctx.emit), e.g. an agent's report for a bigger agent.
     * Bounded so a chain of destinations can never loop.
     */
    this.handoffConfig = {
      maxDepth: this.config.runtime?.handoff?.maxDepth ?? 2,
      maxPerDelivery: this.config.runtime?.handoff?.maxPerDelivery ?? 5
    };

    const checkpointsInDatabase =
      this.checkpointStore instanceof DatabaseCheckpointStore;

    this.pipeline =
      pipeline ??
      createPipelineStorage({
        type:
          this.queueConfig.transport ??
          (checkpointsInDatabase ? "database" : "memory"),
        database: () => this.database.get()
      });

    this.transport = this.pipeline.transport;
    this.deliveries = this.pipeline.deliveries;
    this.pipelineAdmin =
      createPipelineAdmin(this.pipeline);

    /*
     * Checkpoints commit in the same transaction
     * as the decide jobs when both use the
     * runtime's own database handle.
     */
    this.checkpointsInTransaction =
      !checkpointStore &&
      !pipeline &&
      checkpointsInDatabase &&
      this.pipeline.type === "database";

    this.abortController = null;
    this.tasks = [];
    this.runner = null;
    this.deliveryPruneTimer = null;
    this.deliveryPruning = null;
    this.destinationEntries = [];
    this.destinationsById = new Map();
    this.loadedInputs = new Map();
    this.inputsById = new Map();
    this.warnedV1Plugins = new Set();
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

    await this.#loadDestinationEntries();

    this.#emitSnapshot();
    this.#startTelemetrySnapshots();
    this.#startDeliveryPruning();

    this.runner =
      this.#createRunner();

    this.tasks = [
      ...this.plugins.map((entry, index) =>
        this.#runPluginEntry(
          entry,
          index,
          this.abortController.signal
        )
      ),
      this.runner
        .start(this.abortController.signal)
        .catch(error => {
          this.logger.error?.(
            "job runner failed",
            { error }
          );
        })
    ];

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

      await this.#loadDestinationEntries();

      this.#emitSnapshot();

      const polls =
        await Promise.allSettled(
          this.plugins.map((entry, index) =>
            this.#runPluginEntryOnce(
              entry,
              index,
              this.abortController.signal
            )
          )
        );

      /*
       * Decide and deliver everything the polls
       * (and earlier runs) queued. Retries that
       * are not due yet stay queued for the next
       * run.
       */
      this.runner =
        this.#createRunner();

      const drained =
        await this.runner.drain(
          this.abortController.signal
        );

      await this.#reportPendingJobs();

      const pollFailures =
        polls
          .filter(result => result.status === "rejected")
          .map(result => result.reason);

      if (pollFailures.length > 0) {
        throw pollFailures.length === 1
          ? pollFailures[0]
          : new AggregateError(
              pollFailures,
              `${pollFailures.length} inputs failed to poll`
            );
      }

      if (drained.failures.length > 0) {
        const errors =
          drained.failures.map(failure => failure.error);

        throw new AggregateError(
          errors,
          `${errors.length} pipeline job(s) failed: ${errors[0]?.message ?? errors[0]}`
        );
      }

      this.logger.info?.(
        "runtime run-once completed",
        {
          jobs: drained.processed
        }
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

    if (this.deliveryPruneTimer) {
      clearInterval(this.deliveryPruneTimer);
      this.deliveryPruneTimer = null;
    }

    await this.deliveryPruning;

    this.#emitTelemetry("brainstem.runtime.stopping", {});

    await Promise.allSettled(
      this.tasks
    );

    await this.brainstem.close();
    await this.checkpointStore.close?.();
    await this.transport.close?.();
    await this.database.close();

    this.abortController = null;
    this.tasks = [];
    this.runner = null;
    this.destinationEntries = [];
    this.destinationsById.clear();
    this.loadedInputs.clear();
    this.inputsById.clear();

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

    this.inputsById.set(
      checkpointKey,
      { entry, plugin }
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
    this.telemetry?.send(telemetryEvent(kind, { coreId: this.coreId, ...payload }));
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
        id: this.coreId,
        status: this.brainstem?.laya ? "running" : "starting"
      },
      destinations: this.destinationEntries.map(item => ({
        id: item.id,
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
        checkpoint: checkpoint.api,
        stateStore: this.pluginState,
        plugin: plugin.name,
        input: inputName,
        id: checkpointKey
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

    const jobs = [];

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

      this.#emitTelemetry("brainstem.input.observation", {
        id: checkpointKey,
        plugin: plugin.name,
        input: inputName,
        pollId,
        observation
      });

      jobs.push({
        queue: "decide",
        queueKey: `observation:${observation.payload.id}`,
        maxAttempts:
          this.queueConfig.decide.retry.attempts,
        payload: {
          observation,
          // Stable across decide retries, unique per emission.
          emissionId: randomUUID(),
          pollId,
          origin: { kind: "input", id: checkpointKey },
          input: {
            id: checkpointKey,
            plugin: plugin.name,
            name: inputName,
            module: entry.module ?? null
          }
        }
      });
    }

    if (signal.aborted) {
      return;
    }

    /*
     * Store the observations (as decide jobs)
     * before the checkpoint moves past them: in
     * one transaction when both live in the
     * runtime database, otherwise jobs first so a
     * crash in between re-polls instead of losing
     * observations.
     */
    if (this.checkpointsInTransaction) {
      await this.transport.transaction(async executor => {
        await this.transport.enqueue(jobs, { executor });
        await checkpoint.commit({ executor });
      });
    }
    else {
      if (jobs.length > 0) {
        await this.transport.enqueue(jobs);
      }

      await checkpoint.commit();
    }

    const level = jobs.length > 0
      ? "info"
      : "debug";

    this.logger[level]?.(
      "input poll completed",
      {
        id: checkpointKey,
        plugin: plugin.name,
        input: inputName,
        pollId,
        observations: jobs.length
      }
    );
    this.#emitTelemetry("brainstem.input.poll.completed", {
      id: checkpointKey,
      plugin: plugin.name,
      input: inputName,
      pollId,
      observations: jobs.length
    });
  }

  async #loadDestinationEntries() {
    this.destinationEntries =
      await Promise.all(
        this.destinations.map((entry, index) =>
          this.#loadDestinationEntry(entry, index)
        )
      );

    this.destinationsById.clear();

    for (const item of this.destinationEntries) {
      if (this.destinationsById.has(item.id)) {
        throw new Error(
          `Duplicate destination id '${item.id}'. Give each destination a unique 'id'.`
        );
      }

      this.destinationsById.set(item.id, item);
    }

    if (
      this.config.runtime?.destinations
        ?.blockInputOnFailure !== undefined
    ) {
      this.logger.warn?.(
        "runtime.destinations.blockInputOnFailure is ignored: deliveries are queued and retried per destination (runtime.queue.deliver.retry)"
      );
    }
  }

  async #loadDestinationEntry(entry, index) {
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

    /*
     * The id is part of every delivery's
     * idempotency key. Set `id` in the config so
     * reordering destinations keeps it stable.
     */
    const id =
      entry.id ??
      `${plugin.name}.${destinationName}.${index}`;

    if (
      plugin.apiVersion ===
        DESTINATION_PLUGIN_API_VERSION_V1 &&
      !this.warnedV1Plugins.has(plugin.name)
    ) {
      this.warnedV1Plugins.add(plugin.name);

      this.logger.warn?.(
        "destination plugin uses the deprecated brainstem.destination/v1 API; it runs through a compatibility adapter until 3.0",
        { plugin: plugin.name }
      );
    }

    const loadedDestination = {
      id,
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
      id,
      entry,
      plugin,
      destinationName,
      destination,
      retry: normalizeJobRetry(
        entry.retry ?? {},
        this.queueConfig.deliver.retry
      )
    };
  }

  #createRunner() {
    return new JobRunner({
      transport: this.transport,
      workerId: this.coreId,
      leaseMs: this.queueConfig.leaseMs,
      pollIntervalMs: this.queueConfig.pollIntervalMs,
      logger: this.logger,
      queues: {
        decide: {
          concurrency: this.queueConfig.decide.concurrency,
          retry: this.queueConfig.decide.retry,
          handler: (job, context) =>
            this.#decide(job, context),
          onFailure: (job, error, details) =>
            this.#decideFailed(job, error, details)
        },
        deliver: {
          concurrency: this.queueConfig.deliver.concurrency,
          retryFor: job =>
            this.destinationsById.get(job.payload.destination)?.retry ??
            this.queueConfig.deliver.retry,
          handler: (job, context) =>
            this.#deliver(job, context),
          onFailure: (job, error, details) =>
            this.#deliverFailed(job, error, details)
        }
      }
    });
  }

  /*
   * Decide stage: one observation emission.
   *
   * The record write is a compare-and-set inside
   * Brainstem. The delivery rows and deliver jobs
   * commit together with the ack, so a retried
   * decide job (same emission) produces the same
   * idempotency keys and enqueues nothing twice.
   */
  async #decide(job, { signal, commit }) {
    const {
      observation,
      emissionId,
      pollId = null,
      input = {},
      origin = legacyOrigin(job.payload)
    } = job.payload;

    const decision =
      await this.brainstem.process(
        observation
      );

    const loadedInput =
      this.inputsById.get(input.id);

    await this.onDecision?.({
      decision,
      observation,
      plugin:
        loadedInput?.plugin ??
        { name: input.plugin },
      input: input.name,
      entry:
        loadedInput?.entry ??
        { id: input.id, module: input.module },
      signal,
      pollId
    });

    const decisionPayload =
      decision.payload;

    const observationPayload =
      observation.payload;

    const decisionInfo = {
      observationId: observationPayload.id,
      source: observationPayload.source.type,
      type: observationPayload.type,
      state: observationPayload.state,
      inputId: loadedInput?.entry.id ?? null,
      inputPlugin: input.plugin ?? null,
      inputName: input.name ?? null,
      origin,
      pollId,
      decision: decisionPayload.decision,
      route: decisionPayload.route,
      reason: decisionPayload.reason
    };

    this.logger[
      decisionPayload.decision === "ignore"
        ? "debug"
        : "info"
    ]?.(
      "observation decided",
      decisionInfo
    );
    this.#emitTelemetry(
      "brainstem.core.decision",
      {
        ...decisionInfo,
        decision,
        observation
      }
    );

    const deliveries =
      this.destinationEntries
        .filter(item =>
          eventMatchesDestination(
            { decision, observation },
            item.entry
          ) &&
          // An emitted observation never returns to a destination
          // already in its chain.
          !(origin?.lineage ?? []).includes(item.id)
        )
        .map(item => {
          const key = deliveryKey({
            destinationId: item.id,
            observationId: observationPayload.id,
            revision: decisionPayload.revision,
            emissionId: emissionId ?? `job-${job.id}`
          });

          return {
            item,
            key,
            output: createOutputEnvelope({
              decision,
              observation,
              pollId,
              idempotencyKey: key,
              input,
              origin,
              destination: {
                id: item.id,
                plugin: item.plugin.name,
                name: item.destinationName,
                module: item.entry.module ?? null
              }
            })
          };
        });

    await commit(async executor => {
      for (const { item, key, output } of deliveries) {
        await this.deliveries.create(
          {
            key,
            observationId: observationPayload.id,
            revision: decisionPayload.revision ?? 0,
            destination: item.id,
            plugin: item.plugin.name,
            decision: decisionPayload.decision,
            output
          },
          { executor }
        );
      }

      await this.transport.enqueue(
        deliveries.map(({ item, key }) => ({
          queue: "deliver",
          jobKey: key,
          // In order per destination and observation.
          queueKey: `delivery:${item.id}:${observationPayload.id}`,
          maxAttempts: item.retry.attempts,
          payload: {
            key,
            destination: item.id,
            ...(origin ? { origin } : {})
          }
        })),
        { executor }
      );
    });
  }

  #decideFailed(job, error, { dead, retryInMs }) {
    const observationId =
      job.payload.observation?.payload?.id ?? null;

    const info = {
      observationId,
      inputId: job.payload.input?.id ?? null,
      pollId: job.payload.pollId ?? null,
      jobId: job.id,
      attempt: job.attempts,
      attempts: job.maxAttempts,
      dead,
      retryInMs,
      error
    };

    this.logger[dead ? "error" : "warn"]?.(
      dead
        ? "observation decision failed; moved to dead jobs"
        : "observation decision failed; retrying",
      info
    );
    this.#emitTelemetry(
      "brainstem.core.failed",
      info
    );
  }

  /*
   * Deliver stage: one (decision, destination)
   * emission. The delivery log is checked first,
   * so a job that runs again after its delivery
   * was recorded is acked without sending.
   */
  async #deliver(job, { signal, commit }) {
    const {
      key,
      destination: destinationId
    } = job.payload;

    // Where the decided observation came from; a handoff chain
    // grows from here.
    const origin = legacyOrigin(job.payload);
    const lineage = origin?.lineage ?? [];
    const depth = origin?.depth ?? 0;

    const item =
      this.destinationsById.get(destinationId);

    if (!item) {
      throw new PermanentJobError(
        `Destination '${destinationId}' is not configured`
      );
    }

    const delivery =
      await this.deliveries.get(key);

    if (!delivery) {
      throw new PermanentJobError(
        `Delivery '${key}' is missing from the delivery log`
      );
    }

    const destinationInfo =
      this.#destinationInfo(item, delivery, job);

    if (delivery.status === "delivered") {
      this.logger.debug?.(
        "destination already delivered; skipping",
        destinationInfo
      );
      return;
    }

    await this.deliveries.update(
      key,
      deliveryChanges.attempt(job.attempts)
    );

    this.logger.debug?.(
      "destination handling decision",
      destinationInfo
    );
    this.#emitTelemetry(
      "brainstem.destination.running",
      destinationInfo
    );

    // Observations the destination hands back. Enqueued only
    // when the delivery commits, so a failed or retried delivery
    // emits nothing twice.
    const emitted = [];

    const ctx =
      createDestinationContext({
        config: item.entry.config ?? {},
        signal,
        logger: this.#scopedPluginLogger({
          scope: "destination",
          plugin: item.plugin.name,
          destination: item.destinationName,
          destinationId: item.id
        }),
        stateStore: this.pluginState,
        plugin: item.plugin.name,
        destination: item.destinationName,
        id: item.entry.id,
        idempotencyKey: key,
        attempt: job.attempts,
        emit: observation => {
          if (depth + 1 > this.handoffConfig.maxDepth) {
            throw new Error(
              `ctx.emit: handoff depth ${this.handoffConfig.maxDepth} reached (runtime.handoff.maxDepth)`
            );
          }

          if (emitted.length >= this.handoffConfig.maxPerDelivery) {
            throw new Error(
              `ctx.emit: at most ${this.handoffConfig.maxPerDelivery} observations per delivery (runtime.handoff.maxPerDelivery)`
            );
          }

          emitted.push(structuredClone(assertObservation(observation)));
        }
      });

    await item.destination.handle(
      ctx,
      item.plugin.apiVersion === DESTINATION_PLUGIN_API_VERSION_V1
        ? this.#legacyDestinationEvent(delivery.output, item)
        : structuredClone(delivery.output)
    );

    await commit(async executor => {
      await this.deliveries.update(
        key,
        deliveryChanges.delivered(job.attempts),
        { executor }
      );

      if (emitted.length > 0) {
        await this.transport.enqueue(
          emitted.map(observation => ({
            queue: "decide",
            queueKey: `observation:${observation.payload.id}`,
            maxAttempts: this.queueConfig.decide.retry.attempts,
            payload: {
              observation,
              emissionId: randomUUID(),
              pollId: null,
              // Not from an input: `input` stays empty and the
              // origin names the destination that emitted it.
              origin: {
                kind: "destination",
                id: item.id,
                plugin: item.plugin.name,
                name: item.destinationName,
                depth: depth + 1,
                lineage: [...lineage, item.id]
              }
            }
          })),
          { executor }
        );
      }
    });

    if (emitted.length > 0) {
      const emittedInfo = {
        plugin: destinationInfo.plugin,
        destination: destinationInfo.destination,
        destinationId: destinationInfo.destinationId,
        observationId: destinationInfo.observationId,
        deliveryKey: destinationInfo.deliveryKey,
        observations: emitted.map(observation => observation.payload.id),
        depth: depth + 1
      };

      this.logger.info?.(
        "destination emitted observations",
        emittedInfo
      );
      this.#emitTelemetry(
        "brainstem.destination.emitted",
        emittedInfo
      );
    }

    this.logger.debug?.(
      "destination handled decision",
      destinationInfo
    );
    this.#emitTelemetry(
      "brainstem.destination.completed",
      destinationInfo
    );
  }

  async #deliverFailed(job, error, { dead, retryInMs }) {
    const { key, destination: destinationId } =
      job.payload;

    await this.deliveries.update(
      key,
      deliveryChanges.failed({
        attempts: job.attempts,
        error,
        dead
      })
    );

    const item =
      this.destinationsById.get(destinationId);

    const delivery =
      await this.deliveries.get(key);

    const failureInfo = {
      ...this.#destinationInfo(item, delivery, job),
      ...(item ? {} : { destinationId }),
      dead,
      retryInMs,
      error
    };

    this.logger[dead ? "error" : "warn"]?.(
      dead
        ? "destination failed; moved to dead deliveries"
        : "destination failed; retrying",
      failureInfo
    );
    this.#emitTelemetry(
      "brainstem.destination.failed",
      failureInfo
    );
  }

  #destinationInfo(item, delivery, job) {
    const output =
      delivery?.output?.payload ?? {};

    return {
      plugin: item?.plugin.name ?? delivery?.plugin ?? null,
      destination: item?.destinationName ?? output.destination?.name ?? null,
      destinationId: item?.id ?? delivery?.destination ?? null,
      observationId: delivery?.observationId ?? null,
      decision: delivery?.decision ?? null,
      pollId: output.pollId ?? null,
      deliveryKey: delivery?.key ?? job.payload.key,
      attempt: job.attempts,
      attempts: job.maxAttempts,
      decisionEnvelope: output.decision ?? null,
      observationEnvelope: output.observation ?? null
    };
  }

  /*
   * brainstem.destination/v1 adapter: rebuild the
   * 1.x event (with live plugin objects where this
   * process has them) from the output envelope.
   */
  #legacyDestinationEvent(output, item) {
    const payload =
      structuredClone(output.payload);

    const loadedInput =
      this.inputsById.get(payload.input.id);

    return {
      decision: payload.decision,
      observation: payload.observation,
      pollId: payload.pollId,
      input: {
        plugin:
          loadedInput?.plugin ??
          { name: payload.input.plugin },
        name: payload.input.name,
        entry:
          loadedInput?.entry ??
          {
            id: payload.input.id,
            module: payload.input.module
          }
      },
      destination: {
        plugin: item.plugin,
        name: item.destinationName,
        entry: item.entry
      }
    };
  }

  /*
   * After run-once: jobs that still wait (for a
   * retry backoff) survive only in a durable
   * transport.
   */
  async #reportPendingJobs() {
    const counts =
      await this.transport.counts();

    const waiting =
      counts
        .filter(row => row.state === "ready")
        .reduce((sum, row) => sum + row.count, 0);

    const dead =
      counts
        .filter(row => row.state === "dead")
        .reduce((sum, row) => sum + row.count, 0);

    if (waiting > 0) {
      this.logger.warn?.(
        this.transport.durable
          ? "jobs are waiting for a retry; they run on the next start"
          : "jobs are waiting for a retry but the queue is in memory; they are dropped on exit",
        { jobs: waiting }
      );
    }

    if (dead > 0) {
      this.logger.warn?.(
        "dead jobs need attention (redrive or discard them in the UI)",
        { jobs: dead }
      );
    }
  }

  #startDeliveryPruning() {
    const days =
      this.config.runtime?.deliveries?.pruneAfterDays ??
      DEFAULT_DELIVERY_PRUNE_AFTER_DAYS;

    if (
      this.deliveryPruneTimer ||
      typeof days !== "number" ||
      days <= 0
    ) {
      return;
    }

    const run = () =>
      this.deliveryPruning = this.deliveries
        .prune({
          olderThan: new Date(
            Date.now() - days * 24 * 60 * 60 * 1000
          ).toISOString()
        })
        .catch(error => {
          this.logger.warn?.(
            "delivery log prune failed",
            { error }
          );
        });

    run();

    this.deliveryPruneTimer =
      setInterval(run, DELIVERY_PRUNE_INTERVAL_MS);

    this.deliveryPruneTimer.unref?.();
  }
}

/*
 * Idempotency key of one delivery:
 *
 *   <destination id>:<observation id>:r<revision>:<emission id>
 *
 * The emission id is fixed when the observation is
 * polled, so every retry of the same delivery has
 * the same key while a re-emitted (e.g. reminder)
 * observation gets a new one.
 */
/*
 * The origin of a decide or deliver job. Jobs queued before
 * origins existed carry `lineage` (handoffs) or only `input`.
 */
function legacyOrigin(payload) {
  if (payload.origin) return payload.origin;

  if (payload.lineage) {
    const lineage = payload.lineage.destinations ?? [];
    return {
      kind: "destination",
      id: lineage.at(-1) ?? null,
      depth: payload.lineage.depth ?? lineage.length,
      lineage
    };
  }

  return payload.input?.id
    ? { kind: "input", id: payload.input.id }
    : null;
}

export function deliveryKey({
  destinationId,
  observationId,
  revision,
  emissionId
}) {
  return `${destinationId}:${observationId}:r${revision ?? 0}:${emissionId}`;
}

export function normalizeQueueConfig(queue = {}) {
  const defaults =
    DEFAULT_QUEUE_CONFIG;

  return {
    transport:
      queue.transport ?? null,
    pollIntervalMs:
      Math.max(10, Number(queue.pollIntervalMs ?? defaults.pollIntervalMs)),
    leaseMs:
      Math.max(1_000, Number(queue.leaseMs ?? defaults.leaseMs)),
    decide: {
      concurrency:
        Math.max(1, Number(queue.decide?.concurrency ?? defaults.decide.concurrency)),
      retry:
        normalizeJobRetry(queue.decide?.retry ?? {}, defaults.decide.retry)
    },
    deliver: {
      concurrency:
        Math.max(1, Number(queue.deliver?.concurrency ?? defaults.deliver.concurrency)),
      retry:
        normalizeJobRetry(queue.deliver?.retry ?? {}, defaults.deliver.retry)
    }
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

function defaultOnDecision() {}
