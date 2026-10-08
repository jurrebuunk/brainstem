import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { extname, join, resolve } from "node:path";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 5173);
const root = new URL(".", import.meta.url).pathname;
const isProduction = process.env.NODE_ENV === "production";
const maxEvents = Number(process.env.MAX_EVENTS ?? 2000);

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
    if (request.url === "/api/events" && request.method === "POST") {
      const event = normalizeIncomingEvent(
        JSON.parse(await readBody(request) || "null")
      );

      addEvent(event);
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.url === "/api/events" && request.method === "GET") {
      sendJson(response, events);
      return;
    }

    if (request.url === "/api/stream" && request.method === "GET") {
      streamEvents(response);
      return;
    }

    if (request.url === "/api/health" && request.method === "GET") {
      sendJson(response, {
        ok: true,
        events: events.length
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
});

function addEvent(event) {
  events.push(event);

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
