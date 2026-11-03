# Brainstem Helm chart

Runs [Brainstem](https://github.com/jurrebuunk/brainstem) on Kubernetes:

- `mode: single`: one `role all` pod plus the Web UI, SQLite on a volume (or Postgres);
- `mode: cluster` (default): API, Web UI and core worker groups on Postgres, optionally autoscaled by KEDA, with CloudNativePG, network policies, a ServiceMonitor, alerts and a Grafana dashboard.

```sh
# cluster mode on an existing Postgres
kubectl create secret generic brainstem-db --from-literal=url=postgres://brainstem:...@db:5432/brainstem
helm install brainstem oci://ghcr.io/jurrebuunk/charts/brainstem --set database.existingSecret=brainstem-db

# single node, SQLite
helm install brainstem oci://ghcr.io/jurrebuunk/charts/brainstem --set mode=single
```

Then `kubectl port-forward svc/brainstem-web 5173:80` and open http://localhost:5173 to create the first admin.

The full guide is [docs/kubernetes.md](../../docs/kubernetes.md): worker groups, autoscaling, the model image, config sources, migrations, security and testing. [docs/observability.md](../../docs/observability.md) covers metrics, alerts, the dashboard and traces. Every value is described in [values.yaml](values.yaml) and validated by [values.schema.json](values.schema.json).

## Development

```sh
helm lint . --set database.url=postgres://u:p@pg/b
helm plugin install https://github.com/helm-unittest/helm-unittest
helm unittest .
ct lint --charts . --validate-maintainers=false
```

`ci/*-values.yaml` are installed by `ct install` in CI (kind with CloudNativePG and KEDA).
