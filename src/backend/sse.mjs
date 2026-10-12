import { responseHeaders } from "./http-utils.mjs";

export function createSseHub() {
  const clients = new Set();

  return {
    get size() {
      return clients.size;
    },

    stream(response) {
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
      response.on("close", () => clients.delete(response));
    },

    broadcast(event) {
      const line = `data: ${JSON.stringify(event)}\n\n`;
      for (const client of clients) {
        client.write(line);
      }
    }
  };
}
