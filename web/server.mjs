import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 5173);
const root = new URL(".", import.meta.url).pathname;
const repoRoot = resolve(root, "..");
const isProduction = process.env.NODE_ENV === "production";
const maxEvents = Number(process.env.MAX_EVENTS ?? 2000);
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES ?? 1024 * 1024);
const statsPruneAfterDays = Number(process.env.STATS_PRUNE_AFTER_DAYS ?? 14);
const configPath = resolve(repoRoot, process.env.BRAINSTEM_CONFIG ?? "brainstem.config.mjs");
const statsDbPath = resolve(repoRoot, process.env.WEB_STATS_DB ?? "data/web-stats.sqlite");

mkdirSync(dirname(statsDbPath), { recursive: true });

const statsDb = new DatabaseSync(statsDbPath);
initStatsDb(statsDb);

const events = [];
const clients = new Set();
let vite = null;

if (!isProduction) {
  const { createServer } = await import("vite");

  vite = await createServer({
    root,
    appType: "spa",
    server: {
      middlewareMode: true
    }
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${host}:${port}`);

    if (request.method === "OPTIONS") {
      sendNoContent(response, 204);
      return;
    }

    if (url.pathname === "/api/events" && request.method === "POST") {
      const event = normalizeIncomingEvent(
        await readJsonBody(request, null)
      );

      addEvent(event);
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname === "/api/events" && request.method === "GET") {
      sendJson(response, events);
      return;
    }

    if (url.pathname === "/api/stream" && request.method === "GET") {
      streamEvents(response);
      return;
    }

    if (url.pathname === "/api/stats" && request.method === "GET") {
      sendJson(response, getStats());
      return;
    }

    if (url.pathname === "/api/config" && request.method === "GET") {
      sendJson(response, await readConfig());
      return;
    }

    if (url.pathname === "/api/config" && request.method === "PUT") {
      const body = await readJsonBody(request, {});
      sendJson(response, await saveConfig(String(body.content ?? "")));
      return;
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      sendJson(response, {
        ok: true,
        events: events.length,
        statsDb: statsDbPath
      });
      return;
    }

    if (!isProduction) {
      vite.middlewares(request, response, error => {
        if (error) {
          vite.ssrFixStacktrace(error);
          console.error(error);
          response.writeHead(500);
          response.end(error.stack);
        }
      });
      return;
    }

    await serveStatic(request, response);
  }
  catch (error) {
    const status = error.statusCode ?? 500;
    if (status >= 500) console.error(error);
    sendJson(response, { error: error.message }, status);
  }
});

server.listen(port, host, () => {
  console.log(`Brainstem Web listening on http://${host}:${port}`);
  console.log(`Ingest endpoint: http://${host}:${port}/api/events`);
  console.log(`Stats database: ${statsDbPath}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => {
      statsDb.close();
      process.exit(0);
    });
  });
}

function addEvent(event) {
  events.push(event);

  try {
    recordStatsEvent(event);
  }
  catch (error) {
    console.error("failed to record web stats", error);
  }

  while (events.length > maxEvents) {
    events.shift();
  }

  for (const client of clients) {
    client.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function normalizeIncomingEvent(value) {
  const receivedAt = new Date().toISOString();

  if (
    value &&
    typeof value === "object" &&
    value.version === "1" &&
    typeof value.kind === "string"
  ) {
    return {
      receivedAt,
      ...value
    };
  }

  return {
    receivedAt,
    version: "1",
    kind: "external.json",
    payload: value
  };
}

function streamEvents(response) {
  response.writeHead(200, responseHeaders({
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  }));

  response.write(`data: ${JSON.stringify({
    version: "1",
    kind: "web.connected",
    payload: {
      timestamp: new Date().toISOString()
    }
  })}\n\n`);

  clients.add(response);

  response.on("close", () => {
    clients.delete(response);
  });
}

function initStatsDb(db) {
  db.exec(`
    pragma journal_mode = wal;
    pragma busy_timeout = 5000;

    create table if not exists stat_counters (
      key text primary key,
      value integer not null default 0
    );

    create table if not exists stat_timeseries (
      bucket text not null,
      metric text not null,
      value integer not null default 0,
      primary key (bucket, metric)
    );
  `);
}

function recordStatsEvent(event) {
  const metrics = metricsForEvent(event);

  if (metrics.length === 0) return;

  const bucket = minuteBucket(event.receivedAt ?? event.payload?.timestamp ?? new Date().toISOString());

  const counter = statsDb.prepare(`
    insert into stat_counters (key, value) values (?, ?)
    on conflict(key) do update set value = value + excluded.value
  `);
  const series = statsDb.prepare(`
    insert into stat_timeseries (bucket, metric, value) values (?, ?, ?)
    on conflict(bucket, metric) do update set value = value + excluded.value
  `);

  statsDb.exec("begin");
  try {
    for (const metric of metrics) {
      counter.run(metric, 1);
      series.run(bucket, metric, 1);
    }
    pruneOldStats(bucket);
    statsDb.exec("commit");
  }
  catch (error) {
    statsDb.exec("rollback");
    throw error;
  }
}

function pruneOldStats(currentBucket) {
  if (!Number.isFinite(statsPruneAfterDays) || statsPruneAfterDays <= 0) return;

  const cutoff = new Date(
    Date.parse(currentBucket) - statsPruneAfterDays * 24 * 60 * 60 * 1000
  ).toISOString();

  statsDb.prepare("delete from stat_timeseries where bucket < ?").run(cutoff);
}

function metricsForEvent(event) {
  const kind = event.kind;
  const payload = event.payload ?? {};
  const metrics = new Set(["events.total"]);

  if (kind === "brainstem.input.poll.started") metrics.add("polls.started");
  if (kind === "brainstem.input.poll.completed") metrics.add("polls.completed");
  if (kind === "brainstem.input.observation") metrics.add("observations.emitted");
  if (kind === "brainstem.core.decision") {
    metrics.add("decisions.total");
    metrics.add(`decisions.${payload.decision?.payload?.decision ?? payload.decision ?? "unknown"}`);
  }
  if (kind === "brainstem.output") metrics.add("outputs.total");
  if (kind === "brainstem.destination.running") metrics.add("destinations.running");
  if (kind === "brainstem.destination.completed") metrics.add("destinations.completed");
  if (kind === "brainstem.destination.failed") metrics.add("destinations.failed");
  if (kind === "brainstem.plugin.log" && payload.level === "error") metrics.add("plugin.errors");
  if (kind === "brainstem.log" && payload.level === "error") metrics.add("runtime.errors");
  if (String(kind ?? "").includes("failed") || metrics.has("plugin.errors") || metrics.has("runtime.errors")) metrics.add("errors.total");

  return [...metrics];
}

function getStats() {
  const counters = Object.fromEntries(
    statsDb.prepare("select key, value from stat_counters order by key").all()
      .map(row => [row.key, row.value])
  );

  const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const rows = statsDb.prepare(`
    select bucket, metric, value
    from stat_timeseries
    where bucket >= ?
    order by bucket asc
  `).all(cutoff);

  return {
    counters,
    series: rows,
    generatedAt: new Date().toISOString()
  };
}

async function readConfig() {
  return {
    path: configPath,
    content: await readFile(configPath, "utf8")
  };
}

async function saveConfig(content) {
  await assertValidModule(content);
  await writeFileAtomic(configPath, content);

  return {
    ok: true,
    path: configPath,
    savedAt: new Date().toISOString()
  };
}

async function writeFileAtomic(path, content) {
  const directory = dirname(path);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.${stamp}.bak`;
  const temporary = join(directory, `.${stamp}.${Math.random().toString(16).slice(2)}.tmp`);

  if (existsSync(path)) {
    await copyFile(path, backup);
  }

  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  }
  catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function assertValidModule(content) {
  const dir = await mkdtemp(join(tmpdir(), "brainstem-config-"));
  const file = join(dir, "brainstem.config.mjs");

  try {
    await writeFile(file, content, "utf8");
    await execFileAsync(process.execPath, ["--check", file], {
      timeout: 10_000
    });
  }
  catch (error) {
    const detail = error.stderr || error.stdout || error.message;
    throw new Error(`Config syntax check failed: ${detail.trim()}`);
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function minuteBucket(value) {
  const date = new Date(value);
  date.setSeconds(0, 0);
  return date.toISOString();
}

async function readJsonBody(request, fallback) {
  const body = await readBody(request);
  if (!body) return fallback;

  try {
    return JSON.parse(body);
  }
  catch {
    throw new HttpError(400, "Invalid JSON request body");
  }
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on("data", chunk => {
      size += chunk.length;

      if (size > maxBodyBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }

      if (!tooLarge) chunks.push(chunk);
    });

    request.on("end", () => {
      if (tooLarge) {
        reject(new HttpError(413, `Request body too large; max ${maxBodyBytes} bytes`));
        return;
      }

      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });

    request.on("error", reject);
  });
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, responseHeaders({
    "content-type": "application/json"
  }));
  response.end(JSON.stringify(value));
}

function sendNoContent(response, status = 204) {
  response.writeHead(status, responseHeaders());
  response.end();
}

function responseHeaders(headers = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "content-type",
    ...headers
  };
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function serveStatic(request, response) {
  const dist = resolve(root, "dist");
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const requested = pathname === "/"
    ? join(dist, "index.html")
    : resolve(dist, `.${pathname}`);

  if (!requested.startsWith(`${dist}/`) && requested !== join(dist, "index.html")) {
    throw new HttpError(403, "Forbidden");
  }

  const path = existsSync(requested)
    ? requested
    : join(dist, "index.html");

  if (!existsSync(path)) {
    response.writeHead(404);
    response.end("Run npm run build first.\n");
    return;
  }

  response.writeHead(200, responseHeaders({
    "content-type": contentType(path)
  }));
  createReadStream(path).pipe(response);
}

function contentType(path) {
  return {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml"
  }[extname(path)] ?? "application/octet-stream";
}
