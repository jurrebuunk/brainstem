import http from "node:http";
import { resolve } from "node:path";

import { openMigratedDatabase } from "../db/index.mjs";
import { createAuthStore } from "./auth-store.mjs";
import { clientIp, createTrustedProxies, DEFAULT_TRUSTED_PROXIES } from "./client-ip.mjs";
import { createConfigStore } from "./config-store.mjs";
import {
  clampLimit,
  finiteNumber,
  nonNegativeInteger,
  positiveInteger,
  readJsonBody,
  sendJson,
  sendNoContent
} from "./http-utils.mjs";
import { createMaintenanceScheduler, DEFAULT_MAINTENANCE_INTERVAL_MS } from "./maintenance.mjs";
import { DELIVERY_STATUSES, JOB_STATES, createPipelineAdmin, createPipelineStorage } from "../queue/index.mjs";
import { PERMISSIONS } from "./permissions.mjs";
import { createSseHub } from "./sse.mjs";
import { createTelemetryStore } from "./telemetry-store.mjs";
import { createCoreRegistry, topologyFromCores } from "../runtime/cores.mjs";
import { createInputLeaseStore } from "../runtime/input-leases.mjs";
import { withSingletonLock } from "../db/locks.mjs";
import { CONFIG_SCHEMA } from "../config/schema.mjs";
import { createConfigVersionStore } from "../config/versions.mjs";
import { resolveConfigSource } from "../config/source.mjs";

// Cores not seen for this long are removed from the registry.
const CORE_PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
// Inputs no core declared for this long are removed from the schedule.
const INPUT_PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const SESSION_COOKIE = "brainstem_session";
const CSRF_COOKIE = "brainstem_csrf";

export function createBackendApiServer({
  host = process.env.BRAINSTEM_API_HOST ?? process.env.HOST ?? "127.0.0.1",
  port = Number(process.env.BRAINSTEM_API_PORT ?? process.env.PORT ?? 5174),
  repoRoot = process.cwd(),
  configPath = resolve(repoRoot, process.env.BRAINSTEM_CONFIG ?? "brainstem.config.mjs"),
  telemetryDbPath = resolve(repoRoot, process.env.BRAINSTEM_API_DB ?? process.env.WEB_STATS_DB ?? "data/web-stats.sqlite"),
  // An open { db, dialect, close } handle from src/db (not closed by
  // api.close()), or a URL the API opens, migrates and closes itself.
  database = null,
  databaseUrl = null,
  maxEvents = positiveInteger(process.env.MAX_EVENTS, 2000),
  maxBodyBytes = positiveInteger(process.env.MAX_BODY_BYTES, 1024 * 1024),
  statsPruneAfterDays = finiteNumber(process.env.STATS_PRUNE_AFTER_DAYS, 14),
  eventLogPruneAfterDays = finiteNumber(
    process.env.WEB_EVENTS_PRUNE_AFTER_DAYS ?? process.env.STATS_PRUNE_AFTER_DAYS,
    14
  ),
  eventLogMaxRows = nonNegativeInteger(process.env.WEB_EVENTS_MAX_ROWS, 50_000),
  token = process.env.BRAINSTEM_API_TOKEN,
  allowConfigWrites = true,
  // "file": the config file, read-only. "database": versioned config.
  configSource = resolveConfigSource(),
  cookieSecure = process.env.BRAINSTEM_COOKIE_SECURE === "true",
  trustedProxies = process.env.BRAINSTEM_TRUSTED_PROXIES ?? DEFAULT_TRUSTED_PROXIES,
  maintenanceIntervalMs = nonNegativeInteger(
    process.env.BRAINSTEM_MAINTENANCE_INTERVAL_MS,
    DEFAULT_MAINTENANCE_INTERVAL_MS
  )
} = {}) {
  const configStore = createConfigStore(configPath);
  const proxies = createTrustedProxies(trustedProxies);
  let sse = null;
  const events = [];
  let handle = null;
  let ownsHandle = false;
  let telemetryStore = null;
  let authStore = null;
  let maintenance = null;
  let pipeline = null;
  let pipelineAdmin = null;
  let coreRegistry = null;
  let inputLeases = null;
  let configVersions = null;
  let started = null;
  let draining = false;

  async function start() {
    if (database) {
      handle = database;
    }
    else {
      handle = await openMigratedDatabase({ url: databaseUrl ?? `sqlite:${telemetryDbPath}` });
      ownsHandle = true;
    }

    try {
      telemetryStore = createTelemetryStore({
        database: handle,
        statsPruneAfterDays,
        eventLogPruneAfterDays,
        eventLogMaxRows
      });
      authStore = await createAuthStore({ database: handle });
    }
    catch (error) {
      if (ownsHandle) await handle.close();
      throw error;
    }

    maintenance = createMaintenanceScheduler({
      db: handle.db,
      intervalMs: maintenanceIntervalMs,
      lock: fn => withSingletonLock(handle, "api.maintenance", fn),
      tasks: {
        "telemetry.prune": ({ now }) => telemetryStore.prune({ now }),
        "auth.prune": async ({ now }) => ({
          sessions: await authStore.pruneExpiredSessions({ now }),
          loginAttempts: await authStore.pruneLoginAttempts({ now, windowMs: LOGIN_WINDOW_MS })
        }),
        "cores.prune": async ({ now }) => ({
          cores: await coreRegistry.prune({ olderThanMs: CORE_PRUNE_AFTER_MS, now: new Date(now).getTime() })
        }),
        "inputs.prune": async ({ now }) => ({
          inputs: await inputLeases.prune({ olderThanMs: INPUT_PRUNE_AFTER_MS, at: new Date(now).getTime() })
        })
      }
    });
    coreRegistry = createCoreRegistry({ database: async () => handle });
    inputLeases = createInputLeaseStore({ database: async () => handle });
    configVersions = createConfigVersionStore({ database: async () => handle });
    // Streams telemetry from every replica (LISTEN/NOTIFY on Postgres).
    sse = createSseHub({ store: telemetryStore, notifier: handle.notifier });
    // The runtime's job queue and delivery log, in the same database.
    pipeline = createPipelineStorage({ type: "database", database: handle });
    pipelineAdmin = createPipelineAdmin(pipeline);

    api.telemetryStore = telemetryStore;
    api.authStore = authStore;
    api.database = handle;
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${host}:${port}`);

      if (request.method === "OPTIONS") {
        sendNoContent(response, 204);
        return;
      }

      /*
       * Probes (roadmap §5): liveness never touches the database;
       * readiness needs it and fails while draining; startup waits
       * for the schema and stores.
       */
      if (url.pathname === "/livez" && request.method === "GET") {
        sendJson(response, { ok: true, role: "api" });
        return;
      }

      if (url.pathname === "/readyz" && request.method === "GET") {
        const ready = !draining && await databaseReachable(handle);
        sendJson(response, { ok: ready, role: "api", draining }, ready ? 200 : 503);
        return;
      }

      if (url.pathname === "/startupz" && request.method === "GET") {
        const startedOk = Boolean(telemetryStore && authStore);
        sendJson(response, { ok: startedOk, role: "api" }, startedOk ? 200 : 503);
        return;
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        sendJson(response, {
          ok: true,
          role: "brainstem-backend",
          setupRequired: await authStore.setupRequired(),
          events: events.length,
          persistedEvents: await telemetryStore.eventCount(),
          statsDb: telemetryStore.path
        });
        return;
      }

      if (url.pathname === "/api/auth/status" && request.method === "GET") {
        sendJson(response, {
          setupRequired: await authStore.setupRequired(),
          authenticated: Boolean(await currentSession(request)),
          permissions: PERMISSIONS
        });
        return;
      }

      if (url.pathname === "/api/auth/setup" && request.method === "POST") {
        await rateLimitLogin(request);
        const body = await readJsonBody(request, {}, { maxBodyBytes });
        const user = await authStore.createInitialAdmin(body);
        const session = await authStore.createSession(user.id);
        setSessionCookies(response, session, { secure: cookieSecure });
        sendJson(response, { user, csrfToken: session.csrfToken });
        return;
      }

      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        await rateLimitLogin(request);
        const body = await readJsonBody(request, {}, { maxBodyBytes });
        const user = await authStore.verifyLogin(body);
        if (!user) {
          throw httpError(401, "Invalid username or password");
        }
        await authStore.resetLoginAttempts(loginKey(request));
        const session = await authStore.createSession(user.id);
        setSessionCookies(response, session, { secure: cookieSecure });
        sendJson(response, { user, csrfToken: session.csrfToken });
        return;
      }

      if (url.pathname === "/api/events" && request.method === "POST" && machineAuthorized(request, token)) {
        await addEvent(normalizeIncomingEvent(
          await readJsonBody(request, null, { maxBodyBytes })
        ));
        response.writeHead(204);
        response.end();
        return;
      }

      const session = await requireAuth(request);
      requireCsrf(request, session);

      if (url.pathname === "/api/auth/me" && request.method === "GET") {
        sendJson(response, { user: session.user, csrfToken: session.csrfToken });
        return;
      }

      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        await authStore.revokeSession(session.token);
        clearSessionCookies(response, { secure: cookieSecure });
        sendJson(response, { ok: true });
        return;
      }

      if (url.pathname === "/api/events" && request.method === "POST") {
        requirePermission(session.user, "events:read");
        await addEvent(normalizeIncomingEvent(
          await readJsonBody(request, null, { maxBodyBytes })
        ));
        response.writeHead(204);
        response.end();
        return;
      }

      if (url.pathname === "/api/events" && request.method === "GET") {
        requirePermission(session.user, "events:read");
        sendJson(response, await telemetryStore.getEvents({
          limit: clampLimit(url.searchParams.get("limit"), maxEvents),
          before: url.searchParams.get("before"),
          after: url.searchParams.get("after"),
          kind: url.searchParams.get("kind"),
          level: url.searchParams.get("level"),
          source: url.searchParams.get("source")
        }));
        return;
      }

      if (url.pathname === "/api/stream" && request.method === "GET") {
        requirePermission(session.user, "events:read");
        await sse.stream(request, response);
        return;
      }

      if (url.pathname === "/api/stats" && request.method === "GET") {
        requirePermission(session.user, "stats:read");
        sendJson(response, await telemetryStore.getStats());
        return;
      }

      /*
       * Config (ADR-0005). With configSource "file" the file is shown
       * read-only. With "database" every save is a new validated
       * version; If-Match (the active version id, as returned in
       * ETag) prevents overwriting someone else's change.
       */
      if (url.pathname === "/api/config" && request.method === "GET") {
        requirePermission(session.user, "config:read");

        if (configSource === "file") {
          sendJson(response, {
            source: "file",
            format: "mjs",
            readOnly: true,
            ...(await configStore.read())
          });
          return;
        }

        const active = await configVersions.active();
        if (active) response.setHeader("etag", `"${active.id}"`);
        sendJson(response, {
          source: "database",
          format: "json",
          readOnly: !allowConfigWrites,
          version: active ? versionSummary(active) : null,
          content: active ? JSON.stringify(active.spec, null, 2) : ""
        });
        return;
      }

      if (url.pathname === "/api/config" && request.method === "PUT") {
        requirePermission(session.user, "config:write");
        requireDatabaseConfig(configSource, allowConfigWrites);
        const body = await readJsonBody(request, {}, { maxBodyBytes });
        const expectedActiveId = expectedVersion(request, body);
        const spec = body.spec ?? parseConfigContent(body.content);
        const version = await configVersions.create(spec, {
          author: session.user.username,
          comment: typeof body.comment === "string" ? body.comment.slice(0, 500) : null,
          expectedActiveId
        });
        response.setHeader("etag", `"${version.id}"`);
        sendJson(response, { ok: true, unchanged: version.unchanged, version: versionSummary(version) });
        return;
      }

      if (url.pathname === "/api/config/schema" && request.method === "GET") {
        requirePermission(session.user, "config:read");
        sendJson(response, CONFIG_SCHEMA);
        return;
      }

      if (url.pathname === "/api/config/versions" && request.method === "GET") {
        requirePermission(session.user, "config:read");
        sendJson(response, configSource === "database"
          ? await configVersions.list({ limit: Math.min(clampLimit(url.searchParams.get("limit"), 50), 500) })
          : []);
        return;
      }

      const versionMatch = url.pathname.match(/^\/api\/config\/versions\/(\d+)(\/activate)?$/);
      if (versionMatch && !versionMatch[2] && request.method === "GET") {
        requirePermission(session.user, "config:read");
        const version = await configVersions.get(versionMatch[1]);
        if (!version) throw httpError(404, `Config version ${versionMatch[1]} does not exist`);
        sendJson(response, version);
        return;
      }

      // Activate an existing version (rollback).
      if (versionMatch && versionMatch[2] && request.method === "POST") {
        requirePermission(session.user, "config:write");
        requireDatabaseConfig(configSource, allowConfigWrites);
        const body = await readJsonBody(request, {}, { maxBodyBytes });
        const active = await configVersions.activate(versionMatch[1], {
          author: session.user.username,
          expectedActiveId: expectedVersion(request, body, { required: false })
        });
        response.setHeader("etag", `"${active.id}"`);
        sendJson(response, { ok: true, version: versionSummary(active) });
        return;
      }

      if (url.pathname === "/api/users" && request.method === "GET") {
        requirePermission(session.user, "users:read");
        sendJson(response, await authStore.listUsers());
        return;
      }

      if (url.pathname === "/api/users" && request.method === "POST") {
        requirePermission(session.user, "users:create");
        const body = await readJsonBody(request, {}, { maxBodyBytes });
        sendJson(response, await authStore.createUser(body), 201);
        return;
      }

      const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
      if (userMatch && request.method === "PUT") {
        requirePermission(session.user, "users:update");
        const body = await readJsonBody(request, {}, { maxBodyBytes });
        sendJson(response, await authStore.updateUser(userMatch[1], body));
        return;
      }
      if (userMatch && request.method === "DELETE") {
        requirePermission(session.user, "users:delete");
        await authStore.deleteUser(userMatch[1]);
        sendJson(response, { ok: true });
        return;
      }

      if (url.pathname === "/api/roles" && request.method === "GET") {
        requirePermission(session.user, "roles:read");
        sendJson(response, { roles: await authStore.listRoles(), permissions: authStore.permissions() });
        return;
      }

      if (url.pathname === "/api/roles" && request.method === "POST") {
        requirePermission(session.user, "roles:manage");
        const body = await readJsonBody(request, {}, { maxBodyBytes });
        sendJson(response, await authStore.createRole(body), 201);
        return;
      }

      const roleMatch = url.pathname.match(/^\/api\/roles\/([^/]+)$/);
      if (roleMatch && request.method === "PUT") {
        requirePermission(session.user, "roles:manage");
        const body = await readJsonBody(request, {}, { maxBodyBytes });
        sendJson(response, await authStore.updateRole(roleMatch[1], body));
        return;
      }
      if (roleMatch && request.method === "DELETE") {
        requirePermission(session.user, "roles:manage");
        await authStore.deleteRole(roleMatch[1]);
        sendJson(response, { ok: true });
        return;
      }

      /*
       * Structure for the Web UI: the registered cores (running,
       * lost or stopped) and the inputs/destinations they loaded.
       * Independent of which core sent the latest telemetry.
       */
      if (url.pathname === "/api/topology" && request.method === "GET") {
        requirePermission(session.user, "runtime:read");
        const cores = await coreRegistry.list();
        sendJson(response, {
          generatedAt: new Date().toISOString(),
          cores: cores.map(({ topology, ...core }) => core),
          ...topologyFromCores(cores)
        });
        return;
      }

      // Input schedule and leases: which core polls what, and when next.
      if (url.pathname === "/api/inputs" && request.method === "GET") {
        requirePermission(session.user, "runtime:read");
        sendJson(response, await inputLeases.list());
        return;
      }

      if (url.pathname === "/api/pipeline" && request.method === "GET") {
        requirePermission(session.user, "runtime:read");
        sendJson(response, await pipelineAdmin.summary());
        return;
      }

      if (url.pathname === "/api/deliveries" && request.method === "GET") {
        requirePermission(session.user, "runtime:read");
        sendJson(response, await pipeline.deliveries.list({
          status: oneOf(url.searchParams.get("status"), DELIVERY_STATUSES, "status"),
          observationId: url.searchParams.get("observationId") || undefined,
          destination: url.searchParams.get("destination") || undefined,
          before: url.searchParams.get("before") || undefined,
          limit: Math.min(clampLimit(url.searchParams.get("limit"), 100), 500)
        }));
        return;
      }

      if (url.pathname === "/api/jobs" && request.method === "GET") {
        requirePermission(session.user, "runtime:read");
        sendJson(response, await pipeline.transport.listJobs({
          state: oneOf(url.searchParams.get("state"), JOB_STATES, "state"),
          queue: url.searchParams.get("queue") || undefined,
          beforeId: url.searchParams.get("beforeId") || undefined,
          limit: Math.min(clampLimit(url.searchParams.get("limit"), 100), 500)
        }));
        return;
      }

      // Redrive or discard dead jobs: { ids: [...] }.
      const jobAction = url.pathname.match(/^\/api\/jobs\/(redrive|discard)$/);
      if (jobAction && request.method === "POST") {
        requirePermission(session.user, "runtime:control");
        const body = await readJsonBody(request, {}, { maxBodyBytes });
        const ids = jobIds(body.ids);
        const jobs = [];

        for (const id of ids) {
          const job = await pipelineAdmin[jobAction[1]](id);
          if (job) jobs.push(job);
        }

        sendJson(response, { [jobAction[1] === "redrive" ? "redriven" : "discarded"]: jobs.map(job => job.id) });
        return;
      }

      sendJson(response, { error: "Not found" }, 404);
    }
    catch (error) {
      const status = error.statusCode ?? 500;
      if (status >= 500) console.error(error);
      sendJson(response, { error: error.message }, status);
    }
  });

  async function addEvent(event) {
    events.push(event);
    let persisted = event;
    try {
      persisted = { ...event, persistedId: await telemetryStore.persistEvent(event) };
    }
    catch (error) {
      console.error("failed to persist backend telemetry", error);
    }
    while (events.length > maxEvents) events.shift();
    sse.publish(persisted);
  }

  async function currentSession(request) {
    return await authStore.getSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
  }

  async function requireAuth(request) {
    const session = await currentSession(request);
    if (!session) throw httpError(401, "Unauthorized");
    return session;
  }

  function loginKey(request) {
    return `ip:${clientIp(request, proxies)}`;
  }

  async function rateLimitLogin(request) {
    const count = await authStore.registerLoginAttempt(loginKey(request), { windowMs: LOGIN_WINDOW_MS });
    if (count > LOGIN_MAX_ATTEMPTS) throw httpError(429, "Too many login attempts");
  }

  const api = {
    host,
    port,
    url: `http://${host}:${port}`,
    telemetryUrl: `http://${host}:${port}/api/events`,
    server,
    // Available once listen() resolves.
    telemetryStore: null,
    authStore: null,
    database: null,

    async listen() {
      started ??= start();
      await started;
      await new Promise(resolveListen => {
        server.listen(port, host, () => {
          const address = server.address();
          if (address && typeof address === "object") {
            api.port = address.port;
            api.url = `http://${host}:${address.port}`;
            api.telemetryUrl = `${api.url}/api/events`;
          }
          resolveListen();
        });
      });
      maintenance.start();
      return api;
    },

    /*
     * Run retention pruning and session/login-attempt cleanup now.
     * Normally driven by the maintenance timer; skips tasks another
     * replica ran recently unless { force: true }.
     */
    async runMaintenance(options) {
      if (!maintenance) throw new Error("Backend API is not started");
      return await maintenance.run(options);
    },

    /*
     * Graceful shutdown (SIGTERM): readiness fails at once so the
     * load balancer stops sending traffic, SSE streams end so
     * clients reconnect elsewhere, then the server closes.
     */
    async drain({ delayMs = 0 } = {}) {
      draining = true;
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      sse?.closeAll();
      await api.close();
    },

    get draining() {
      return draining;
    },

    async close() {
      sse?.close();
      server.closeIdleConnections?.();
      if (server.listening) {
        await new Promise(resolveClose => server.close(() => resolveClose()));
      }
      await started?.catch(() => {});
      await maintenance?.stop();
      await telemetryStore?.close();
      await authStore?.close();
      if (ownsHandle) await handle.close();
    }
  };

  return api;
}

export function normalizeBackendApiConfig(config = {}, { repoRoot = process.cwd() } = {}) {
  const envEnabled = process.env.BRAINSTEM_API;
  const enabled = config.enabled ?? (envEnabled === "1" || envEnabled === "true");
  const token = config.token ?? (config.tokenEnv ? process.env[config.tokenEnv] : process.env.BRAINSTEM_API_TOKEN);
  const telemetryDbPath = resolve(repoRoot, config.telemetryDbPath ?? config.dbPath ?? process.env.BRAINSTEM_API_DB ?? process.env.WEB_STATS_DB ?? "data/web-stats.sqlite");

  return {
    enabled,
    host: config.host ?? process.env.BRAINSTEM_API_HOST ?? "127.0.0.1",
    port: Number(config.port ?? process.env.BRAINSTEM_API_PORT ?? 5174),
    repoRoot,
    configPath: resolve(repoRoot, config.configPath ?? process.env.BRAINSTEM_CONFIG ?? "brainstem.config.mjs"),
    telemetryDbPath,
    databaseUrl: config.databaseUrl ?? process.env.BRAINSTEM_DATABASE_URL ?? `sqlite:${telemetryDbPath}`,
    token,
    allowConfigWrites: config.allowConfigWrites ?? true,
    configSource: resolveConfigSource({ config: { runtime: { configSource: config.configSource } } }),
    cookieSecure: config.cookieSecure ?? (process.env.BRAINSTEM_COOKIE_SECURE === "true"),
    trustedProxies: config.trustedProxies ?? process.env.BRAINSTEM_TRUSTED_PROXIES ?? DEFAULT_TRUSTED_PROXIES,
    maintenanceIntervalMs: nonNegativeInteger(
      config.maintenanceIntervalMs ?? process.env.BRAINSTEM_MAINTENANCE_INTERVAL_MS,
      DEFAULT_MAINTENANCE_INTERVAL_MS
    )
  };
}

function requireDatabaseConfig(configSource, allowConfigWrites) {
  if (configSource !== "database") {
    throw httpError(409, "Config is managed as a file (configSource \"file\"): edit the file and restart, or run `brainstem config import` and set BRAINSTEM_CONFIG_SOURCE=database");
  }
  if (!allowConfigWrites) throw httpError(403, "Config writes are disabled");
}

/*
 * The active version id the client edited: If-Match ("12", 12 or *)
 * or body.expectedVersion. Required for saves so concurrent edits
 * never silently overwrite each other.
 */
function expectedVersion(request, body, { required = true } = {}) {
  const header = request.headers["if-match"];

  if (header !== undefined) {
    const value = String(header).trim().replace(/^W\//, "").replace(/^"|"$/g, "");
    if (value === "*") return undefined;
    if (value === "" || value === "none") return null;
    const id = Number(value);
    if (!Number.isSafeInteger(id)) throw httpError(400, `Invalid If-Match '${header}'`);
    return id;
  }

  if (body && Object.hasOwn(body, "expectedVersion")) {
    if (body.expectedVersion === null) return null;
    const id = Number(body.expectedVersion);
    if (!Number.isSafeInteger(id)) throw httpError(400, "Invalid expectedVersion");
    return id;
  }

  if (required) throw httpError(428, "Send If-Match with the version you edited (or expectedVersion: null for the first version)");
  return undefined;
}

function parseConfigContent(content) {
  if (typeof content !== "string" || content.trim() === "") {
    throw httpError(400, "Expected content: the config as JSON");
  }

  try {
    return JSON.parse(content);
  }
  catch (error) {
    throw httpError(400, `Config is not valid JSON: ${error.message}`);
  }
}

function versionSummary({ spec: _spec, ...version }) {
  return version;
}

async function databaseReachable(handle) {
  if (!handle) return false;

  let timer;
  try {
    await Promise.race([
      handle.db.selectFrom("maintenance_runs").select("task").limit(1).execute(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("database ping timed out")), 2_000);
      })
    ]);
    return true;
  }
  catch {
    return false;
  }
  finally {
    clearTimeout(timer);
  }
}

function normalizeIncomingEvent(value) {
  const receivedAt = new Date().toISOString();
  if (value && typeof value === "object" && value.version === "1" && typeof value.kind === "string") {
    return { ...value, receivedAt };
  }
  return { receivedAt, version: "1", kind: "external.json", payload: value };
}

function machineAuthorized(request, token) {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

function requirePermission(user, permission) {
  if (!user.permissions?.includes(permission)) throw httpError(403, "Forbidden");
}

function requireCsrf(request, session) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
  if (request.url?.startsWith("/api/events") && machineAuthorized(request, process.env.BRAINSTEM_API_TOKEN)) return;
  const header = request.headers["x-csrf-token"];
  if (!header || header !== session.csrfToken) throw httpError(403, "Invalid CSRF token");
}

function setSessionCookies(response, session, { secure }) {
  response.setHeader("set-cookie", [
    cookie(SESSION_COOKIE, session.token, { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAge: maxAgeSeconds(session.expiresAt) }),
    cookie(CSRF_COOKIE, session.csrfToken, { httpOnly: false, secure, sameSite: "Lax", path: "/", maxAge: maxAgeSeconds(session.expiresAt) })
  ]);
}

function clearSessionCookies(response, { secure }) {
  response.setHeader("set-cookie", [
    cookie(SESSION_COOKIE, "", { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAge: 0 }),
    cookie(CSRF_COOKIE, "", { httpOnly: false, secure, sameSite: "Lax", path: "/", maxAge: 0 })
  ]);
}

function cookie(name, value, { httpOnly, secure, sameSite, path, maxAge }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    `Path=${path}`,
    `SameSite=${sameSite}`,
    secure ? "Secure" : null,
    httpOnly ? "HttpOnly" : null
  ].filter(Boolean).join("; ");
}

function maxAgeSeconds(expiresAt) {
  return (Date.parse(expiresAt) - Date.now()) / 1000;
}

function parseCookies(header = "") {
  return Object.fromEntries(
    String(header).split(";").map(part => {
      const index = part.indexOf("=");
      if (index === -1) return null;
      return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
    }).filter(Boolean)
  );
}

function oneOf(value, allowed, name) {
  if (!value) return undefined;
  if (!allowed.includes(value)) throw httpError(400, `Unknown ${name} '${value}'`);
  return value;
}

function jobIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw httpError(400, "Expected ids: a list of 1 to 500 job ids");
  }

  return value.map(id => {
    const number = Number(id);
    if (!Number.isSafeInteger(number) || number <= 0) throw httpError(400, `Invalid job id '${id}'`);
    return number;
  });
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
