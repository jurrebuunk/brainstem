import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { MetricsRegistry, createProcessRegistry } from "../src/observability/metrics.mjs";
import { registerClusterMetrics } from "../src/observability/brainstem-metrics.mjs";
import {
  NOOP_TRACER,
  activeSpan,
  createTracer,
  formatTraceparent,
  parseTraceparent,
  tracingOptionsFromEnv
} from "../src/observability/tracing.mjs";
import { createRuntimeLogger } from "../src/runtime/logger.mjs";
import { telemetryFromEnv } from "../src/runtime/telemetry.mjs";
import { BrainstemRuntime } from "../src/runtime/runtime.mjs";
import { createHealthServer } from "../src/runtime/health-server.mjs";
import { createCoreRegistry } from "../src/runtime/cores.mjs";
import { createInputLeaseStore } from "../src/runtime/input-leases.mjs";
import { createPipelineStorage } from "../src/queue/index.mjs";
import { createBackendApiServer } from "../src/backend/api-server.mjs";
import { dialectTest } from "./helpers/database.mjs";
import {
  countingInputSource,
  fakeBrainstem,
  readLines,
  recordingDestinationSource,
  silentLogger,
  tempDir,
  waitFor,
  writePlugin
} from "./helpers/fixtures.mjs";

// Metrics registry.

test("the registry renders counters, gauges and histograms in the Prometheus text format", async () => {
  const registry = new MetricsRegistry();
  const counter = registry.counter({ name: "things_total", help: "Things.", labels: ["kind"] });
  counter.inc({ kind: "a" });
  counter.inc({ kind: "a" }, 2);
  counter.inc({ kind: "say \"hi\"\n" });

  registry.gauge({ name: "level", help: "A level." }).set({}, 1.5);
  const histogram = registry.histogram({ name: "took_seconds", help: "Took.", labels: ["q"], buckets: [0.1, 1] });
  histogram.observe({ q: "x" }, 0.05);
  histogram.observe({ q: "x" }, 0.5);
  histogram.observe({ q: "x" }, 5);

  const text = await registry.render();

  assert.match(text, /# TYPE things_total counter\nthings_total\{kind="a"\} 3\n/);
  assert.match(text, /things_total\{kind="say \\"hi\\"\\n"\} 1/);
  assert.match(text, /# TYPE level gauge\nlevel 1\.5/);
  assert.match(text, /took_seconds_bucket\{q="x",le="0\.1"\} 1/);
  assert.match(text, /took_seconds_bucket\{q="x",le="1"\} 2/);
  assert.match(text, /took_seconds_bucket\{q="x",le="\+Inf"\} 3/);
  assert.match(text, /took_seconds_sum\{q="x"\} 5\.55/);
  assert.match(text, /took_seconds_count\{q="x"\} 3/);
  assert.ok(text.endsWith("\n"));

  assert.equal(registry.counter({ name: "things_total", labels: ["kind"] }), counter, "defining twice returns the metric");
  assert.throws(() => registry.gauge({ name: "things_total" }), /already defined/);
  assert.throws(() => counter.inc({}, -1), /only increase/);
  assert.throws(() => registry.counter({ name: "bad-name" }), /Invalid metric name/);
});

test("collectors run before each scrape and a failing one does not break it", async () => {
  const registry = new MetricsRegistry();
  const gauge = registry.gauge({ name: "depth", labels: ["queue"] });
  let calls = 0;
  registry.collect(() => {
    calls += 1;
    gauge.set({ queue: "decide" }, calls);
  });
  registry.collect(async () => {
    throw new Error("database down");
  });

  assert.match(await registry.render(), /depth\{queue="decide"\} 1/);
  assert.match(await registry.render(), /depth\{queue="decide"\} 2/);
});

test("the process registry reports build info, memory, CPU and event-loop lag", async () => {
  const registry = createProcessRegistry({ role: "core" });

  try {
    const text = await registry.render();
    assert.match(text, /brainstem_build_info\{version="[^"]+",role="core"\} 1/);
    for (const name of ["process_resident_memory_bytes", "process_cpu_seconds_total", "nodejs_heap_used_bytes", "nodejs_eventloop_lag_p99_seconds", "process_start_time_seconds"]) {
      assert.match(text, new RegExp(`\\n${name} [0-9.e+-]+`), name);
    }
  }
  finally {
    registry.close();
  }
});

// Tracing.

test("traceparent headers round-trip and invalid ones are rejected", () => {
  const value = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  assert.deepEqual(parseTraceparent(value), { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", sampled: true });
  assert.equal(formatTraceparent(parseTraceparent(value)), value);
  assert.equal(parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00").sampled, false);

  for (const bad of [null, "", "garbage", "ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", "00-00000000000000000000000000000000-b7ad6b7169203331-01"]) {
    assert.equal(parseTraceparent(bad), null, String(bad));
  }
});

test("tracing is configured by the standard OTEL environment and off without an endpoint", () => {
  assert.equal(tracingOptionsFromEnv({}), null);
  assert.equal(tracingOptionsFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_SDK_DISABLED: "true" }), null);

  const options = tracingOptionsFromEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/",
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20x,team=ops",
    OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=prod",
    OTEL_TRACES_SAMPLER_ARG: "0.25"
  }, { role: "core", instanceId: "core-1" });

  assert.equal(options.endpoint, "http://collector:4318/v1/traces");
  assert.deepEqual(options.headers, { authorization: "Bearer x", team: "ops" });
  assert.equal(options.serviceName, "brainstem-core");
  assert.equal(options.sampleRatio, 0.25);
  assert.equal(options.resource["deployment.environment"], "prod");
  assert.equal(options.resource["service.instance.id"], "core-1");

  assert.equal(
    tracingOptionsFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://a", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://b/traces" }).endpoint,
    "http://b/traces"
  );
});

test("spans export as OTLP JSON with parent links, attributes and errors", async () => {
  const collector = await startCollector();
  const tracer = createTracer({ endpoint: collector.url, serviceName: "test-svc", headers: { "x-token": "t" } });

  try {
    const root = tracer.startSpan("root", { attributes: { "a.int": 3, "a.str": "x", "a.bool": true, "a.float": 1.5 } });
    root.end();

    await assert.rejects(
      tracer.span("child", { parent: root.traceparent }, async span => {
        assert.equal(activeSpan(), span, "the span is active inside fn");
        throw new Error("boom");
      }),
      /boom/
    );

    await tracer.flush();

    const spans = collector.spans();
    assert.equal(collector.requests[0].headers["x-token"], "t");
    assert.equal(collector.requests[0].body.resourceSpans[0].resource.attributes.find(a => a.key === "service.name").value.stringValue, "test-svc");

    const exportedRoot = spans.find(span => span.name === "root");
    const child = spans.find(span => span.name === "child");
    assert.equal(child.traceId, exportedRoot.traceId);
    assert.equal(child.parentSpanId, exportedRoot.spanId);
    assert.equal(exportedRoot.parentSpanId, undefined);
    assert.deepEqual(exportedRoot.attributes.find(a => a.key === "a.int").value, { intValue: "3" });
    assert.deepEqual(exportedRoot.attributes.find(a => a.key === "a.float").value, { doubleValue: 1.5 });
    assert.equal(child.status.code, 2);
    assert.equal(child.events[0].name, "exception");
    assert.ok(BigInt(child.endTimeUnixNano) >= BigInt(child.startTimeUnixNano));
    assert.ok(Number(BigInt(exportedRoot.startTimeUnixNano) / 1_000_000n) > Date.now() - 60_000, "wall-clock nanoseconds");
  }
  finally {
    await collector.close();
  }
});

test("an unreachable collector never breaks the caller", async () => {
  const warnings = [];
  const tracer = createTracer({ endpoint: "http://127.0.0.1:1/v1/traces" }, { logger: { warn: (message) => warnings.push(message) } });
  tracer.startSpan("lost").end();
  await tracer.flush();
  assert.deepEqual(warnings, ["trace export failed"]);
});

test("the no-op tracer runs work without spans or trace context", async () => {
  assert.equal(NOOP_TRACER.enabled, false);
  assert.equal(await NOOP_TRACER.span("x", {}, span => span.traceparent), null);
});

test("logs inside a span carry its trace and span ids", async () => {
  const collector = await startCollector();
  const tracer = createTracer({ endpoint: collector.url });
  const lines = [];
  const logger = createRuntimeLogger({ format: "json", stream: { write: line => lines.push(JSON.parse(line)) } });

  try {
    let ids;
    await tracer.span("work", {}, span => {
      ids = { traceId: span.traceId, spanId: span.spanId };
      logger.info("inside");
    });
    logger.info("outside");

    assert.equal(lines[0].trace_id, ids.traceId);
    assert.equal(lines[0].span_id, ids.spanId);
    assert.equal(lines[1].trace_id, undefined);
  }
  finally {
    await collector.close();
  }
});

test("cores without a config file find the API for telemetry in the environment", () => {
  assert.equal(telemetryFromEnv({}), null);
  assert.deepEqual(
    telemetryFromEnv({ BRAINSTEM_TELEMETRY_URL: "http://api:5174/api/events", BRAINSTEM_TELEMETRY_TOKEN: "t" }),
    { url: "http://api:5174/api/events", headers: { authorization: "Bearer t" } }
  );
  assert.deepEqual(
    telemetryFromEnv({ BRAINSTEM_TELEMETRY_URL: "http://api/api/events", BRAINSTEM_API_TOKEN: "shared" }).headers,
    { authorization: "Bearer shared" }
  );
});

// The pipeline.

dialectTest("one envelope is one trace: poll, decide and deliver spans across jobs", async ({ handle }) => {
  const collector = await startCollector();
  const tracer = createTracer({ endpoint: collector.url, serviceName: "brainstem-core" });
  const registry = new MetricsRegistry();
  const dir = await tempDir("trace-pipeline");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource({ prefix: "t" }));
  const output = join(dir, "deliveries.log");
  const destinationPath = await writePlugin(dir, "destination.mjs", recordingDestinationSource(output));
  const traceparents = join(dir, "traceparents.log");
  const v2Path = await writePlugin(dir, "v2.mjs", `
import { appendFile } from "node:fs/promises";
export default { apiVersion: "brainstem.destination/v2", name: "tp", destinations: { default: {
  async handle(ctx) { await appendFile(${JSON.stringify(traceparents)}, ctx.traceparent + "\\n"); }
} } };`);

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    database: handle,
    logger: silentLogger,
    tracer,
    metrics: registry,
    config: pipelineConfig("tracer"),
    plugins: [{ id: "counter", module: inputPath, intervalMs: 60_000 }],
    destinations: [
      { id: "rec", module: destinationPath, decisions: ["queue"] },
      { id: "tp", module: v2Path, decisions: ["queue"] }
    ]
  });

  try {
    await runtime.runOnce();
    await tracer.flush();

    const spans = collector.spans();
    const poll = spans.find(span => span.name === "poll counter");
    const decide = spans.find(span => span.name === "decide");
    const deliverRec = spans.find(span => span.name === "deliver rec");
    const deliverTp = spans.find(span => span.name === "deliver tp");

    assert.ok(poll && decide && deliverRec && deliverTp, `spans: ${spans.map(span => span.name).join(", ")}`);
    assert.equal(decide.traceId, poll.traceId);
    assert.equal(decide.parentSpanId, poll.spanId);
    assert.equal(deliverRec.parentSpanId, decide.spanId);
    assert.equal(deliverTp.traceId, poll.traceId);
    assert.equal(decide.kind, 5, "consumer");

    const attribute = (span, key) => Object.values(span.attributes.find(a => a.key === key)?.value ?? {})[0];
    assert.equal(attribute(poll, "brainstem.poll.observations"), "1");
    assert.equal(attribute(decide, "brainstem.decision"), "queue");
    assert.equal(attribute(deliverRec, "brainstem.delivery.outcome"), "delivered");

    const [traceparent] = await readLines(traceparents);
    assert.equal(parseTraceparent(traceparent).spanId, deliverTp.spanId, "destinations get ctx.traceparent");

    const text = await registry.render();
    assert.match(text, /brainstem_polls_total\{input="counter",outcome="ok"\} 1/);
    assert.match(text, /brainstem_observations_total\{input="counter"\} 1/);
    assert.match(text, /brainstem_decisions_total\{decision="queue"\} 1/);
    assert.match(text, /brainstem_deliveries_total\{destination="rec",plugin="recording-destination",outcome="delivered"\} 1/);
    assert.match(text, /brainstem_job_duration_seconds_count\{queue="decide",outcome="ok"\} 1/);
    assert.match(text, /brainstem_job_duration_seconds_count\{queue="deliver",outcome="ok"\} 2/);
    assert.match(text, /brainstem_poll_duration_seconds_count\{input="counter"\} 1/);
    assert.match(text, /brainstem_input_lease_lag_seconds\{input="counter"\} /);
  }
  finally {
    await runtime.close();
    await collector.close();
  }
});

dialectTest("without tracing nothing is stored in jobs", async ({ handle }) => {
  const dir = await tempDir("no-trace");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource({ prefix: "n" }));
  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    database: handle,
    logger: silentLogger,
    tracer: NOOP_TRACER,
    metrics: new MetricsRegistry(),
    config: { ...pipelineConfig("plain"), runtime: { ...pipelineConfig("plain").runtime, queues: ["poll"] } },
    plugins: [{ id: "counter", module: inputPath, intervalMs: 60_000 }]
  });

  try {
    await runtime.runOnce();
    const [job] = await handle.db.selectFrom("jobs").selectAll().execute();
    assert.equal(JSON.parse(job.payload_json).trace, undefined);
  }
  finally {
    await runtime.close();
  }
});

dialectTest("failed deliveries and job retries are counted", async ({ handle }) => {
  const registry = new MetricsRegistry();
  const dir = await tempDir("metrics-failures");
  const inputPath = await writePlugin(dir, "input.mjs", countingInputSource({ prefix: "f" }));
  const failingPath = await writePlugin(dir, "fail.mjs", `
export default { apiVersion: "brainstem.destination/v2", name: "fails", destinations: { default: {
  async handle() { throw new Error("receiver down"); }
} } };`);

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    database: handle,
    logger: silentLogger,
    tracer: NOOP_TRACER,
    metrics: registry,
    config: pipelineConfig("failing"),
    plugins: [{ id: "counter", module: inputPath, intervalMs: 60_000 }],
    destinations: [{ id: "down", module: failingPath, decisions: ["queue"], retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0 } }]
  });

  try {
    await assert.rejects(runtime.runOnce(), /receiver down/);
    const text = await registry.render();
    assert.match(text, /brainstem_deliveries_total\{destination="down",plugin="fails",outcome="failed"\} 1/);
    assert.match(text, /brainstem_deliveries_total\{destination="down",plugin="fails",outcome="dead"\} 1/);
    assert.match(text, /brainstem_job_failures_total\{queue="deliver",dead="false"\} 1/);
    assert.match(text, /brainstem_job_failures_total\{queue="deliver",dead="true"\} 1/);
  }
  finally {
    await runtime.close();
  }
});

// Cluster-wide gauges.

dialectTest("cluster metrics report queue depth and age, cores, inputs and deliveries", async ({ handle }) => {
  const now = Date.now();
  const registry = new MetricsRegistry();
  const remove = registerClusterMetrics(registry, { database: handle, cacheMs: 0, now: () => now });
  const { transport } = createPipelineStorage({ type: "database", database: handle });
  const cores = createCoreRegistry({ database: async () => handle });
  const leases = createInputLeaseStore({ database: handle });

  try {
    await transport.enqueue([
      { queue: "decide", payload: {}, runAt: now - 30_000 },
      { queue: "decide", payload: {}, runAt: now - 5_000 },
      { queue: "decide", payload: {}, runAt: now + 60_000 },
      { queue: "deliver", payload: {}, runAt: now - 1_000 }
    ]);
    const [claimed] = await transport.claim({ queues: ["deliver"], limit: 1, leaseMs: 60_000, workerId: "w" });
    assert.ok(claimed);

    await cores.register({ id: "decider", queues: ["decide"], heartbeatMs: 10_000, now });
    await cores.register({ id: "everything", queues: ["poll", "decide", "deliver"], heartbeatMs: 10_000, now });
    await cores.register({ id: "gone", heartbeatMs: 1_000, now: now - 60_000 });

    await leases.declare([
      { id: "due", intervalMs: 1_000 },
      { id: "idle", intervalMs: 1_000 },
      { id: "busy", intervalMs: 1_000 }
    ], { at: now - 20_000 });
    const [idle] = await leases.claim({ ids: ["idle"], owner: "everything", at: now - 20_000 });
    await leases.release(idle, { nextDueAt: now + 60_000 });
    await leases.claim({ ids: ["busy"], owner: "everything", leaseMs: 120_000, at: now - 20_000 });

    const text = await registry.render();

    assert.match(text, /brainstem_queue_ready\{queue="decide"\} 2/);
    assert.match(text, /brainstem_queue_delayed\{queue="decide"\} 1/);
    assert.match(text, /brainstem_queue_oldest_age_seconds\{queue="decide"\} 30\n/);
    assert.match(text, /brainstem_queue_running\{queue="deliver"\} 1/);
    assert.match(text, /brainstem_queue_ready\{queue="deliver"\} 0/);
    assert.match(text, /brainstem_queue_oldest_age_seconds\{queue="deliver"\} 0\n/);
    assert.match(text, /brainstem_cores\{status="running"\} 2/);
    assert.match(text, /brainstem_cores\{status="lost"\} 1/);
    assert.match(text, /brainstem_cores_running\{queue="decide"\} 2/);
    assert.match(text, /brainstem_cores_running\{queue="poll"\} 1/);
    assert.match(text, /brainstem_inputs\{state="due"\} 1/);
    assert.match(text, /brainstem_inputs\{state="idle"\} 1/);
    assert.match(text, /brainstem_inputs\{state="leased"\} 1/);
    assert.match(text, /brainstem_input_schedule_lag_seconds 20\n/);
    assert.match(text, /brainstem_deliveries\{status="dead"\} 0/);
  }
  finally {
    remove();
  }
});

dialectTest("the API and the core health port serve /metrics, optionally behind a token", async ({ handle }) => {
  const dir = await mkdtemp(join(tmpdir(), "brainstem-metrics-"));
  const configPath = join(dir, "brainstem.config.mjs");
  await writeFile(configPath, "export default {}\n");
  const registry = new MetricsRegistry();
  const api = createBackendApiServer({ host: "127.0.0.1", port: 0, configPath, database: handle, metrics: registry, maintenanceIntervalMs: 0 });
  await api.listen();

  const runtime = new BrainstemRuntime({
    brainstem: fakeBrainstem(),
    database: handle,
    logger: silentLogger,
    tracer: NOOP_TRACER,
    metrics: registry,
    config: { ...pipelineConfig("probe"), runtime: { ...pipelineConfig("probe").runtime, queues: ["decide", "deliver"] } }
  });
  const health = createHealthServer({ host: "127.0.0.1", port: 0, runtime, metrics: registry });
  await health.listen();
  const previous = process.env.BRAINSTEM_METRICS_TOKEN;

  try {
    await runtime.start();

    const fromApi = await fetch(`${api.url}/metrics`);
    assert.equal(fromApi.status, 200);
    assert.match(fromApi.headers.get("content-type"), /text\/plain; version=0\.0\.4/);
    const apiText = await fromApi.text();
    assert.match(apiText, /brainstem_queue_ready\{queue="decide"\} 0/);
    assert.match(apiText, /brainstem_cores\{status="running"\} 1/);

    const fromCore = await (await fetch(`${health.url}/metrics`)).text();
    assert.match(fromCore, /brainstem_core_info\{core_id="probe",role="all",queues="decide,deliver"\} 1/);
    assert.match(fromCore, /brainstem_jobs_inflight\{queue="decide"\} 0/);
    assert.match(fromCore, /brainstem_core_draining 0/);

    process.env.BRAINSTEM_METRICS_TOKEN = "scrape";
    assert.equal((await fetch(`${api.url}/metrics`)).status, 401);
    assert.equal((await fetch(`${health.url}/metrics`)).status, 401);
    assert.equal((await fetch(`${health.url}/metrics`, { headers: { authorization: "Bearer scrape" } })).status, 200);
  }
  finally {
    if (previous === undefined) delete process.env.BRAINSTEM_METRICS_TOKEN;
    else process.env.BRAINSTEM_METRICS_TOKEN = previous;
    await runtime.drain({ timeoutMs: 1_000 });
    await runtime.close();
    await health.close();
    await api.close();
  }
});

function pipelineConfig(coreId) {
  return {
    runtime: {
      coreId,
      records: { type: "memory" },
      checkpoints: { type: "database", legacyPath: false },
      retry: { attempts: 1, minDelayMs: 0, maxDelayMs: 0, factor: 1 },
      queue: { pollIntervalMs: 20, leaseMs: 2_000 },
      inputs: { leaseMs: 1_000, checkIntervalMs: 20 },
      cores: { heartbeatMs: 200 },
      shutdown: { timeoutMs: 2_000 }
    }
  };
}

/*
 * A stand-in OTLP/HTTP collector that records what it receives.
 */
async function startCollector() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, headers: request.headers, body: JSON.parse(body) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}/v1/traces`,
    requests,
    spans() {
      return requests.flatMap(request =>
        request.body.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))
      );
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
