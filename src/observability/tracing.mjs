import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

import packageJson from "../../package.json" with { type: "json" };

/*
 * OpenTelemetry tracing (roadmap §5, Phase 4).
 *
 * One envelope is one trace across pods:
 *
 *   poll <input>  ─▶  decide  ─▶  deliver <destination>  (─▶ decide ...)
 *
 * Each stage runs in a different job, possibly on a different core,
 * so the W3C `traceparent` of the stage that enqueued a job is
 * stored in the job payload and the next stage continues from it.
 * Destinations get it as ctx.traceparent (http-json forwards it as a
 * header).
 *
 * A small in-house tracer: spans are exported as OTLP/HTTP JSON,
 * which the OpenTelemetry Collector, Jaeger, Tempo and most vendors
 * accept on port 4318. Configured by the standard environment:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT          http://collector:4318 (+ /v1/traces)
 *   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT   full traces URL (wins)
 *   OTEL_EXPORTER_OTLP_HEADERS           k=v,k2=v2
 *   OTEL_SERVICE_NAME                    default brainstem-<role>
 *   OTEL_RESOURCE_ATTRIBUTES             k=v,k2=v2
 *   OTEL_TRACES_SAMPLER_ARG              ratio for new traces (default 1)
 *   OTEL_SDK_DISABLED=true               off
 *
 * Without an endpoint tracing is off: spans are no-ops and nothing is
 * stored in jobs.
 */
export const SPAN_KIND = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5
};

const STATUS_ERROR = 2;
const MAX_QUEUE = 2_048;
const MAX_BATCH = 512;
const EXPORT_TIMEOUT_MS = 10_000;

const storage = new AsyncLocalStorage();

/*
 * The span the current async context runs in (logs add its ids).
 */
export function activeSpan() {
  return storage.getStore() ?? null;
}

export function parseTraceparent(value) {
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(String(value ?? "").trim().toLowerCase());
  if (!match || match[1] === "ff") return null;
  if (/^0+$/.test(match[2]) || /^0+$/.test(match[3])) return null;

  return {
    traceId: match[2],
    spanId: match[3],
    sampled: (parseInt(match[4], 16) & 1) === 1
  };
}

export function formatTraceparent({ traceId, spanId, sampled }) {
  return `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}

export function tracingOptionsFromEnv(env = process.env, { role = env.BRAINSTEM_ROLE ?? "all", instanceId = null } = {}) {
  if (env.OTEL_SDK_DISABLED === "true") return null;

  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const baseEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const endpoint = tracesEndpoint || (baseEndpoint ? `${baseEndpoint.replace(/\/+$/, "")}/v1/traces` : null);

  if (!endpoint || env.OTEL_TRACES_EXPORTER === "none") return null;

  const ratio = Number(env.OTEL_TRACES_SAMPLER_ARG ?? 1);

  return {
    endpoint,
    headers: parseKeyValues(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS),
    serviceName: env.OTEL_SERVICE_NAME || `brainstem-${role}`,
    sampleRatio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 1,
    protocol: env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/json",
    resource: {
      ...parseKeyValues(env.OTEL_RESOURCE_ATTRIBUTES),
      "brainstem.role": role,
      ...(instanceId ? { "service.instance.id": instanceId } : {})
    }
  };
}

/*
 * createTracer(options | null) -> tracer. null (or no endpoint)
 * gives the no-op tracer.
 */
export function createTracer(options, { logger = null, fetchImpl = globalThis.fetch } = {}) {
  if (!options?.endpoint) return NOOP_TRACER;
  return new Tracer(options, { logger, fetchImpl });
}

let defaultInstance = null;

/*
 * The process-wide tracer: configureTracing() once at startup
 * (serve.mjs), otherwise created from the environment on first use.
 */
export function defaultTracer() {
  defaultInstance ??= createTracer(tracingOptionsFromEnv());
  return defaultInstance;
}

export function configureTracing({ role, instanceId, logger = null, env = process.env } = {}) {
  const options = tracingOptionsFromEnv(env, { role, instanceId });
  defaultInstance = createTracer(options, { logger });

  if (options && options.protocol !== "http/json") {
    logger?.warn?.("only OTLP http/json is supported; exporting traces as http/json", {
      protocol: options.protocol,
      endpoint: options.endpoint
    });
  }

  if (options) logger?.info?.("tracing enabled", { endpoint: options.endpoint, service: options.serviceName });

  return defaultInstance;
}

class Tracer {
  constructor(options, { logger, fetchImpl }) {
    this.endpoint = options.endpoint;
    this.headers = options.headers ?? {};
    this.sampleRatio = options.sampleRatio ?? 1;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.resource = attributeList({
      "service.name": options.serviceName ?? "brainstem",
      "service.version": packageJson.version,
      "telemetry.sdk.name": "brainstem",
      "telemetry.sdk.language": "nodejs",
      ...(options.resource ?? {})
    });
    this.queue = [];
    this.timer = null;
    this.exporting = null;
    this.warned = false;
    this.dropped = 0;
    this.scheduleDelayMs = options.scheduleDelayMs ?? Number(process.env.OTEL_BSP_SCHEDULE_DELAY ?? 2_000);
  }

  get enabled() {
    return true;
  }

  /*
   * parent: a traceparent string, a span, or { traceId, spanId,
   * sampled }. Defaults to the active span; none starts a new trace.
   */
  startSpan(name, { parent = activeSpan(), kind = SPAN_KIND.internal, attributes = {} } = {}) {
    const context = typeof parent === "string" ? parseTraceparent(parent) : parent ?? null;
    const traceId = context?.traceId ?? randomHex(16);
    const sampled = context ? context.sampled !== false : Math.random() < this.sampleRatio;

    return new Span(this, {
      name,
      kind,
      traceId,
      parentSpanId: context?.spanId ?? null,
      sampled,
      attributes
    });
  }

  /*
   * Run fn(span) inside a new span that ends when fn settles; a
   * thrown error marks the span failed and is rethrown.
   */
  async span(name, options, fn) {
    const span = this.startSpan(name, options);

    try {
      const result = await storage.run(span, () => fn(span));
      span.end();
      return result;
    }
    catch (error) {
      span.recordException(error);
      span.end();
      throw error;
    }
  }

  withSpan(span, fn) {
    return storage.run(span, fn);
  }

  enqueue(span) {
    if (!span.sampled) return;

    if (this.queue.length >= MAX_QUEUE) {
      this.dropped += 1;
      return;
    }

    this.queue.push(span);

    if (this.queue.length >= MAX_BATCH) {
      this.#exportSoon(0);
    }
    else {
      this.#exportSoon(this.scheduleDelayMs);
    }
  }

  #exportSoon(delayMs) {
    if (this.timer && delayMs > 0) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, delayMs);
    this.timer.unref?.();
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = null;

    while (this.exporting) await this.exporting;

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, MAX_BATCH);
      this.exporting = this.#send(batch).finally(() => {
        this.exporting = null;
      });
      await this.exporting;
    }
  }

  async #send(spans) {
    const body = JSON.stringify({
      resourceSpans: [{
        resource: { attributes: this.resource },
        scopeSpans: [{
          scope: { name: "brainstem", version: packageJson.version },
          spans: spans.map(span => span.toOtlp())
        }]
      }]
    });

    try {
      const response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body,
        signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS)
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await response.body?.cancel?.().catch?.(() => {});
      this.warned = false;
    }
    catch (error) {
      // Tracing never breaks the pipeline; warn once per outage.
      if (!this.warned) {
        this.warned = true;
        this.logger?.warn?.("trace export failed", { endpoint: this.endpoint, spans: spans.length, error: error.message });
      }
    }
  }

  async shutdown() {
    await this.flush();
  }
}

class Span {
  constructor(tracer, { name, kind, traceId, parentSpanId, sampled, attributes }) {
    this.tracer = tracer;
    this.name = name;
    this.kind = kind;
    this.traceId = traceId;
    this.spanId = randomHex(8);
    this.parentSpanId = parentSpanId;
    this.sampled = sampled;
    this.attributes = { ...attributes };
    this.events = [];
    this.status = null;
    this.startNs = nowNs();
    this.endNs = null;
  }

  get traceparent() {
    return formatTraceparent(this);
  }

  setAttribute(key, value) {
    if (value !== undefined && value !== null) this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes) {
    for (const [key, value] of Object.entries(attributes)) this.setAttribute(key, value);
    return this;
  }

  addEvent(name, attributes = {}) {
    this.events.push({ name, timeNs: nowNs(), attributes });
    return this;
  }

  recordException(error) {
    this.addEvent("exception", {
      "exception.type": error?.name ?? "Error",
      "exception.message": error?.message ?? String(error),
      ...(error?.stack ? { "exception.stacktrace": error.stack } : {})
    });
    this.setStatus("error", error?.message ?? String(error));
    return this;
  }

  setStatus(code, message = "") {
    this.status = code === "error" ? { code: STATUS_ERROR, message } : { code: 1, message: "" };
    return this;
  }

  end() {
    if (this.endNs !== null) return;
    this.endNs = nowNs();
    this.tracer.enqueue(this);
  }

  toOtlp() {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      name: this.name,
      kind: this.kind,
      startTimeUnixNano: String(this.startNs),
      endTimeUnixNano: String(this.endNs ?? nowNs()),
      attributes: attributeList(this.attributes),
      events: this.events.map(event => ({
        timeUnixNano: String(event.timeNs),
        name: event.name,
        attributes: attributeList(event.attributes)
      })),
      status: this.status ?? { code: 0 }
    };
  }
}

/*
 * Tracing off: same shape, nothing recorded, no traceparent.
 */
const NOOP_SPAN = {
  traceId: null,
  spanId: null,
  sampled: false,
  traceparent: null,
  setAttribute() {
    return this;
  },
  setAttributes() {
    return this;
  },
  addEvent() {
    return this;
  },
  recordException() {
    return this;
  },
  setStatus() {
    return this;
  },
  end() {}
};

const NOOP_TRACER = {
  enabled: false,
  startSpan() {
    return NOOP_SPAN;
  },
  async span(_name, _options, fn) {
    return await fn(NOOP_SPAN);
  },
  withSpan(_span, fn) {
    return fn();
  },
  async flush() {},
  async shutdown() {}
};

export { NOOP_TRACER };

function attributeList(attributes) {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: attributeValue(value) }));
}

function attributeValue(value) {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(attributeValue) } };
  return { stringValue: String(value) };
}

function parseKeyValues(text) {
  const result = {};

  for (const part of String(text ?? "").split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    try {
      result[decodeURIComponent(part.slice(0, index).trim())] = decodeURIComponent(part.slice(index + 1).trim());
    }
    catch {
      result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
  }

  return result;
}

const ORIGIN_NS = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();

function nowNs() {
  return ORIGIN_NS + process.hrtime.bigint();
}

function randomHex(bytes) {
  let hex;
  do {
    hex = randomBytes(bytes).toString("hex");
  } while (/^0+$/.test(hex));
  return hex;
}
