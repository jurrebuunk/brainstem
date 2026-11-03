# Observability

Brainstem exposes three kinds of signal: Prometheus metrics, OpenTelemetry traces (one trace per envelope, across cores) and JSON logs that carry the trace id. None of them needs extra dependencies. The metrics registry and the OTLP exporter are small in-house modules ([ADR-0009](adr/0009-in-house-metrics-and-tracing.md)).

The [runtime telemetry](telemetry.md) events that feed the Web UI are separate from these signals.

## Metrics

`GET /metrics` serves the Prometheus text format:

| Process | Where | What |
|---|---|---|
| `--role api` | the API port (`5174`) | process metrics plus **cluster-wide** queue, core, input and delivery gauges, read from the database (cached 5 s) |
| `--role core` | the health port (`--health-port`, `8081`) | process metrics plus this core's work |
| `--role all` | the API port when the API is on, otherwise `--health-port` | everything |

Every API replica reports the same cluster gauges, so aggregate them with `max()`. Keep `/metrics` off the public ingress (the chart's ingress routes only to the Web UI), or set `BRAINSTEM_METRICS_TOKEN` to require `Authorization: Bearer <token>`. `BRAINSTEM_METRICS=false` turns the endpoint off.

### Cluster (from the API)

| Metric | Labels | |
|---|---|---|
| `brainstem_queue_ready` | `queue` | due jobs waiting for a core (KEDA scales on this) |
| `brainstem_queue_oldest_age_seconds` | `queue` | age of the oldest due job, 0 when none |
| `brainstem_queue_delayed` | `queue` | jobs waiting for a retry backoff |
| `brainstem_queue_running` | `queue` | claimed jobs |
| `brainstem_queue_dead` | `queue` | jobs out of attempts (redrive them in the Web UI) |
| `brainstem_cores` | `status` | registered cores: `running`, `lost`, `stopped` |
| `brainstem_cores_running` | `queue` | running cores per stage they serve |
| `brainstem_inputs` | `state` | scheduled inputs: `idle`, `due`, `leased` |
| `brainstem_input_schedule_lag_seconds` | – | how long the most overdue unleased input has been due |
| `brainstem_deliveries` | `status` | delivery log rows by status |

### Per core

| Metric | Labels | |
|---|---|---|
| `brainstem_polls_total` | `input`, `outcome` | `ok` or `failed` poll attempts |
| `brainstem_poll_duration_seconds` | `input` | histogram, including the commit |
| `brainstem_observations_total` | `input` | observations stored as decide jobs |
| `brainstem_input_lease_lag_seconds` | `input` | how late this core claimed the input after it came due |
| `brainstem_decisions_total` | `decision` | `ignore`, `queue`, `dispatch`, `escalate`, … |
| `brainstem_job_duration_seconds` | `queue`, `outcome` | histogram; `ok`, `retry`, `dead`, `lease_lost`, `released` |
| `brainstem_job_failures_total` | `queue`, `dead` | failed attempts; `dead="true"` when out of attempts |
| `brainstem_deliveries_total` | `destination`, `plugin`, `outcome` | `delivered`, `skipped` (already delivered), `failed`, `dead` |
| `brainstem_jobs_inflight` | `queue` | jobs running on this core |
| `brainstem_core_info` | `core_id`, `role`, `queues` | always 1 |
| `brainstem_core_draining` | – | 1 while draining for shutdown |

Process metrics: `brainstem_build_info{version,role}`, `process_cpu_seconds_total`, `process_resident_memory_bytes`, `process_start_time_seconds`, `nodejs_heap_used_bytes`, `nodejs_heap_size_total_bytes`, and `nodejs_eventloop_lag_p99_seconds` / `_max_seconds` (since the previous scrape).

Label values come from the config (input and destination ids, plugin names), never from observation data, so cardinality stays bounded.

### Alerts

The Helm chart's `PrometheusRule` (`metrics.prometheusRule.enabled`) defines:

| Alert | Fires when |
|---|---|
| `BrainstemNoHealthyCore` (critical) | a stage has no running core for 2 minutes |
| `BrainstemApiDown` (critical) | no API replica can be scraped for 5 minutes |
| `BrainstemQueueBacklog` | the oldest due job is older than `queueAgeSeconds` (300) for 10 minutes |
| `BrainstemDeliveryFailures` | more than `deliveryFailureRatio` (20 %) of a destination's attempts fail over 15 minutes |
| `BrainstemDeadJobs` | dead jobs wait for 15 minutes |
| `BrainstemInputsOverdue` | an input has been due for over `inputLagSeconds` (300) with no core claiming it |
| `BrainstemEventLoopLag` | a pod's p99 event-loop delay is over 1 s for 10 minutes |

Outside Kubernetes, copy the expressions from [`prometheusrule.yaml`](../charts/brainstem/templates/prometheusrule.yaml).

### Grafana

[`charts/brainstem/dashboards/brainstem.json`](../charts/brainstem/dashboards/brainstem.json) has the following panels:

- **overview**: cores, due jobs, oldest job, dead jobs, decisions per minute;
- **queues**: depth, age, running jobs, cores per stage;
- **pipeline**: decisions, deliveries by outcome, job p95, failures;
- **inputs**: polls, observations, poll p95, schedule lag;
- **pods**: event-loop lag, memory, CPU, in-flight jobs.

Import the file, or set `metrics.grafanaDashboard.enabled` to ship it as a ConfigMap labelled for the Grafana sidecar.

## Tracing

Set an OTLP/HTTP endpoint and every envelope becomes one trace:

```
poll <input>            (root, the core that polled)
└─ decide               (the core that decided; continues from the decide job)
   ├─ deliver <dest>    (the core that delivered; continues from the deliver job)
   └─ deliver <dest>
      └─ decide          (an observation the destination handed back, ctx.emit)
```

Each stage stores its W3C `traceparent` in the jobs it enqueues, so the trace continues on whichever core claims the next job. Destinations receive it as `ctx.traceparent`; the `http-json` destination forwards it as the `traceparent` header, so a receiving service can join the trace. Spans carry `brainstem.*` attributes: input, observation and delivery ids, the decision, the destination, the job attempt and the core id. Failures are recorded as exception events.

Tracing uses the standard environment:

| Variable | |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | e.g. `http://otel-collector:4318`; `/v1/traces` is appended |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | full traces URL (wins) |
| `OTEL_EXPORTER_OTLP_HEADERS` | `key=value,key2=value2` (URL-encoded values) |
| `OTEL_SERVICE_NAME` | default `brainstem-<role>` |
| `OTEL_RESOURCE_ATTRIBUTES` | extra resource attributes |
| `OTEL_TRACES_SAMPLER_ARG` | sampling ratio for new traces (default 1); child spans follow their parent |
| `OTEL_SDK_DISABLED=true` | off |

Without an endpoint, tracing is off: nothing is recorded and nothing is added to jobs. Brainstem only exports OTLP over HTTP as JSON. The OpenTelemetry Collector, Jaeger, Grafana Tempo and most vendors accept it on port 4318. An exporter that can't reach the collector logs one warning per outage and drops the spans; the pipeline is never slowed down or failed by tracing.

In the Helm chart, `tracing.endpoint` sets these variables and adds `k8s.namespace.name` and `k8s.pod.name`.

## Logs

With `BRAINSTEM_LOG_FORMAT=json` (the chart's default), each log line is one JSON object. Lines written inside a span carry `trace_id` and `span_id`, so a log query can jump to the trace and back:

```json
{"timestamp":"…","level":"info","message":"observation decided","observationId":"ci:disk","decision":"escalate","trace_id":"f4493e3bd5c25d5e91a199ae356b52aa","span_id":"a825982a…"}
```

## Docker Compose

`docker compose -f docker-compose.cluster.yml --profile observability up -d` also starts Prometheus (`:9090`, scraping the API and every core replica) and Jaeger (`:16686`). Put `OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318` in `.env` to send traces to it. See [Docker](docker.md#cluster-mode).
