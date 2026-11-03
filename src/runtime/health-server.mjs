import http from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";

import { registerClusterMetrics } from "../observability/brainstem-metrics.mjs";
import { defaultRegistry, metricsAuthorized, metricsEnabled, sendMetrics } from "../observability/metrics.mjs";

/*
 * Probes for a core process (roadmap §5):
 *
 *   GET /livez     the event loop is alive; never touches the
 *                  database, so a database outage never restarts pods
 *   GET /readyz    started, not draining and the database reachable
 *   GET /startupz  started: schema checked, plugins and model loaded
 *   GET /metrics   Prometheus metrics of this process; with
 *                  `clusterDatabase` (role all) also the cluster-wide
 *                  queue, core and input gauges
 *
 * The API serves the same paths on its own port.
 */
export function createHealthServer({
  host = "0.0.0.0",
  port = 8081,
  runtime,
  logger = null,
  metrics = metricsEnabled() ? defaultRegistry() : null,
  clusterDatabase = null
}) {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();

  const removeCluster = metrics && clusterDatabase
    ? registerClusterMetrics(metrics, { database: clusterDatabase })
    : null;

  const server = http.createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    const health = runtime.health();

    if (request.method !== "GET") {
      send(response, 405, { ok: false });
      return;
    }

    if (path === "/livez") {
      send(response, 200, {
        ok: true,
        eventLoopDelayMs: Math.round(delay.percentile(99) / 1e6)
      });
      delay.reset();
      return;
    }

    if (path === "/readyz") {
      const ready = await runtime.ready();
      send(response, ready ? 200 : 503, { ok: ready, ...health });
      return;
    }

    if (path === "/metrics" && metrics) {
      if (!metricsAuthorized(request)) {
        send(response, 401, { ok: false, error: "Unauthorized" });
        return;
      }

      await sendMetrics(response, metrics);
      return;
    }

    if (path === "/startupz") {
      send(response, health.started ? 200 : 503, { ok: health.started, ...health });
      return;
    }

    send(response, 404, { ok: false, error: "Not found" });
  });

  return {
    server,
    get url() {
      const address = server.address();
      return address && typeof address === "object" ? `http://${host}:${address.port}` : null;
    },

    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      logger?.info?.("health endpoints listening", { url: this.url });
      return this;
    },

    async close() {
      delay.disable();
      removeCluster?.();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve()));
    }
  };
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
