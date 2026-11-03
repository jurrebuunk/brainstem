# Kubernetes

The Helm chart in [`charts/brainstem`](../charts/brainstem) runs Brainstem on Kubernetes in one of two modes:

| Mode | Runs | Database |
|---|---|---|
| `single` | one `role all` pod (inputs, decisions, deliveries and the API) and the Web UI | SQLite on a volume, or Postgres |
| `cluster` (default) | the API, the Web UI and core Deployments in worker groups | Postgres: external, or CloudNativePG |

Cluster mode is the [cluster mode](cluster.md) process model on Kubernetes: every pod is a core in the registry, any core can do any piece of work, and losing a pod or a node loses no observations.

```
                   [Ingress]  TLS · SSE timeouts
                       │
                   web ×2  ── /api ──▶  api ×2-6 (HPA: CPU)
                                          │
   core-poll ×2 ─┬─ core-decide ×2-N ─┬─ core-deliver ×2-N   (KEDA: due jobs + oldest age)
                 │   (model image)    │
                 └──── Postgres (CloudNativePG or managed) ────┘
     Prometheus ◀── /metrics      OTLP collector ◀── traces
```

## Install

The chart is published as an OCI artifact with every release:

```sh
helm install brainstem oci://ghcr.io/jurrebuunk/charts/brainstem --version 2.0.0 -f values.yaml
```

From a checkout: `helm install brainstem ./charts/brainstem -f values.yaml`.

### Single node

```yaml
mode: single
ingress:
  enabled: true
  className: nginx
  hosts: [{host: brainstem.example.com, paths: [{path: /, pathType: Prefix}]}]
  tls: [{secretName: brainstem-tls, hosts: [brainstem.example.com]}]
```

SQLite lives on a 5 Gi PersistentVolumeClaim (kept on uninstall). Set `database.url` or `database.existingSecret` to use Postgres instead. The pod is a single replica with the `Recreate` strategy, because one process owns the database file.

### Cluster on an existing Postgres

```sh
kubectl create secret generic brainstem-db --from-literal=url=postgres://brainstem:...@db:5432/brainstem
```

```yaml
mode: cluster
database:
  existingSecret: brainstem-db
envFrom:
  - secretRef: {name: brainstem-plugin-secrets}   # GITHUB_TOKEN, MATRIX_ACCESS_TOKEN, ...
cores:
  groups:
    - {name: poll, queues: [poll]}
    - name: decide
      queues: [decide]
      decideConcurrency: 2
      autoscaling: {enabled: true, maxReplicas: 6}
    - name: deliver
      queues: [deliver]
      autoscaling: {enabled: true, maxReplicas: 10}
```

`LISTEN/NOTIFY` and advisory locks need a direct connection or a session-mode pooler, not a PgBouncer transaction pool.

### Cluster with CloudNativePG

With the [CloudNativePG](https://cloudnative-pg.io) operator installed, `cnpg.enabled: true` creates a Postgres `Cluster` for the release (3 instances by default), and Brainstem connects with the generated `<release>-brainstem-pg-app` secret.

## Worker groups

`cores.groups` lists Deployments named `<release>-brainstem-core-<name>`. Each runs the stages in `queues`; any field it leaves out comes from `cores.defaults`.

| Stage | Work | Sizing |
|---|---|---|
| `poll` | claims due inputs by lease and polls them | small; scale for HA, or with `autoscaling.type: hpa` |
| `decide` | Laya decisions | memory for the model (~1.5 GB plus about 0.5 GB per `decideConcurrency`) |
| `deliver` | destinations: slow external calls, retries | small; scale on backlog |

The default is a single group, `all`, running every stage. That's fine for small setups. Split the stages when one becomes the bottleneck, or so that only some pods pay for the model's memory. Groups without `decide` get `cores.defaults.resourcesWithoutModel` unless they set `resources`.

Every pod uses its pod name as its core id, so the Cores panel in the Web UI shows `release-brainstem-core-decide-7d9f…`, along with its queues and config version.

## Autoscaling

`autoscaling.type: keda` (the default for a group) creates a KEDA `ScaledObject` with two triggers over the queues the group runs (`decide`, `deliver`):

- **ready**: due jobs waiting for a core, one replica per `readyPerReplica` (20);
- **oldest-age**: seconds the oldest due job has waited, one replica per `oldestAgeSeconds` (60).

The default `trigger: postgresql` queries the `jobs` table through a `TriggerAuthentication` built on the database secret, so no Prometheus is needed. `trigger: prometheus` uses `brainstem_queue_ready` and `brainstem_queue_oldest_age_seconds` instead. Keep `minReplicas` at 2 or more for HA; scaling to zero isn't worth it for a monitoring runtime. A poll-only group has no queue to scale on, so use `type: hpa` (CPU) for it. The API scales with an HPA on CPU (`api.autoscaling`).

KEDA must be installed. Roadmap §5 discusses the thresholds.

## The model

Decide pods (and the single pod) mount the Laya model from the `brainstem-models` image ([ADR-0006](adr/0006-model-distribution-oci-image.md)), so nothing is downloaded when a pod starts, which matters for autoscaling:

- `models.mount: initContainer` (default) copies it into an `emptyDir` and works on every cluster.
- `models.mount: imageVolume` mounts the image directly (Kubernetes ≥ 1.33 with the `ImageVolume` feature, on by default from 1.35).

`models.enabled: false` falls back to downloading about 1.9 GB per pod on first start.

## Config

| `config.source` | Behaviour |
|---|---|
| `database` (default) | Versioned config in the database, edited in the Web UI. Every core reloads the active version without a restart. `config.file` seeds the store: `config.import: onInstall` stores it only while no version exists, `always` stores it on every upgrade (a no-op when unchanged), `never` leaves versions to you. |
| `file` | `config.file` (or `config.existingConfigMap`) is the config, and the UI is read-only (GitOps). Changing it rolls the pods. |

`config.file` is a `brainstem.config.mjs` module. The default reuses the image's example pipeline, which has a log destination and no inputs. Leave bootstrap settings (database, logging, API) out: the chart provides them through the environment. In `file` mode a pod that polls exits if the config has no inputs.

## Plugins

The image contains every built-in plugin, so configs can use any `@brainstem-dev/plugin-*` package. For third-party plugins, build an image on top of it with those packages in `/app/brainstem-plugins` ([Plugins](plugins.md#docker-and-kubernetes)), and point `image.repository`/`image.tag` at it. All pods then run the same plugins, which cluster mode needs.

## Migrations

Cluster pods never migrate. A Job runs `brainstem migrate` first: a `pre-install`/`pre-upgrade` hook with an external database, or a regular Job per revision with CloudNativePG (whose database doesn't exist yet at pre-install). API and core pods wait for the schema (`migrations.schemaWaitSeconds`, `BRAINSTEM_SCHEMA_WAIT_MS`) instead of crash-looping, and their startup probes allow for that wait. For Argo CD, the hook annotations map onto `PreSync`/`PostSync`.

## Probes, drain and disruption

- **Startup** `/startupz`: the schema is checked, plugins are loaded and, for decide pods, the model is loaded.
- **Readiness** `/readyz`: the database is reachable and the pod is not draining.
- **Liveness** `/livez`: the event loop is alive. It never touches the database, so a database outage doesn't restart pods.
- On deletion a core sleeps `preStopSleepSeconds` (8), then drains on SIGTERM: it stops claiming, lets in-flight work finish for `drainTimeoutMs` (45 s), releases its leases and marks itself stopped. `terminationGracePeriodSeconds` (75) covers both.
- PodDisruptionBudgets (`maxUnavailable: 1`) and topology spread over nodes and zones on every Deployment with more than one replica.

## Security

- non-root uid 1000, read-only root filesystem with `emptyDir` `/tmp` and `/app/data`, all capabilities dropped, `seccompProfile: RuntimeDefault`;
- one ServiceAccount per role with no token mounted: Brainstem never calls the Kubernetes API;
- `networkPolicy.enabled: true`: default-deny for Brainstem pods, with what they need allowed.
  - Web: from the ingress (`networkPolicy.webFrom`), to the API.
  - API: from web, cores and Prometheus, to Postgres.
  - Cores: from Prometheus, to Postgres, the API and anywhere (`networkPolicy.coreEgress`, inputs and destinations).
  - Jobs: to Postgres only.
  - Extra egress, such as an OTLP collector, goes in `networkPolicy.extraEgress`.
- a machine token for telemetry, generated once and kept in `<release>-brainstem-api-token`;
- images are multi-arch (amd64, arm64), signed with cosign (keyless), and come with SBOM and provenance attestations. Verify them with:

```sh
cosign verify ghcr.io/jurrebuunk/brainstem:v2.0.0 \
  --certificate-identity-regexp 'https://github.com/jurrebuunk/brainstem/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Observability

`metrics.serviceMonitor.enabled` scrapes the API and every core, `metrics.prometheusRule.enabled` adds alerts, and `metrics.grafanaDashboard.enabled` ships the dashboard as a ConfigMap for the Grafana sidecar. `tracing.endpoint` sends OTLP traces. See [Observability](observability.md).

## Values

The values the chart supports are documented in [`values.yaml`](../charts/brainstem/values.yaml) and checked by [`values.schema.json`](../charts/brainstem/values.schema.json), so a typo fails at install time. The ones you will usually set:

| Value | Default | |
|---|---|---|
| `mode` | `cluster` | `single` or `cluster` |
| `database.existingSecret` / `database.url` | – | Postgres URL (cluster mode requires one, or `cnpg.enabled`) |
| `cnpg.enabled` | `false` | run Postgres with CloudNativePG |
| `config.source` / `config.import` / `config.file` | `database` / `onInstall` / example | see [Config](#config) |
| `cores.groups` | one group `all` | worker groups |
| `cores.defaults.autoscaling` | off, KEDA | per group |
| `models.mount` | `initContainer` | or `imageVolume` |
| `ingress.*` | off | routes to the Web UI, with SSE-friendly nginx annotations |
| `networkPolicy.enabled` | `false` | default-deny policies |
| `metrics.serviceMonitor/prometheusRule/grafanaDashboard.enabled` | `false` | Prometheus Operator and Grafana |
| `tracing.endpoint` | – | OTLP/HTTP collector |
| `envFrom` | – | plugin secrets |

## Testing the chart

CI (`.github/workflows/chart.yml`) runs `helm lint`, [helm-unittest](../charts/brainstem/tests) and `ct lint`, validates the rendered manifests for several Kubernetes versions with kubeconform (CRDs included), then runs `ct install` on kind with CloudNativePG and KEDA for each [`ci/*-values.yaml`](../charts/brainstem/ci). That includes `helm test`, which checks the API is ready, a core runs and the Web UI proxies to the API. The same install works locally:

```sh
kind create cluster
docker build -t brainstem:dev . && kind load docker-image brainstem:dev
kubectl apply --server-side -f https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v1.27.1/cnpg-1.27.1.yaml
kubectl apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.18.1/keda-2.18.1.yaml
helm install bs charts/brainstem -f charts/brainstem/ci/cluster-values.yaml \
  --set image.repository=brainstem --set image.tag=dev --set image.pullPolicy=Never
helm test bs
```

## Uninstalling

`helm uninstall` leaves the following behind:

- the single-mode data volume (`helm.sh/resource-policy: keep`);
- the database Secret created from `database.url`, because it is a hook resource;
- with CloudNativePG, its PersistentVolumeClaims, as the operator decides.

Delete them by hand when you are sure.
