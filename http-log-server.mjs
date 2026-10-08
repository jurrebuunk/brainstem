#!/usr/bin/env node
import http from "node:http";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);

const server = http.createServer(async (request, response) => {
  if (request.method !== "POST") {
    response.writeHead(405, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify({ error: "POST required" }));
    return;
  }

  try {
    const body = await readBody(request);
    const json = JSON.parse(body || "null");

    console.log("\n=== Brainstem output ===");
    console.log(JSON.stringify(json, null, 2));

    response.writeHead(204);
    response.end();
  }
  catch (error) {
    console.error("Failed to handle request:", error);

    response.writeHead(400, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, host, () => {
  console.log(`Brainstem HTTP log server listening on http://${host}:${port}`);
});

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", chunk => {
      chunks.push(chunk);
    });

    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    request.on("error", reject);
  });
}
