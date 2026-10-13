# 0005. Config as versioned, JSON-Schema-validated data

- Status: Accepted
- Date: 2026-10-13

## Context

Config today is an executable `brainstem.config.mjs` file that the API writes on `PUT /api/config` (`src/backend/config-store.mjs`). That causes three problems:

- **Code-execution surface.** Anyone with `config:write` can submit JavaScript that the runtime then executes.
- **No versioning or audit.** There is no history, no rollback and no protection against concurrent edits.
- **No propagation.** A file on one pod's disk cannot reach N stateless pods, and there is no hot reload.

GitOps users still want to keep config in a repository, and secrets are already passed by env indirection (`passwordEnv`, `tokenEnv`).

## Decision

Config is versioned data in the database:

- `config_versions(id, created_at, author, spec jsonb, schema_version, comment)` plus an `active_config` pointer.
- The UI saves a new version with `If-Match` optimistic concurrency. Every version is validated by **JSON Schema**, and user-submitted JS is never executed.
- All pods hot-reload on a `config_changed` notification. Rollback means re-pointing to an older version. Every change leaves an audit trail.
- `brainstem.config.mjs` becomes an import/export format via `brainstem config import|export`. The operator evaluates the module locally, and it must export plain data.
- `configSource: file` (Helm) / `BRAINSTEM_CONFIG_SOURCE=file` makes the UI read-only for GitOps users.
- Secrets stay as env indirection, mapped to Kubernetes Secrets.

## Alternatives considered

- **Keep the API-written `.mjs` file** — rejected. It keeps the code-execution surface and cannot be shared across pods.
- **Shared config file (volume or ConfigMap) as the only source** — rejected as the default. Edits from the UI cannot be propagated to N pods, and there is no versioning or optimistic concurrency. It stays supported as the read-only `configSource: file` mode.

## Consequences

Positive:

- Removes the RCE surface behind `config:write`.
- History, audit trail, rollback and safe concurrent edits.
- Consistent config across all pods without restarts.
- GitOps stays possible via import/export and file mode.

Negative:

- Users with JS logic in their config must convert it to plain data. This is covered in the 1.x → 2.0 upgrade guide.
- A JSON Schema must be maintained alongside the config shape, including plugin options.

Follow-ups:

- Config as versioned data, JSON Schema, hot reload, `config import|export` (Phase 3).
- `configSource` value in the Helm chart (Phase 4).
- Upgrade guide section for JS-based configs (Phase 5).
