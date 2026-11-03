# 0009. In-house Prometheus metrics and OTLP tracing, no client libraries

- Status: Accepted
- Date: 2026-11-03

## Context

Phase 4 (roadmap §5) needs Prometheus metrics for KEDA, alerts and dashboards, and OpenTelemetry traces that follow one envelope across `poll → decide → deliver` on different cores.

The usual route is `prom-client` plus the OpenTelemetry JS SDK (`@opentelemetry/sdk-node`, an exporter, context propagation and often auto-instrumentation). The SDK alone pulls in dozens of packages. Auto-instrumentation patches `http`, `pg` and others at load time, and the SDK's context manager has to be configured before any other module loads.

Brainstem only needs a little of this:

- counters, gauges and histograms in the text exposition format;
- manual spans at three points (poll, decide job, deliver job);
- a W3C `traceparent` carried in job payloads (the pipeline stages are queue hops, not HTTP calls, so auto-instrumentation would not connect them anyway);
- OTLP export.

The project already prefers small in-house modules where the need is narrow: the queue ([ADR-0003](0003-kysely-and-in-house-queue.md)) and the JSON Schema validator.

## Decision

- `src/observability/metrics.mjs` is a small Prometheus registry (counter, gauge, histogram, scrape-time collectors), served on `GET /metrics` by the API and the core health server.
- `src/observability/tracing.mjs` is a minimal tracer. It provides spans with W3C `traceparent` parsing and formatting and `AsyncLocalStorage` for the active span (which logs read for `trace_id`/`span_id`). It exports batches as OTLP/HTTP JSON, configured by the standard `OTEL_*` environment variables.
- Each pipeline stage stores its `traceparent` in the payload of the jobs it enqueues (`payload.trace`) and gives it to destinations as `ctx.traceparent`.

## Alternatives considered

- **prom-client + OpenTelemetry SDK**: rejected for now. It brings many dependencies and a load-order-sensitive setup for three manual spans. Nothing in the in-house format prevents switching later: the metric names, span names and attributes are the contract.
- **OTLP over gRPC or protobuf**: not supported. Every common receiver (the Collector, Jaeger, Tempo and most vendors) accepts OTLP/HTTP JSON on 4318.
- **Trace context as a `jobs` column**: rejected. Payloads are already versionless JSON, and a column would need a migration for an optional value.

## Consequences

Positive:

- no new dependencies, and nothing patched at load time; with tracing off it costs nothing and nothing is stored in jobs;
- one trace per envelope across cores, including handoffs back to the core;
- metric names are stable and documented ([Observability](../observability.md)), and KEDA, alerts and the dashboard build on them.

Negative:

- no automatic spans for outgoing HTTP or SQL inside a stage; plugins only get the context (`ctx.traceparent`);
- the exporter speaks only OTLP/HTTP JSON, and drops spans when the collector is unreachable (by design: tracing never slows down the pipeline).

Follow-ups:

- Phase 5 load tests tune the KEDA thresholds against these metrics.
