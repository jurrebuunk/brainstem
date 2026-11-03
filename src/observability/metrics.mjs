import { monitorEventLoopDelay } from "node:perf_hooks";

import packageJson from "../../package.json" with { type: "json" };

/*
 * Prometheus metrics (roadmap §5, Phase 4).
 *
 * A small in-house registry that renders the text exposition format
 * (version 0.0.4), so no client library is needed:
 *
 *   const jobs = registry.counter({ name, help, labels: ["queue"] });
 *   jobs.inc({ queue: "decide" });
 *
 *   registry.histogram({ name, help, labels, buckets }).observe(labels, seconds)
 *   registry.gauge({ name, help, labels }).set(labels, value)
 *   registry.collect(async () => { ...set gauges... })   before each scrape
 *   await registry.render()
 *
 * Defining a metric twice returns the existing one, so every runtime
 * in a process (role all: the runtime and the API) shares one
 * process-wide registry (defaultRegistry()).
 *
 * Exposed on GET /metrics: the API port, and the core health port
 * (--health-port). Label values come from the config (input and
 * destination ids), never from observation data, so cardinality
 * stays bounded.
 */
export const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

const NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export class MetricsRegistry {
  constructor() {
    this.metrics = new Map();
    this.collectors = new Set();
  }

  counter(options) {
    return this.#define(Counter, options);
  }

  gauge(options) {
    return this.#define(Gauge, options);
  }

  histogram(options) {
    return this.#define(Histogram, options);
  }

  get(name) {
    return this.metrics.get(name) ?? null;
  }

  /*
   * fn() runs before every render (async allowed); it usually sets
   * gauges from current state. Returns a function that removes it.
   */
  collect(fn) {
    this.collectors.add(fn);
    return () => this.collectors.delete(fn);
  }

  async render() {
    await Promise.all([...this.collectors].map(async fn => {
      try {
        await fn();
      }
      catch {
        // A failing collector (database down) never breaks the scrape;
        // its gauges keep their last values.
      }
    }));

    return [...this.metrics.values()]
      .map(metric => metric.render())
      .filter(Boolean)
      .join("\n") + "\n";
  }

  #define(Type, { name, help = "", labels = [], ...rest }) {
    const existing = this.metrics.get(name);

    if (existing) {
      if (!(existing instanceof Type)) {
        throw new Error(`Metric '${name}' is already defined as a ${existing.type}`);
      }
      return existing;
    }

    if (!NAME_PATTERN.test(name)) throw new Error(`Invalid metric name '${name}'`);
    for (const label of labels) {
      if (!LABEL_PATTERN.test(label) || label.startsWith("__")) {
        throw new Error(`Invalid label name '${label}' on '${name}'`);
      }
    }

    const metric = new Type({ name, help, labels, ...rest });
    this.metrics.set(name, metric);
    return metric;
  }
}

class Metric {
  constructor({ name, help, labels }) {
    this.name = name;
    this.help = help;
    this.labels = labels;
    this.series = new Map();
  }

  key(labels = {}) {
    return JSON.stringify(this.labels.map(label => String(labels[label] ?? "")));
  }

  labelText(key, extra = null) {
    const values = JSON.parse(key);
    const pairs = this.labels.map((label, index) => [label, values[index]]);
    if (extra) pairs.push(extra);
    if (pairs.length === 0) return "";
    return `{${pairs.map(([label, value]) => `${label}="${escapeLabel(value)}"`).join(",")}}`;
  }

  header() {
    return `# HELP ${this.name} ${escapeHelp(this.help)}\n# TYPE ${this.name} ${this.type}`;
  }

  /*
   * Forget every series (gauges recomputed from scratch each scrape,
   * so series that disappeared don't linger).
   */
  reset() {
    this.series.clear();
  }
}

class Counter extends Metric {
  get type() {
    return "counter";
  }

  inc(labels = {}, value = 1) {
    if (!(value >= 0)) throw new Error(`Counter '${this.name}' can only increase`);
    const key = this.key(labels);
    this.series.set(key, (this.series.get(key) ?? 0) + value);
  }

  value(labels = {}) {
    return this.series.get(this.key(labels)) ?? 0;
  }

  render() {
    const lines = [this.header()];
    // A counter without labels is reported as 0 before its first inc.
    if (this.series.size === 0 && this.labels.length === 0) lines.push(`${this.name} 0`);
    for (const [key, value] of this.series) lines.push(`${this.name}${this.labelText(key)} ${formatValue(value)}`);
    return lines.join("\n");
  }
}

class Gauge extends Metric {
  get type() {
    return "gauge";
  }

  set(labels = {}, value = 0) {
    this.series.set(this.key(labels), Number(value));
  }

  inc(labels = {}, value = 1) {
    const key = this.key(labels);
    this.series.set(key, (this.series.get(key) ?? 0) + value);
  }

  dec(labels = {}, value = 1) {
    this.inc(labels, -value);
  }

  value(labels = {}) {
    return this.series.get(this.key(labels)) ?? 0;
  }

  render() {
    if (this.series.size === 0 && this.labels.length > 0) return `${this.header()}`;
    const lines = [this.header()];
    if (this.series.size === 0) lines.push(`${this.name} 0`);
    for (const [key, value] of this.series) lines.push(`${this.name}${this.labelText(key)} ${formatValue(value)}`);
    return lines.join("\n");
  }
}

class Histogram extends Metric {
  constructor({ buckets = DURATION_BUCKETS, ...rest }) {
    super(rest);
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  get type() {
    return "histogram";
  }

  observe(labels = {}, value) {
    const key = this.key(labels);
    let series = this.series.get(key);

    if (!series) {
      series = { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, series);
    }

    for (let index = 0; index < this.buckets.length; index += 1) {
      if (value <= this.buckets[index]) series.counts[index] += 1;
    }
    series.sum += value;
    series.count += 1;
  }

  /*
   * Time fn and observe its duration in seconds, also when it throws.
   */
  async time(labels, fn) {
    const start = process.hrtime.bigint();
    try {
      return await fn();
    }
    finally {
      this.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
    }
  }

  count(labels = {}) {
    return this.series.get(this.key(labels))?.count ?? 0;
  }

  render() {
    const lines = [this.header()];

    for (const [key, series] of this.series) {
      this.buckets.forEach((bucket, index) => {
        lines.push(`${this.name}_bucket${this.labelText(key, ["le", formatValue(bucket)])} ${series.counts[index]}`);
      });
      lines.push(`${this.name}_bucket${this.labelText(key, ["le", "+Inf"])} ${series.count}`);
      lines.push(`${this.name}_sum${this.labelText(key)} ${formatValue(series.sum)}`);
      lines.push(`${this.name}_count${this.labelText(key)} ${series.count}`);
    }

    return lines.join("\n");
  }
}

let defaultInstance = null;

export function defaultRegistry() {
  defaultInstance ??= createProcessRegistry();
  return defaultInstance;
}

/*
 * Label the process registry with this process's role (serve.mjs).
 */
export function configureMetrics({ role }) {
  const registry = defaultRegistry();
  const info = registry.get("brainstem_build_info");
  info.reset();
  info.set({ version: packageJson.version, role }, 1);
  return registry;
}

/*
 * A registry with process metrics: build info, uptime, memory, CPU
 * and event-loop lag (the liveness signal Kubernetes cannot see).
 */
export function createProcessRegistry({ role = process.env.BRAINSTEM_ROLE ?? "all" } = {}) {
  const registry = new MetricsRegistry();

  registry.gauge({
    name: "brainstem_build_info",
    help: "Brainstem version and role of this process (always 1).",
    labels: ["version", "role"]
  }).set({ version: packageJson.version, role }, 1);

  registry.gauge({
    name: "process_start_time_seconds",
    help: "Start time of the process since unix epoch in seconds."
  }).set({}, Math.round(Date.now() / 1000 - process.uptime()));

  const cpu = registry.counter({ name: "process_cpu_seconds_total", help: "Total user and system CPU time spent in seconds." });
  const memory = registry.gauge({ name: "process_resident_memory_bytes", help: "Resident memory size in bytes." });
  const heap = registry.gauge({ name: "nodejs_heap_used_bytes", help: "V8 heap in use in bytes." });
  const heapTotal = registry.gauge({ name: "nodejs_heap_size_total_bytes", help: "V8 heap size in bytes." });
  const lag = registry.gauge({
    name: "nodejs_eventloop_lag_p99_seconds",
    help: "99th percentile event-loop delay since the previous scrape, in seconds."
  });
  const lagMax = registry.gauge({
    name: "nodejs_eventloop_lag_max_seconds",
    help: "Maximum event-loop delay since the previous scrape, in seconds."
  });

  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let lastCpu = 0;

  registry.collect(() => {
    const usage = process.cpuUsage();
    const total = (usage.user + usage.system) / 1e6;
    cpu.inc({}, Math.max(0, total - lastCpu));
    lastCpu = total;

    const mem = process.memoryUsage();
    memory.set({}, mem.rss);
    heap.set({}, mem.heapUsed);
    heapTotal.set({}, mem.heapTotal);

    lag.set({}, delay.count > 0 ? delay.percentile(99) / 1e9 : 0);
    lagMax.set({}, delay.count > 0 ? delay.max / 1e9 : 0);
    delay.reset();
  });

  registry.close = () => delay.disable();

  return registry;
}

/*
 * Serve the registry on a node:http response.
 */
export async function sendMetrics(response, registry) {
  const body = await registry.render();
  response.writeHead(200, { "content-type": CONTENT_TYPE, "cache-control": "no-store" });
  response.end(body);
}

/*
 * Optional bearer token for /metrics (BRAINSTEM_METRICS_TOKEN).
 * Unset: open, like most exporters; keep the port off the ingress.
 */
export function metricsAuthorized(request, token = process.env.BRAINSTEM_METRICS_TOKEN) {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

export function metricsEnabled(value = process.env.BRAINSTEM_METRICS) {
  return !(value === "false" || value === "0");
}

function formatValue(value) {
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  if (Number.isNaN(value)) return "NaN";
  return String(value);
}

function escapeLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\"", "\\\"");
}

function escapeHelp(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}
