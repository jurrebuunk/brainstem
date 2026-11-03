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
import { DEFAULT_CORE_HEARTBEAT_MS, createCoreRegistry } from "./cores.mjs";
import {
  DEFAULT_INPUT_LEASE_MS,
  InputLeaseLostError,
  createInputLeaseStore,
  nextDueAt
} from "./input-leases.mjs";
import { withSingletonLock } from "../db/locks.mjs";
import { defaultRegistry } from "../observability/metrics.mjs";
import { runtimeMetrics } from "../observability/brainstem-metrics.mjs";
import { SPAN_KIND, defaultTracer } from "../observability/tracing.mjs";
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
 * Pipeline stages a core can run (roadmap 4.1, --queues):
 * poll (claim inputs by lease and poll them), decide (Laya) and
 * deliver (destinations).
 */
export const CORE_QUEUES = ["poll", "decide", "deliver"];

export const DEFAULT_INPUT_CONFIG = {
  // "lease" whenever the pipeline is in the database, else "timer".
  scheduling: null,
  leaseMs: DEFAULT_INPUT_LEASE_MS,
  // Inputs one core polls at the same time.
  concurrency: 16,
  // Longest wait between schedule checks when nothing wakes the core.
  checkIntervalMs: 5_000
};

export const DEFAULT_SHUTDOWN_CONFIG = {
  // How long drain() lets in-flight polls and jobs finish.
  timeoutMs: 25_000
};

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
    pipeline,
    role,
    queues,
    configVersion = null,
    metrics,
    tracer
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

    /*
     * Which stages this core runs. A core-deliver replica never
     * loads the Laya model; a core-decide replica never polls.
     */
    this.role =
      role ?? this.config.runtime?.role ?? "all";
    this.queues =
      normalizeCoreQueues(queues ?? this.config.runtime?.queues);
    this.configVersion = configVersion;

    this.inputConfig =
      normalizeInputConfig(this.config.runtime?.inputs);
    this.shutdownConfig = {
      ...DEFAULT_SHUTDOWN_CONFIG,
      ...(this.config.runtime?.shutdown ?? {})
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

    if (
      !this.queues.every(queue => CORE_QUEUES.includes(queue))
    ) {
      throw new Error(
        `Unknown queue in runtime.queues (${this.queues.join(", ")}). Use ${CORE_QUEUES.join(", ")}.`
      );
    }

    if (
      this.queues.length < CORE_QUEUES.length &&
      this.pipeline.type !== "database"
    ) {
      throw new Error(
        "Running a subset of queues needs the database transport: the other stages run in other processes"
      );
    }

    /*
     * Inputs are scheduled by leases in the `inputs` table when
     * the pipeline lives in the runtime database, so several cores
     * never poll one input at once. Otherwise (memory pipeline,
     * injected storage) each input polls on its own timer.
     */
    const scheduling =
      this.inputConfig.scheduling ??
      (!pipeline && this.pipeline.type === "database" ? "lease" : "timer");

    if (!["lease", "timer"].includes(scheduling)) {
      throw new Error(
        `Unknown runtime.inputs.scheduling '${scheduling}'. Use 'lease' or 'timer'.`
      );
    }

    this.inputLeases =
      scheduling === "lease"
        ? createInputLeaseStore({ database: () => this.database.get() })
        : null;

    /*
     * Core registry: this process registers in the `cores` table
     * and heartbeats, so the API knows which cores exist. Only
     * when the runtime already uses a database (an injected
     * handle or the database transport); runtimes on memory/JSON
     * state never open one just for this.
     */
    this.coreHeartbeatMs =
      this.config.runtime?.cores?.heartbeatMs ?? DEFAULT_CORE_HEARTBEAT_MS;
    this.coreRegistry =
      this.config.runtime?.cores?.enabled !== false &&
      (!this.database.owned || this.pipeline.type === "database")
        ? createCoreRegistry({ database: () => this.database.get() })
        : null;
    this.coreHeartbeatTimer = null;

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
    this.work = null;
    this.started = false;
    this.draining = false;
    this.reconfiguring = null;
    this.runner = null;
    this.deliveryPruneTimer = null;
    this.deliveryPruning = null;
    this.destinationEntries = [];
    this.destinationsById = new Map();
    this.loadedInputs = new Map();
    this.inputsById = new Map();
    this.warnedV1Plugins = new Set();
    this.telemetry = createTelemetrySink(
      this.config.runtime?.telemetry ?? undefined
    );
    this.telemetryInterval = null;

    /*
     * Prometheus metrics (process registry unless injected) and
     * OpenTelemetry tracing (off unless OTEL_EXPORTER_OTLP_ENDPOINT
     * is set). See docs/observability.md.
     */
    this.metricsRegistry = metrics ?? defaultRegistry();
    this.metrics = runtimeMetrics(this.metricsRegistry);
    this.tracer = tracer ?? defaultTracer();
    this.removeMetricsCollector = null;
  }

  async start({ signal } = {}) {
    if (this.abortController) {
      throw new Error(
        "BrainstemRuntime has already been started"
      );
    }

    this.#createAbortController(signal);

    this.logger.info?.(
      "runtime starting",
      {
        coreId: this.coreId,
        role: this.role,
        queues: this.queues,
        inputs: this.plugins.length,
        destinations: this.destinations.length,
        records: storeInfo(this.recordStore),
        checkpoints: storeInfo(this.checkpointStore)
      }
    );
    this.#emitTelemetry("brainstem.runtime.starting", {
      role: this.role,
      queues: this.queues,
      inputs: this.plugins.length,
      destinations: this.destinations.length
    });

    await this.#prepare(this.abortController.signal);

    this.#emitSnapshot();
    this.#startTelemetrySnapshots();
    this.#startDeliveryPruning();
    await this.#startCoreHeartbeat();

    this.#startWork();
    this.started = true;
    this.#startMetrics();

    this.logger.info?.(
      "runtime started",
      {
        coreId: this.coreId,
        queues: this.queues,
        inputs: this.plugins.length,
        destinations: this.destinationEntries.length,
        scheduling: this.inputLeases ? "lease" : "timer"
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

    this.#createAbortController(signal);

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

      await this.#prepare(this.abortController.signal);

      this.#emitSnapshot();
      await this.#startCoreHeartbeat();
      this.started = true;

      const polls =
        this.queues.includes("poll")
          ? await Promise.allSettled(
              this.plugins.map((entry, index) =>
                this.#runPluginEntryOnce(
                  entry,
                  index,
                  this.abortController.signal
                )
              )
            )
          : [];

      /*
       * Decide and deliver everything the polls
       * (and earlier runs) queued. Retries that
       * are not due yet stay queued for the next
       * run.
       */
      this.runner =
        this.#createRunner();

      const drained =
        this.runner
          ? await this.runner.drain(
              this.abortController.signal
            )
          : { processed: 0, failures: [] };

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

  /*
   * Resolves when the runtime stops (a reconfigure replaces the
   * running work without resolving it). Rejects when an input or
   * the job runner fails.
   */
  async wait() {
    while (true) {
      const tasks = this.tasks;

      await Promise.all(tasks);

      if (this.reconfiguring) {
        await this.reconfiguring.catch(() => {});
      }

      if (
        this.tasks !== tasks &&
        this.abortController &&
        !this.abortController.signal.aborted
      ) {
        continue;
      }

      return;
    }
  }

  /*
   * Graceful shutdown (SIGTERM): stop claiming inputs and jobs,
   * let in-flight polls and jobs finish for up to `timeoutMs`,
   * then abort what is left (aborted jobs go back to the queue
   * without counting the attempt; leases are released). Readiness
   * reports not ready from the first moment.
   */
  async drain({ timeoutMs = this.shutdownConfig.timeoutMs } = {}) {
    if (this.draining) return;

    this.draining = true;
    this.metrics.draining.set({}, 1);

    this.logger.info?.(
      "runtime draining",
      { coreId: this.coreId, timeoutMs }
    );
    this.#emitTelemetry("brainstem.runtime.draining", { timeoutMs });

    await this.reconfiguring?.catch(() => {});
    await this.#stopWork({ timeoutMs });
  }

  /*
   * Liveness, readiness and startup state for health endpoints
   * (roadmap §5). Readiness also needs the database reachable;
   * see ready().
   */
  health() {
    return {
      coreId: this.coreId,
      role: this.role,
      queues: this.queues,
      configVersion: this.configVersion,
      started: this.started,
      draining: this.draining,
      reconfiguring: Boolean(this.reconfiguring)
    };
  }

  async ready({ timeoutMs = 2_000 } = {}) {
    if (!this.started || this.draining) return false;
    if (!this.coreRegistry && !this.inputLeases && this.pipeline.type !== "database") return true;

    try {
      const handle = await this.database.get();
      await withTimeout(
        handle.db.selectFrom("cores").select("id").limit(1).execute(),
        timeoutMs
      );
      return true;
    }
    catch {
      return false;
    }
  }

  /*
   * Hot reload (roadmap 4.6): switch to a new config without
   * restarting. Claiming stops, in-flight polls and jobs finish
   * (up to runtime.shutdown.timeoutMs), then inputs and
   * destinations reload and work resumes. When the new config
   * fails to load, the previous one keeps running and the error is
   * thrown.
   *
   * Takes effect: inputs, destinations, policy, laya questions and
   * load options, runtime.queue (except transport), inputs (except
   * scheduling), handoff, shutdown. Needs a restart: database,
   * records, checkpoints, queue.transport, inputs.scheduling,
   * cores, role and queues.
   */
  async reconfigure({
    config,
    plugins = config.inputs ?? [],
    destinations = config.destinations ?? [],
    configVersion = null
  }) {
    const previous = this.reconfiguring ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() => this.#reconfigure({ config, plugins, destinations, configVersion }));

    this.reconfiguring = run;

    try {
      return await run;
    }
    finally {
      if (this.reconfiguring === run) this.reconfiguring = null;
    }
  }

  async #reconfigure({ config, plugins, destinations, configVersion }) {
    const previous = {
      config: this.config,
      plugins: this.plugins,
      destinations: this.destinations,
      configVersion: this.configVersion
    };

    if (!this.started || this.draining || !this.abortController) {
      this.#applyConfig({ config, plugins, destinations, configVersion });
      return;
    }

    this.logger.info?.(
      "config changed; reloading",
      { from: previous.configVersion, to: configVersion }
    );

    await this.#stopWork({ timeoutMs: this.shutdownConfig.timeoutMs });

    if (this.abortController.signal.aborted || this.draining) return;

    try {
      this.#applyConfig({ config, plugins, destinations, configVersion });
      await this.#prepareReload();
    }
    catch (error) {
      this.logger.error?.(
        "config reload failed; keeping the previous config",
        { version: configVersion, error }
      );

      this.#applyConfig(previous);
      await this.#prepareReload().catch(restoreError => {
        this.logger.error?.("restoring the previous config failed", { error: restoreError });
      });
      this.#startWork();
      this.#emitSnapshot();

      throw error;
    }

    this.#startWork();
    this.#emitSnapshot();
    this.#heartbeatNow();

    this.logger.info?.(
      "config reloaded",
      {
        version: configVersion,
        inputs: this.plugins.length,
        destinations: this.destinationEntries.length
      }
    );
    this.#emitTelemetry("brainstem.config.reloaded", {
      from: previous.configVersion,
      to: configVersion,
      inputs: this.plugins.length,
      destinations: this.destinationEntries.length
    });
  }

  #applyConfig({ config, plugins, destinations, configVersion }) {
    this.config = config;
    this.plugins = plugins;
    this.destinations = destinations;
    this.configVersion = configVersion;

    this.queueConfig = {
      ...normalizeQueueConfig(config.runtime?.queue),
      transport: this.queueConfig.transport
    };
    this.handoffConfig = {
      maxDepth: config.runtime?.handoff?.maxDepth ?? 2,
      maxPerDelivery: config.runtime?.handoff?.maxPerDelivery ?? 5
    };
    this.inputConfig = {
      ...normalizeInputConfig(config.runtime?.inputs),
      scheduling: this.inputConfig.scheduling
    };
    this.shutdownConfig = {
      ...DEFAULT_SHUTDOWN_CONFIG,
      ...(config.runtime?.shutdown ?? {})
    };
  }

  async #prepareReload() {
    this.loadedInputs.clear();
    this.inputsById.clear();

    if (this.queues.includes("decide")) {
      await this.brainstem.reconfigure?.(this.config);
    }

    if (
      this.queues.includes("decide") ||
      this.queues.includes("deliver")
    ) {
      await this.#loadDestinationEntries();
    }
  }

  #heartbeatNow() {
    if (!this.coreRegistry || !this.coreHeartbeatTimer) return;

    this.coreHeartbeat = this.coreRegistry
      .heartbeat(this.coreId, {
        topology: this.#topology(),
        configVersion: this.configVersion
      })
      .catch(error => {
        this.logger.warn?.("core heartbeat failed", { coreId: this.coreId, error });
      });
  }

  #createAbortController(signal) {
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
  }

  /*
   * Load what this core's queues need: the Laya model for decide,
   * destinations for decide (routing) and deliver.
   */
  async #prepare(signal) {
    if (this.queues.includes("decide")) {
      await this.#startBrainstem(signal);
    }

    if (
      this.queues.includes("decide") ||
      this.queues.includes("deliver")
    ) {
      await this.#loadDestinationEntries();
    }
  }

  /*
   * One generation of running work: input polling and the job
   * runner. `stop` ends claiming (drain, reconfigure); `abort`
   * also interrupts in-flight work.
   */
  #startWork() {
    const stop = new AbortController();
    const abort = new AbortController();
    const runtimeSignal = this.abortController.signal;

    if (runtimeSignal.aborted) abort.abort(runtimeSignal.reason);
    else runtimeSignal.addEventListener("abort", () => abort.abort(runtimeSignal.reason), { once: true });

    const tasks = [];

    if (this.queues.includes("poll")) {
      if (this.inputLeases) {
        tasks.push(
          this.#runInputScheduler({ stop: stop.signal, signal: abort.signal })
        );
      }
      else {
        tasks.push(
          ...this.plugins.map((entry, index) =>
            this.#runPluginEntry(entry, index, { stop: stop.signal, signal: abort.signal })
          )
        );
      }
    }

    this.runner =
      this.#createRunner();

    if (this.runner) {
      tasks.push(
        this.runner
          .start(abort.signal, { stop: stop.signal })
          .catch(error => {
            this.logger.error?.(
              "job runner failed",
              { error }
            );
          })
      );
    }

    this.work = { stop, abort, tasks };
    this.tasks = tasks;
  }

  async #stopWork({ timeoutMs = 0 } = {}) {
    const work = this.work;
    if (!work) return;

    work.stop.abort();

    const settled = Promise.allSettled(work.tasks);

    if (timeoutMs > 0 && !work.abort.signal.aborted) {
      let timer;
      const timedOut = await Promise.race([
        settled.then(() => false),
        new Promise(resolve => {
          timer = setTimeout(() => resolve(true), timeoutMs);
          timer.unref?.();
        })
      ]);
      clearTimeout(timer);

      if (timedOut) {
        this.logger.warn?.(
          "in-flight work did not finish in time; aborting it",
          { timeoutMs }
        );
      }
    }

    work.abort.abort();
    await settled;
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

    await this.reconfiguring?.catch(() => {});
    await this.#stopWork({ timeoutMs: 0 });
    await Promise.allSettled(
      this.tasks
    );

    await this.#stopCoreHeartbeat();

    this.removeMetricsCollector?.();
    this.removeMetricsCollector = null;
    await this.tracer.flush().catch(() => {});

    await this.brainstem.close();
    await this.checkpointStore.close?.();
    await this.transport.close?.();
    await this.database.close();

    this.abortController = null;
    this.tasks = [];
    this.work = null;
    this.started = false;
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

  /*
   * Timer scheduling (memory pipeline): this process polls the
   * input every intervalMs.
   */
  async #runPluginEntry(entry, index, { stop, signal }) {
    const loaded =
      await this.#loadEntry(entry, index);
    const stopOrAbort =
      AbortSignal.any([stop, signal]);

    while (!stopOrAbort.aborted) {
      try {
        await this.#pollInputWithRetry({
          ...loaded,
          signal
        });
      }
      catch (error) {
        this.#pollFailed(loaded, error);
      }

      await sleep(loaded.intervalMs, stopOrAbort);
    }
  }

  async #runPluginEntryOnce(entry, index, signal) {
    const loaded =
      await this.#loadEntry(entry, index);

    if (!this.inputLeases) {
      await this.#pollInputWithRetry({
        ...loaded,
        signal
      });
      return;
    }

    // Poll now regardless of the schedule, but never while another
    // core holds the input.
    await this.inputLeases.declare([inputDeclaration(loaded)]);

    const [lease] =
      await this.inputLeases.claim({
        ids: [loaded.checkpointKey],
        owner: this.coreId,
        leaseMs: this.inputConfig.leaseMs,
        force: true
      });

    if (!lease) {
      this.logger.warn?.(
        "input is being polled by another core; skipped",
        { id: loaded.checkpointKey }
      );
      return;
    }

    await this.#pollLeased(loaded, lease, signal, { rethrow: true });
  }

  /*
   * Lease scheduling (roadmap 4.3): claim due inputs from the
   * `inputs` table, poll them, release with the next due time.
   * Every core runs this; the claim makes sure only one of them
   * polls an input at a time.
   */
  async #runInputScheduler({ stop, signal }) {
    const loaded = [];

    for (const [index, entry] of this.plugins.entries()) {
      loaded.push(await this.#loadEntry(entry, index));
    }

    const byId = new Map();

    for (const item of loaded) {
      if (byId.has(item.checkpointKey)) {
        throw new Error(
          `Duplicate input id '${item.checkpointKey}'. Give each input a unique 'id'.`
        );
      }

      byId.set(item.checkpointKey, item);
    }

    await this.inputLeases.declare(loaded.map(inputDeclaration));

    const running = new Map();
    const wake = createWake();
    const stopOrAbort = AbortSignal.any([stop, signal]);
    const notifier = (await this.database.get()).notifier;
    const unlisten = notifier?.listen("inputs", () => wake.notify());

    try {
      while (!stopOrAbort.aborted) {
        const free =
          [...byId.keys()].filter(id => !running.has(id));
        const capacity =
          this.inputConfig.concurrency - running.size;
        let leases = [];

        if (capacity > 0 && free.length > 0) {
          try {
            leases = await this.inputLeases.claim({
              ids: free,
              owner: this.coreId,
              limit: capacity,
              leaseMs: this.inputConfig.leaseMs
            });
          }
          catch (error) {
            if (stopOrAbort.aborted) break;
            this.logger.error?.("input claim failed", { error });
          }
        }

        for (const lease of leases) {
          const run = this.#pollLeased(byId.get(lease.id), lease, signal)
            .finally(() => {
              running.delete(lease.id);
              wake.notify();
            });

          running.set(lease.id, run);
        }

        if (capacity > 0 && leases.length === capacity) continue;

        let delayMs = this.inputConfig.checkIntervalMs;

        try {
          const waiting =
            [...byId.keys()].filter(id => !running.has(id));
          const next =
            await this.inputLeases.nextClaimAt(waiting);

          if (next !== null) {
            delayMs = Math.min(delayMs, Math.max(10, next - Date.now()));
          }
        }
        catch {
          // Keep the default delay; the next claim reports errors.
        }

        await wake.wait(stopOrAbort, delayMs);
      }
    }
    finally {
      unlisten?.();
      await Promise.allSettled(running.values());
      await this.inputLeases.releaseAll(this.coreId).catch(() => {});
    }
  }

  /*
   * One leased poll: renew the lease while it runs (a lost lease
   * aborts the poll), then release it with the next due time.
   */
  async #pollLeased(loaded, lease, signal, { rethrow = false } = {}) {
    this.metrics.leaseLag.set(
      { input: lease.id },
      Math.max(0, (Date.now() - lease.nextDueAt) / 1000)
    );

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);

    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    const renew = setInterval(async () => {
      try {
        const held = await this.inputLeases.extend(lease, {
          leaseMs: this.inputConfig.leaseMs
        });

        if (!held) controller.abort(new InputLeaseLostError(lease));
      }
      catch (error) {
        this.logger.warn?.("input lease renewal failed", { id: lease.id, error });
      }
    }, Math.max(10, Math.floor(this.inputConfig.leaseMs / 3)));
    renew.unref?.();

    let failure = null;

    try {
      await this.#pollInputWithRetry({
        ...loaded,
        signal: controller.signal,
        lease
      });
    }
    catch (error) {
      failure = error;
    }
    finally {
      clearInterval(renew);
      signal.removeEventListener("abort", onAbort);
    }

    const leaseLost =
      failure instanceof InputLeaseLostError ||
      controller.signal.reason instanceof InputLeaseLostError;

    if (leaseLost) {
      this.logger.warn?.(
        "input lease lost; another core polls it now",
        { id: lease.id, epoch: lease.epoch }
      );
      return;
    }

    if (signal.aborted) {
      // Interrupted by shutdown: keep the schedule so another core
      // polls it right away.
      await this.inputLeases.release(lease).catch(() => {});
      return;
    }

    if (failure) this.#pollFailed(loaded, failure);

    try {
      await this.inputLeases.release(lease, {
        nextDueAt: nextDueAt(loaded.intervalMs),
        polled: true,
        error: failure ? failure.message ?? String(failure) : null
      });
      (await this.database.get()).notifier?.notify("inputs");
    }
    catch (error) {
      this.logger.warn?.("input lease release failed", { id: lease.id, error });
    }

    if (failure && rethrow) throw failure;
  }

  #pollFailed(loaded, error) {
    const info = {
      id: loaded.checkpointKey,
      plugin: loaded.plugin.name,
      input: loaded.inputName,
      error
    };

    this.logger.error?.("input poll failed", info);
    this.#emitTelemetry("brainstem.input.poll.failed", info);
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
    const topology = this.#topology();

    this.#emitTelemetry("brainstem.snapshot", {
      inputs: topology.inputs,
      core: {
        id: this.coreId,
        status: this.brainstem?.laya ? "running" : "starting"
      },
      destinations: topology.destinations
    });
  }

  /*
   * What this core loaded: inputs and destinations with resolved
   * ids. Sent in snapshots and stored in the core registry.
   */
  #topology() {
    return {
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
    };
  }

  /*
   * Registry failures are logged, never fatal: a core keeps
   * working when it can't report itself.
   */
  async #startCoreHeartbeat() {
    if (!this.coreRegistry || this.coreHeartbeatTimer) return;

    try {
      await this.coreRegistry.register({
        id: this.coreId,
        role: this.role,
        queues: this.queues,
        heartbeatMs: this.coreHeartbeatMs,
        topology: this.#topology(),
        configVersion: this.configVersion
      });
    }
    catch (error) {
      this.logger.warn?.("core registration failed", { coreId: this.coreId, error });
    }

    this.coreHeartbeatTimer = setInterval(() => {
      this.coreHeartbeat = this.coreRegistry
        .heartbeat(this.coreId, {
          topology: this.#topology(),
          configVersion: this.configVersion
        })
        .catch(error => {
          this.logger.warn?.("core heartbeat failed", { coreId: this.coreId, error });
        });
    }, this.coreHeartbeatMs);

    this.coreHeartbeatTimer.unref?.();
  }

  async #stopCoreHeartbeat() {
    if (!this.coreHeartbeatTimer) return;

    clearInterval(this.coreHeartbeatTimer);
    this.coreHeartbeatTimer = null;
    await this.coreHeartbeat;

    await this.coreRegistry.stop(this.coreId).catch(error => {
      this.logger.warn?.("core stop registration failed", { coreId: this.coreId, error });
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

  /*
   * One poll attempt in its own trace (the root of every envelope
   * it emits), timed and counted per input.
   */
  async #pollInput(args) {
    const started = performance.now();

    try {
      await this.tracer.span(
        `poll ${args.checkpointKey}`,
        {
          parent: null,
          attributes: {
            "brainstem.input.id": args.checkpointKey,
            "brainstem.input.plugin": args.plugin.name,
            "brainstem.input.name": args.inputName,
            "brainstem.core.id": this.coreId,
            ...(args.lease ? { "brainstem.lease.epoch": args.lease.epoch } : {})
          }
        },
        span => this.#pollInputOnce(args, span)
      );
      this.metrics.polls.inc({ input: args.checkpointKey, outcome: "ok" });
    }
    catch (error) {
      if (!args.signal.aborted) {
        this.metrics.polls.inc({ input: args.checkpointKey, outcome: "failed" });
      }
      throw error;
    }
    finally {
      this.metrics.pollDuration.observe(
        { input: args.checkpointKey },
        (performance.now() - started) / 1000
      );
    }
  }

  async #pollInputOnce({
    entry,
    plugin,
    inputName,
    input,
    signal,
    checkpointKey,
    lease = null
  }, span) {
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
        id: checkpointKey,
        lease: lease
          ? {
              id: lease.id,
              owner: lease.owner,
              epoch: lease.epoch,
              get until() {
                return lease.until;
              },
              extend: (leaseMs = this.inputConfig.leaseMs) =>
                this.inputLeases.extend(lease, { leaseMs })
            }
          : null
      });

    // Unique across cores and restarts.
    const pollId = `${checkpointKey}:${Date.now()}:${randomUUID().slice(0, 8)}`;

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
          ...(span.traceparent ? { trace: span.traceparent } : {}),
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
    /*
     * With a lease the commit is fenced on its epoch: when another
     * core claimed the input meanwhile, nothing is committed and
     * that core polls again from the stored checkpoint.
     */
    if (this.checkpointsInTransaction) {
      await this.transport.transaction(async executor => {
        if (lease) await this.inputLeases.fence(lease, { executor });
        await this.transport.enqueue(jobs, { executor });
        await checkpoint.commit({ executor });
      });
    }
    else {
      if (lease) await this.inputLeases.fence(lease);

      if (jobs.length > 0) {
        await this.transport.enqueue(jobs);
      }

      await checkpoint.commit();
    }

    span.setAttributes({
      "brainstem.poll.id": pollId,
      "brainstem.poll.observations": jobs.length
    });
    if (jobs.length > 0) {
      this.metrics.observations.inc({ input: checkpointKey }, jobs.length);
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

  /*
   * Job runner for this core's decide and deliver queues, or null
   * when it runs neither (a poll-only core).
   */
  #createRunner() {
    const queues = {
      decide: {
        concurrency: this.queueConfig.decide.concurrency,
        retry: this.queueConfig.decide.retry,
        handler: (job, context) =>
          this.#inJobSpan("decide", job, context, (span, ctx) => this.#decide(job, ctx, span)),
        onFailure: (job, error, details) =>
          this.#decideFailed(job, error, details)
      },
      deliver: {
        concurrency: this.queueConfig.deliver.concurrency,
        retryFor: job =>
          this.destinationsById.get(job.payload.destination)?.retry ??
          this.queueConfig.deliver.retry,
        handler: (job, context) =>
          this.#inJobSpan(
            `deliver ${job.payload.destination}`,
            job,
            context,
            (span, ctx) => this.#deliver(job, ctx, span)
          ),
        onFailure: (job, error, details) =>
          this.#deliverFailed(job, error, details)
      }
    };

    for (const name of Object.keys(queues)) {
      if (!this.queues.includes(name)) delete queues[name];
    }

    if (Object.keys(queues).length === 0) return null;

    return new JobRunner({
      transport: this.transport,
      workerId: this.coreId,
      leaseMs: this.queueConfig.leaseMs,
      pollIntervalMs: this.queueConfig.pollIntervalMs,
      logger: this.logger,
      queues,
      onSettled: (job, { outcome, durationMs }) => {
        this.metrics.jobDuration.observe(
          { queue: job.queue, outcome },
          durationMs / 1000
        );

        if (outcome === "retry" || outcome === "dead") {
          this.metrics.jobFailures.inc({
            queue: job.queue,
            dead: String(outcome === "dead")
          });
        }
      }
    });
  }

  /*
   * A job's span continues the trace of the stage that enqueued it
   * (payload.trace), so one envelope is one trace across cores.
   */
  async #inJobSpan(name, job, context, fn) {
    return await this.tracer.span(
      name,
      {
        parent: job.payload.trace ?? null,
        kind: SPAN_KIND.consumer,
        attributes: {
          "brainstem.job.id": job.id,
          "brainstem.job.queue": job.queue,
          "brainstem.job.attempt": job.attempts,
          "brainstem.core.id": this.coreId
        }
      },
      span => fn(span, context)
    );
  }

  #startMetrics() {
    this.metrics.draining.set({}, 0);
    this.metrics.coreInfo.set(
      { core_id: this.coreId, role: this.role, queues: this.queues.join(",") },
      1
    );

    this.removeMetricsCollector?.();
    this.removeMetricsCollector = this.metricsRegistry.collect(() => {
      for (const queue of this.queues.filter(name => name !== "poll")) {
        const running = this.runner
          ? [...this.runner.inflight.values()].filter(run => run.queue === queue).length
          : 0;
        this.metrics.inflight.set({ queue }, running);
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
  async #decide(job, { signal, commit }, span) {
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

    this.metrics.decisions.inc({ decision: decisionPayload.decision ?? "unknown" });
    span.setAttributes({
      "brainstem.observation.id": observationPayload.id,
      "brainstem.observation.source": observationPayload.source?.type,
      "brainstem.decision": decisionPayload.decision,
      "brainstem.decision.route": decisionPayload.route,
      "brainstem.decision.revision": decisionPayload.revision
    });

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
            ...(span.traceparent ? { trace: span.traceparent } : {}),
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
  async #deliver(job, { signal, commit }, span) {
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

    span.setAttributes({
      "brainstem.destination.id": item.id,
      "brainstem.destination.plugin": item.plugin.name,
      "brainstem.delivery.key": key,
      "brainstem.observation.id": delivery.observationId ?? destinationInfo.observationId
    });

    if (delivery.status === "delivered") {
      this.logger.debug?.(
        "destination already delivered; skipping",
        destinationInfo
      );
      span.setAttribute("brainstem.delivery.outcome", "skipped");
      this.metrics.deliveries.inc({ destination: item.id, plugin: item.plugin.name, outcome: "skipped" });
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
        traceparent: span.traceparent,
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
              ...(span.traceparent ? { trace: span.traceparent } : {}),
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

    span.setAttribute("brainstem.delivery.outcome", "delivered");
    this.metrics.deliveries.inc({ destination: item.id, plugin: item.plugin.name, outcome: "delivered" });

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

    this.metrics.deliveries.inc({
      destination: destinationId,
      plugin: item?.plugin.name ?? delivery?.plugin ?? "unknown",
      outcome: dead ? "dead" : "failed"
    });

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

    const prune = () =>
      this.deliveries.prune({
        olderThan: new Date(
          Date.now() - days * 24 * 60 * 60 * 1000
        ).toISOString()
      });

    // One core at a time in a cluster (advisory lock).
    const run = () =>
      this.deliveryPruning = (
        this.pipeline.type === "database"
          ? this.database.get().then(handle =>
              withSingletonLock(handle, "deliveries.prune", prune)
            )
          : prune()
      )
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

export function normalizeCoreQueues(queues) {
  if (queues === undefined || queues === null || queues === "all") {
    return [...CORE_QUEUES];
  }

  const list = (Array.isArray(queues) ? queues : String(queues).split(","))
    .map(queue => String(queue).trim())
    .filter(Boolean);

  if (list.length === 0) {
    throw new Error("runtime.queues must name at least one of poll, decide, deliver");
  }

  return CORE_QUEUES.filter(queue => list.includes(queue))
    .concat(list.filter(queue => !CORE_QUEUES.includes(queue)));
}

export function normalizeInputConfig(inputs = {}) {
  const defaults = DEFAULT_INPUT_CONFIG;

  return {
    scheduling: inputs.scheduling ?? defaults.scheduling,
    leaseMs: Math.max(1_000, Number(inputs.leaseMs ?? defaults.leaseMs)),
    concurrency: Math.max(1, Math.floor(Number(inputs.concurrency ?? defaults.concurrency))),
    checkIntervalMs: Math.max(10, Number(inputs.checkIntervalMs ?? defaults.checkIntervalMs))
  };
}

function inputDeclaration(loaded) {
  return {
    id: loaded.checkpointKey,
    plugin: loaded.plugin.name,
    input: loaded.inputName,
    intervalMs: loaded.intervalMs
  };
}

/*
 * Wait for a timeout or an explicit wakeup, whichever comes first.
 */
function createWake() {
  let resolveWait = null;
  let pending = false;

  return {
    notify() {
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
      }
      else {
        pending = true;
      }
    },

    async wait(signal, delayMs) {
      if (pending || signal.aborted) {
        pending = false;
        return;
      }

      await new Promise(resolve => {
        const timer = setTimeout(done, delayMs);
        timer.unref?.();
        signal.addEventListener("abort", done, { once: true });

        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolveWait = null;
          resolve();
        }

        resolveWait = done;
      });
    }
  };
}

function withTimeout(promise, timeoutMs) {
  let timer;

  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    })
  ]);
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
