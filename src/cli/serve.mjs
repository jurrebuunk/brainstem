import {
  createBackendApiServer,
  normalizeBackendApiConfig
} from "../backend/api-server.mjs";
import { mergeBootstrap } from "../config/schema.mjs";
import { loadConfigFile, resolveConfigSource } from "../config/source.mjs";
import { createConfigVersionStore } from "../config/versions.mjs";
import { watchActiveConfig } from "../config/watch.mjs";
import { openRuntimeDatabase } from "../runtime/bootstrap.mjs";
import { createHealthServer } from "../runtime/health-server.mjs";
import { createRuntimeLogger } from "../runtime/logger.mjs";
import { BrainstemRuntime, normalizeCoreQueues } from "../runtime/runtime.mjs";
import { configureMetrics } from "../observability/metrics.mjs";
import { configureTracing } from "../observability/tracing.mjs";

/*
 * Process roles (roadmap 4.1). One image, one binary:
 *
 *   all   runtime (every queue) + the embedded API when enabled;
 *         migrates on start. Today's single-node mode.
 *   core  runtime only, with --queues; health endpoints on
 *         --health-port. Scales horizontally.
 *   api   REST, SSE, auth and config versions; probes on its port.
 *   web   the static Web UI and /api proxy (web/server.mjs).
 *
 * core and api never migrate (run `brainstem migrate` once, e.g. a
 * deploy hook) unless BRAINSTEM_MIGRATE=true; they refuse to start on
 * an outdated schema.
 */
export const ROLES = ["all", "core", "api", "web"];

export const DEFAULT_CORE_HEALTH_PORT = 8081;

export function resolveRole(flag) {
  const role = flag ?? process.env.BRAINSTEM_ROLE ?? "all";
  if (!ROLES.includes(role)) {
    throw new Error(`Unknown role '${role}'. Use ${ROLES.join(", ")}.`);
  }
  return role;
}

function shouldMigrate(role) {
  const value = process.env.BRAINSTEM_MIGRATE;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return role === "all";
}

/*
 * SIGINT/SIGTERM: drain first (stop claiming, finish in-flight
 * work, readiness fails), then abort. A second signal aborts at once.
 */
function onShutdown(handler) {
  let count = 0;

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      count += 1;
      handler(signal, count > 1);
    });
  }
}

export async function runApiProcess({
  configPath,
  host = null,
  port = null,
  migrate = null,
  log = console
}) {
  const config = (await loadConfigFile(configPath)) ?? {};
  const apiConfig = normalizeBackendApiConfig(
    {
      ...(config.runtime?.api ?? {}),
      enabled: true,
      ...(host ? { host } : {}),
      ...(port ? { port: Number(port) } : {}),
      configPath,
      configSource: resolveConfigSource({ config })
    },
    { repoRoot: process.cwd() }
  );

  // Same database as the runtime (runtime.database / BRAINSTEM_DATABASE_URL).
  const database = await openRuntimeDatabase(config, { migrate: migrate ?? shouldMigrate("api") });
  configureMetrics({ role: "api" });
  const tracer = configureTracing({ role: "api", logger: createRuntimeLogger(config.runtime?.logging ?? {}) });
  const api = createBackendApiServer({ ...apiConfig, database });
  await api.listen();

  log.log?.(`Brainstem Backend API listening on ${api.url}`);
  log.log?.(`Telemetry ingest endpoint: ${api.telemetryUrl}`);
  log.log?.(`Database: ${api.telemetryStore.path}`);
  log.log?.(`Config source: ${apiConfig.configSource}`);

  onShutdown(async (signal, force) => {
    if (!force) {
      await api.drain({ delayMs: Number(process.env.BRAINSTEM_DRAIN_DELAY_MS ?? 0) }).catch(() => {});
    }
    await api.close().catch(() => {});
    await tracer.shutdown().catch(() => {});
    await database.close().catch(() => {});
    process.exit(0);
  });

  return api;
}

export async function runCoreProcess({
  role,
  configPath,
  queues: queuesFlag = null,
  configSource: configSourceFlag = null,
  healthHost = null,
  healthPort = null,
  once = false,
  printAll = false,
  logLevel = null,
  logFormat = null,
  decideConcurrency = null,
  drainTimeoutMs = null
}) {
  const fileConfig = await loadConfigFile(configPath);
  const configSource = resolveConfigSource({ flag: configSourceFlag, config: fileConfig ?? {} });

  if (!fileConfig && configSource === "file") {
    console.error(
      `Config file not found: ${configPath}\n\nCreate one with:\n  cp brainstem.config.example.mjs brainstem.config.mjs\n\nOr pass a config explicitly:\n  node brainstem.mjs --config ./my.config.mjs\n\nOr run from the database: BRAINSTEM_CONFIG_SOURCE=database (after brainstem config import)`
    );
    return 1;
  }

  const bootstrap = fileConfig ?? {};
  const logger = createRuntimeLogger({
    ...(bootstrap.runtime?.logging ?? {}),
    ...(logLevel ? { level: logLevel } : {}),
    ...(logFormat ? { format: logFormat } : {})
  });

  const queues = normalizeCoreQueues(
    queuesFlag ?? process.env.BRAINSTEM_QUEUES ?? bootstrap.runtime?.queues ?? (role === "all" ? "all" : null)
  );

  configureMetrics({ role });
  const tracer = configureTracing({
    role,
    instanceId: bootstrap.runtime?.coreId ?? process.env.BRAINSTEM_CORE_ID ?? null,
    logger
  });

  /*
   * One database handle for the runtime and the embedded backend
   * API.
   */
  let database;

  try {
    database = await openRuntimeDatabase(bootstrap, { logger, migrate: shouldMigrate(role) });
  }
  catch (error) {
    logger.error("database unavailable", { error });
    return 1;
  }

  const configVersions = configSource === "database"
    ? createConfigVersionStore({ database })
    : null;

  const controller = new AbortController();
  let runtime = null;
  let health = null;
  let watcher = null;
  let backendApi = null;
  let stopping = false;

  onShutdown(async (signal, force) => {
    if (stopping && !force) return;

    logger.info("shutdown signal received", { signal, drain: !force && !once });

    if (!stopping && !once && runtime) {
      stopping = true;
      await backendApi?.drain?.({ delayMs: 0 }).catch(() => {});
      await runtime.drain({ timeoutMs: drainTimeoutMs ?? undefined }).catch(error => {
        logger.warn("drain failed", { error });
      });
    }

    stopping = true;
    controller.abort();
  });

  try {
    // The pipeline config: the file, or the active stored version.
    let configVersion = null;
    let config = bootstrap;

    if (configVersions) {
      const active = await waitForActiveConfig(configVersions, database, logger, controller.signal);
      if (!active) return 0;
      configVersion = active.id;
      config = mergeBootstrap(bootstrap, active.spec);
    }

    config = applyProcessOptions(config, { decideConcurrency });

    const apiConfig = normalizeBackendApiConfig(
      { ...(bootstrap.runtime?.api ?? {}), configPath, configSource },
      { repoRoot: process.cwd() }
    );

    if (role === "all" && apiConfig.enabled) {
      backendApi = createBackendApiServer({ ...apiConfig, database });
      await backendApi.listen();
      config = withTelemetryToApi(config, backendApi, apiConfig);
    }

    const pipeline = pipelineFor(config, { printAll });

    if (
      configSource === "file" &&
      queues.includes("poll") &&
      pipeline.inputs.length === 0
    ) {
      logger.error("no input plugins configured");
      return 1;
    }

    runtime = new BrainstemRuntime({
      config,
      plugins: pipeline.inputs,
      destinations: pipeline.destinations,
      logger,
      database,
      role,
      queues,
      configVersion
    });

    const port = healthPort ?? process.env.BRAINSTEM_HEALTH_PORT ?? (role === "core" ? DEFAULT_CORE_HEALTH_PORT : null);

    if (port !== null && port !== undefined && port !== "" && !once) {
      health = createHealthServer({
        host: healthHost ?? process.env.BRAINSTEM_HEALTH_HOST ?? "0.0.0.0",
        port: Number(port),
        runtime,
        logger,
        // role all is the whole cluster; core leaves the shared
        // gauges to the API so they are not reported N times.
        clusterDatabase: role === "all" && !backendApi ? database : null
      });
      await health.listen();
    }

    if (once) {
      logger.info("polling inputs once", { inputs: pipeline.inputs.length });
      await runtime.runOnce({ signal: controller.signal });
      return 0;
    }

    logger.info("starting brainstem", { role, queues, configSource, configVersion, inputs: pipeline.inputs.length });
    await runtime.start({ signal: controller.signal });

    // Hot reload: every core follows the active version.
    if (configVersions) {
      watcher = watchActiveConfig({
        store: configVersions,
        notifier: database.notifier,
        currentId: configVersion,
        logger,
        intervalMs: Number(process.env.BRAINSTEM_CONFIG_CHECK_MS ?? 30_000),
        onChange: async version => {
          let next = applyProcessOptions(mergeBootstrap(bootstrap, version.spec), { decideConcurrency });
          if (backendApi) next = withTelemetryToApi(next, backendApi, apiConfig);
          const reloaded = pipelineFor(next, { printAll });

          await runtime.reconfigure({
            config: next,
            plugins: reloaded.inputs,
            destinations: reloaded.destinations,
            configVersion: version.id
          });
        }
      });
    }

    await runtime.wait();
    return 0;
  }
  catch (error) {
    logger.error("brainstem failed", { error });
    return 1;
  }
  finally {
    await watcher?.stop();
    await runtime?.close();
    await health?.close();
    await backendApi?.close();
    await tracer.shutdown().catch(() => {});
    await database.close();
  }
}

async function waitForActiveConfig(store, database, logger, signal) {
  let active = await store.active();
  if (active) return active;

  logger.warn("no active config version yet; waiting (store one with: brainstem config import)");

  await new Promise(resolve => {
    const unlisten = database.notifier?.listen("config", check);
    const timer = setInterval(check, 5_000);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });

    async function check() {
      active = await store.active().catch(() => null);
      if (active) done();
    }

    function done() {
      unlisten?.();
      clearInterval(timer);
      resolve();
    }
  });

  return active;
}

/*
 * --decide-concurrency N: N decide jobs at once, each with its own
 * Laya worker.
 */
function applyProcessOptions(config, { decideConcurrency }) {
  if (!decideConcurrency) return config;

  const n = Math.max(1, Math.floor(Number(decideConcurrency)));
  const runtime = config.runtime ?? {};

  return {
    ...config,
    runtime: {
      ...runtime,
      queue: { ...(runtime.queue ?? {}), decide: { ...(runtime.queue?.decide ?? {}), concurrency: n } },
      laya: { ...(runtime.laya ?? {}), workers: n }
    }
  };
}

function withTelemetryToApi(config, backendApi, apiConfig) {
  const telemetry = config.runtime?.telemetry;
  const configured = typeof telemetry === "string"
    ? telemetry.length > 0
    : Boolean(telemetry?.url);

  if (configured) return config;

  return {
    ...config,
    runtime: {
      ...(config.runtime ?? {}),
      telemetry: {
        ...(telemetry && typeof telemetry === "object" ? telemetry : {}),
        url: backendApi.telemetryUrl,
        ...(apiConfig.token ? { headers: { authorization: `Bearer ${apiConfig.token}` } } : {})
      }
    }
  };
}

function pipelineFor(config, { printAll }) {
  return {
    inputs: config.inputs ?? [],
    destinations: (config.destinations ?? []).map(entry =>
      printAll && entry.module === "./plugins/log-decisions/index.mjs"
        ? { ...entry, decisions: "all" }
        : entry
    )
  };
}
