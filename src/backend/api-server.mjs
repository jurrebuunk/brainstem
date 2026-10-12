import http from "node:http";
import { resolve } from "node:path";

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
import { createSseHub } from "./sse.mjs";
import { createTelemetryStore } from "./telemetry-store.mjs";

export function createBackendApiServer({
  host = process.env.BRAINSTEM_API_HOST ?? process.env.HOST ?? "127.0.0.1",
  port = Number(process.env.BRAINSTEM_API_PORT ?? process.env.PORT ?? 5174),
  repoRoot = process.cwd(),
  configPath = resolve(repoRoot, process.env.BRAINSTEM_CONFIG ?? "brainstem.config.mjs"),
  telemetryDbPath = resolve(repoRoot, process.env.BRAINSTEM_API_DB ?? process.env.WEB_STATS_DB ?? "data/web-stats.sqlite"),
  maxEvents = positiveInteger(process.env.MAX_EVENTS, 2000),
  maxBodyBytes = positiveInteger(process.env.MAX_BODY_BYTES, 1024 * 1024),
  statsPruneAfterDays = finiteNumber(process.env.STATS_PRUNE_AFTER_DAYS, 14),
  eventLogPruneAfterDays = finiteNumber(
    process.env.WEB_EVENTS_PRUNE_AFTER_DAYS ?? process.env.STATS_PRUNE_AFTER_DAYS,
    14
  ),
  eventLogMaxRows = nonNegativeInteger(process.env.WEB_EVENTS_MAX_ROWS, 50_000),
  token = process.env.BRAINSTEM_API_TOKEN,
  allowConfigWrites = true
} = {}) {
  const telemetryStore = createTelemetryStore({
    path: telemetryDbPath,
    statsPruneAfterDays,
    eventLogPruneAfterDays,
    eventLogMaxRows
  });
  const configStore = createConfigStore(configPath);
  const sse = createSseHub();
  const events = [];

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${host}:${port}`);

      if (request.method === "OPTIONS") {
        sendNoContent(response, 204);
        return;
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        sendJson(response, {
          ok: true,
          role: "brainstem-backend",
          events: events.length,
          persistedEvents: telemetryStore.eventCount(),
          statsDb: telemetryStore.path
        });
        return;
      }

      authorize(request, token);

      if (url.pathname === "/api/events" && request.method === "POST") {
        addEvent(normalizeIncomingEvent(
          await readJsonBody(request, null, { maxBodyBytes })
        ));
        response.writeHead(204);
        response.end();
        return;
      }

      if (url.pathname === "/api/events" && request.method === "GET") {
        sendJson(response, telemetryStore.getEvents({
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
        sse.stream(response);
        return;
      }

      if (url.pathname === "/api/stats" && request.method === "GET") {
        sendJson(response, telemetryStore.getStats());
        return;
      }

      if (url.pathname === "/api/config" && request.method === "GET") {
        sendJson(response, await configStore.read());
        return;
      }

      if (url.pathname === "/api/config" && request.method === "PUT") {
        if (!allowConfigWrites) {
          sendJson(response, { error: "Config writes are disabled" }, 403);
          return;
        }
        const body = await readJsonBody(request, {}, { maxBodyBytes });
        sendJson(response, await configStore.save(String(body.content ?? "")));
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

  function addEvent(event) {
    events.push(event);

    try {
      telemetryStore.persistEvent(event);
    }
    catch (error) {
      console.error("failed to persist backend telemetry", error);
    }

    while (events.length > maxEvents) {
      events.shift();
    }

    sse.broadcast(event);
  }

  const api = {
    host,
    port,
    url: `http://${host}:${port}`,
    telemetryUrl: `http://${host}:${port}/api/events`,
    server,
    telemetryStore,

    listen() {
      return new Promise(resolveListen => {
        server.listen(port, host, () => {
          const address = server.address();
          if (address && typeof address === "object") {
            api.port = address.port;
            api.url = `http://${host}:${address.port}`;
            api.telemetryUrl = `${api.url}/api/events`;
          }
          resolveListen(api);
        });
      });
    },

    close() {
      return new Promise(resolveClose => {
        server.close(() => {
          telemetryStore.close();
          resolveClose();
        });
      });
    }
  };

  return api;
}

export function normalizeBackendApiConfig(config = {}, { repoRoot = process.cwd() } = {}) {
  const envEnabled = process.env.BRAINSTEM_API;
  const enabled = config.enabled ?? (
    envEnabled === "1" || envEnabled === "true"
  );

  const token = config.token ?? (
    config.tokenEnv ? process.env[config.tokenEnv] : process.env.BRAINSTEM_API_TOKEN
  );

  return {
    enabled,
    host: config.host ?? process.env.BRAINSTEM_API_HOST ?? "127.0.0.1",
    port: Number(config.port ?? process.env.BRAINSTEM_API_PORT ?? 5174),
    repoRoot,
    configPath: resolve(repoRoot, config.configPath ?? process.env.BRAINSTEM_CONFIG ?? "brainstem.config.mjs"),
    telemetryDbPath: resolve(repoRoot, config.telemetryDbPath ?? config.dbPath ?? process.env.BRAINSTEM_API_DB ?? process.env.WEB_STATS_DB ?? "data/web-stats.sqlite"),
    token,
    allowConfigWrites: config.allowConfigWrites ?? true
  };
}

function normalizeIncomingEvent(value) {
  const receivedAt = new Date().toISOString();

  if (
    value &&
    typeof value === "object" &&
    value.version === "1" &&
    typeof value.kind === "string"
  ) {
    return { ...value, receivedAt };
  }

  return {
    receivedAt,
    version: "1",
    kind: "external.json",
    payload: value
  };
}

function authorize(request, token) {
  if (!token) return;

  const header = request.headers.authorization ?? "";
  if (header === `Bearer ${token}`) return;

  const error = new Error("Unauthorized");
  error.statusCode = 401;
  throw error;
}
