import { createReadStream } from "node:fs";
import http from "node:http";
import { extname, join } from "node:path";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 5173);
const root = new URL(".", import.meta.url).pathname;
const isProduction = process.env.NODE_ENV === "production";
const backendUrl = (process.env.WEB_BACKEND_URL ?? process.env.BRAINSTEM_API_URL ?? "http://127.0.0.1:5174").replace(/\/$/, "");
const backendToken = process.env.WEB_BACKEND_TOKEN ?? process.env.BRAINSTEM_API_TOKEN;
let vite = null;

if (!isProduction) {
  const { createServer } = await import("vite");
  vite = await createServer({
    root,
    appType: "spa",
    server: { middlewareMode: true }
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${host}:${port}`);

    if (url.pathname.startsWith("/api/")) {
      await proxyBackend(request, response);
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
    if (!response.headersSent) {
      response.writeHead(error.statusCode ?? 500, { "content-type": "application/json" });
    }
    response.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, host, () => {
  console.log(`Brainstem Web UI listening on http://${host}:${port}`);
  console.log(`Backend API: ${backendUrl}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}

async function proxyBackend(request, response) {
  const target = new URL(request.url, backendUrl);
  const headers = { ...request.headers };
  delete headers.host;
  if (backendToken && !headers.authorization) {
    headers.authorization = `Bearer ${backendToken}`;
  }

  const backendResponse = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request,
    duplex: "half"
  });

  response.writeHead(
    backendResponse.status,
    Object.fromEntries(backendResponse.headers.entries())
  );

  if (!backendResponse.body) {
    response.end();
    return;
  }

  for await (const chunk of backendResponse.body) {
    response.write(chunk);
  }
  response.end();
}

async function serveStatic(request, response) {
  const url = new URL(request.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const file = join(root, "dist", safePath);

  if (!file.startsWith(join(root, "dist"))) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  const stream = createReadStream(file);

  stream.on("error", () => {
    if (safePath !== "/index.html") {
      request.url = "/";
      serveStatic(request, response).catch(error => {
        response.writeHead(500);
        response.end(error.message);
      });
      return;
    }

    response.writeHead(404);
    response.end("Not found");
  });

  stream.on("open", () => {
    response.writeHead(200, {
      "content-type": contentType(file)
    });
    stream.pipe(response);
  });
}

function contentType(path) {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}
