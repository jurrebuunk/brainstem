import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

    if (url.pathname === "/api/events" && request.method === "POST") {
      const event = normalizeIncomingEvent(
        JSON.parse(await readBody(request) || "null")
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
      const body = JSON.parse(await readBody(request) || "{}");
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
    console.error(error);
    sendJson(response, { error: error.message }, 500);
  }
});

server.listen(port, host, () => {
  console.log(`Brainstem Web listening on http://${host}:${port}`);
  console.log(`Ingest endpoint: http://${host}:${port}/api/events`);
  console.log(`Stats database: ${statsDbPath}`);
});

function addEvent(event) {
  events.push(event);
  recordStatsEvent(event);

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
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*"
  });

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
    statsDb.exec("commit");
  }
  catch (error) {
    statsDb.exec("rollback");
    throw error;
  }
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
  if (kind.includes("failed") || metrics.has("plugin.errors") || metrics.has("runtime.errors")) metrics.add("errors.total");

  return [...metrics];
}

function getStats() {
  const counters = Object.fromEntries(
    statsDb.prepare("select key, value from stat_counters order by key").all()
      .map(row => [row.key, row.value])
  );

  const rows = statsDb.prepare(`
    select bucket, metric, value
    from stat_timeseries
    where bucket >= datetime('now', '-6 hours')
    order by bucket asc
  `).all();

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
  await writeFile(configPath, content, "utf8");

  return {
    ok: true,
    path: configPath,
    savedAt: new Date().toISOString()
  };
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

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];

    request.on("data", chunk => {
      chunks.push(chunk);
    });

    request.on("end", () => {
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });

    request.on("error", reject);
  });
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*"
  });
  response.end(JSON.stringify(value));
}

async function serveStatic(request, response) {
  const dist = resolve(root, "dist");
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const requested = pathname === "/"
    ? join(dist, "index.html")
    : join(dist, pathname);

  const path = existsSync(requested)
    ? requested
    : join(dist, "index.html");

  if (!existsSync(path)) {
    response.writeHead(404);
    response.end("Run npm run build first.\n");
    return;
  }

  response.writeHead(200, {
    "content-type": contentType(path)
  });
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
