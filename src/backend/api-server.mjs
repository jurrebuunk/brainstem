import http from "node:http";
import { resolve } from "node:path";

import { createAuthStore } from "./auth-store.mjs";
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
import { PERMISSIONS } from "./permissions.mjs";
import { createSseHub } from "./sse.mjs";
import { createTelemetryStore } from "./telemetry-store.mjs";

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
  cookieSecure = process.env.BRAINSTEM_COOKIE_SECURE === "true"
} = {}) {
  const telemetryStore = createTelemetryStore({
    path: telemetryDbPath,
    statsPruneAfterDays,
    eventLogPruneAfterDays,
    eventLogMaxRows
  });
  const authStore = createAuthStore({ path: telemetryDbPath });
  const configStore = createConfigStore(configPath);
  const sse = createSseHub();
  const events = [];
  const loginAttempts = new Map();

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
          setupRequired: authStore.setupRequired(),
          events: events.length,
          persistedEvents: telemetryStore.eventCount(),
          statsDb: telemetryStore.path
        });
        return;
      }

      if (url.pathname === "/api/auth/status" && request.method === "GET") {
        sendJson(response, {
          setupRequired: authStore.setupRequired(),
          authenticated: Boolean(currentSession(request)),
          permissions: PERMISSIONS
        });
        return;
      }

      if (url.pathname === "/api/auth/setup" && request.method === "POST") {
        rateLimitLogin(request, loginAttempts);
        const body = await readJsonBody(request, {}, { maxBodyBytes });
        const user = await authStore.createInitialAdmin(body);
        const session = authStore.createSession(user.id);
        setSessionCookies(response, session, { secure: cookieSecure });
        sendJson(response, { user, csrfToken: session.csrfToken });
        return;
      }

      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        rateLimitLogin(request, loginAttempts);
        const body = await readJsonBody(request, {}, { maxBodyBytes });
        const user = await authStore.verifyLogin(body);
        if (!user) {
          throw httpError(401, "Invalid username or password");
        }
        resetLoginAttempts(request, loginAttempts);
        const session = authStore.createSession(user.id);
        setSessionCookies(response, session, { secure: cookieSecure });
        sendJson(response, { user, csrfToken: session.csrfToken });
        return;
      }

      if (url.pathname === "/api/events" && request.method === "POST" && machineAuthorized(request, token)) {
        addEvent(normalizeIncomingEvent(
          await readJsonBody(request, null, { maxBodyBytes })
        ));
        response.writeHead(204);
        response.end();
        return;
      }

      const session = requireAuth(request);
      requireCsrf(request, session);

      if (url.pathname === "/api/auth/me" && request.method === "GET") {
        sendJson(response, { user: session.user, csrfToken: session.csrfToken });
        return;
      }

      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        authStore.revokeSession(session.token);
        clearSessionCookies(response, { secure: cookieSecure });
        sendJson(response, { ok: true });
        return;
      }

      if (url.pathname === "/api/events" && request.method === "POST") {
        requirePermission(session.user, "events:read");
        addEvent(normalizeIncomingEvent(
          await readJsonBody(request, null, { maxBodyBytes })
        ));
        response.writeHead(204);
        response.end();
        return;
      }

      if (url.pathname === "/api/events" && request.method === "GET") {
        requirePermission(session.user, "events:read");
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
        requirePermission(session.user, "events:read");
        sse.stream(response);
        return;
      }

      if (url.pathname === "/api/stats" && request.method === "GET") {
        requirePermission(session.user, "stats:read");
        sendJson(response, telemetryStore.getStats());
        return;
      }

      if (url.pathname === "/api/config" && request.method === "GET") {
        requirePermission(session.user, "config:read");
        sendJson(response, await configStore.read());
        return;
      }

      if (url.pathname === "/api/config" && request.method === "PUT") {
        requirePermission(session.user, "config:write");
        if (!allowConfigWrites) {
          sendJson(response, { error: "Config writes are disabled" }, 403);
          return;
        }
        const body = await readJsonBody(request, {}, { maxBodyBytes });
        sendJson(response, await configStore.save(String(body.content ?? "")));
        return;
      }

      if (url.pathname === "/api/users" && request.method === "GET") {
        requirePermission(session.user, "users:read");
        sendJson(response, authStore.listUsers());
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
        authStore.deleteUser(userMatch[1]);
        sendJson(response, { ok: true });
        return;
      }

      if (url.pathname === "/api/roles" && request.method === "GET") {
        requirePermission(session.user, "roles:read");
        sendJson(response, { roles: authStore.listRoles(), permissions: authStore.permissions() });
        return;
      }

      if (url.pathname === "/api/roles" && request.method === "POST") {
        requirePermission(session.user, "roles:manage");
        const body = await readJsonBody(request, {}, { maxBodyBytes });
        sendJson(response, authStore.createRole(body), 201);
        return;
      }

      const roleMatch = url.pathname.match(/^\/api\/roles\/([^/]+)$/);
      if (roleMatch && request.method === "PUT") {
        requirePermission(session.user, "roles:manage");
        const body = await readJsonBody(request, {}, { maxBodyBytes });
        sendJson(response, authStore.updateRole(roleMatch[1], body));
        return;
      }
      if (roleMatch && request.method === "DELETE") {
        requirePermission(session.user, "roles:manage");
        authStore.deleteRole(roleMatch[1]);
        sendJson(response, { ok: true });
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
    while (events.length > maxEvents) events.shift();
    sse.broadcast(event);
  }

  function currentSession(request) {
    return authStore.getSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
  }

  function requireAuth(request) {
    const session = currentSession(request);
    if (!session) throw httpError(401, "Unauthorized");
    return session;
  }

  const api = {
    host,
    port,
    url: `http://${host}:${port}`,
    telemetryUrl: `http://${host}:${port}/api/events`,
    server,
    telemetryStore,
    authStore,

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
          authStore.close();
          resolveClose();
        });
      });
    }
  };

  return api;
}

export function normalizeBackendApiConfig(config = {}, { repoRoot = process.cwd() } = {}) {
  const envEnabled = process.env.BRAINSTEM_API;
  const enabled = config.enabled ?? (envEnabled === "1" || envEnabled === "true");
  const token = config.token ?? (config.tokenEnv ? process.env[config.tokenEnv] : process.env.BRAINSTEM_API_TOKEN);

  return {
    enabled,
    host: config.host ?? process.env.BRAINSTEM_API_HOST ?? "127.0.0.1",
    port: Number(config.port ?? process.env.BRAINSTEM_API_PORT ?? 5174),
    repoRoot,
    configPath: resolve(repoRoot, config.configPath ?? process.env.BRAINSTEM_CONFIG ?? "brainstem.config.mjs"),
    telemetryDbPath: resolve(repoRoot, config.telemetryDbPath ?? config.dbPath ?? process.env.BRAINSTEM_API_DB ?? process.env.WEB_STATS_DB ?? "data/web-stats.sqlite"),
    token,
    allowConfigWrites: config.allowConfigWrites ?? true,
    cookieSecure: config.cookieSecure ?? (process.env.BRAINSTEM_COOKIE_SECURE === "true")
  };
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

function rateLimitLogin(request, attempts) {
  const key = request.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const entry = attempts.get(key) ?? { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (entry.resetAt <= now) {
    entry.count = 0;
    entry.resetAt = now + LOGIN_WINDOW_MS;
  }
  entry.count += 1;
  attempts.set(key, entry);
  if (entry.count > LOGIN_MAX_ATTEMPTS) throw httpError(429, "Too many login attempts");
}

function resetLoginAttempts(request, attempts) {
  attempts.delete(request.socket.remoteAddress ?? "unknown");
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
