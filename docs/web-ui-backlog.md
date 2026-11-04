# Web UI backlog: what the CLI can do and the Web UI can't

Status: proposed · Written: 2026-11-04 (against 2.1.1)

The Web UI covers most of the API: flow and inspectors, stats, deliveries (redrive and discard), versioned config (edit, history, activate), users and roles. This page lists what is still only possible from the CLI or the API, and the proposed Web UI work, in priority order.

## The gaps

| Area | CLI / API | Web UI today |
|---|---|---|
| Plugins | `brainstem plugins list` (installed packages, versions, kind), `plugins add / remove / update`, `brainstem init` | Plugin names on flow nodes only, no versions, no management |
| Permissions | `plugins:read`, `plugins:manage` exist in the role editor | Nothing checks them, so granting them has no effect |
| Config | `config import` (load a `brainstem.config.mjs`), `config export` (as `.mjs` or JSON), `config validate` (check without saving) | Edit JSON in the editor; errors only on save; no upload or download |
| Config schema | `GET /api/config/schema` | Not used: no inline errors or autocomplete in the editor |
| Input schedule | `GET /api/inputs`: next due time, lease owner and epoch, last poll, last error per input | Not shown (input nodes say "polled by core-x") |
| Run now | `brainstem --once` polls every input | No way to poll one input now |
| Ignored decisions | `--all` prints ignored decisions through log destinations | The inspector shows decisions, but there's no equivalent setting |

The following stay CLI-only on purpose:

- **Database maintenance:** `migrate`, `migrate status`, `migrate import-v1`, `migrate copy` / `sqlite-to-pg`. These are one-off admin tasks that run before or outside a running instance. At most, a read-only schema version could be shown on a status page.
- **Process settings:** roles, queues, health ports and drain timeouts belong to how each process is started, not to the shared config.
- **`/metrics`:** it's for Prometheus. The Stats page has its own telemetry.

## 1. Input schedule and "poll now"

**Why:** debugging an input is the most common hands-on task, and the data already exists.

**Web UI:** in the input inspector, add a schedule panel. It shows:

- interval, next due time and last poll;
- the last error, if any;
- the lease: owner core, epoch and how long it's held;
- a "Poll now" button.

The flow node could show a small overdue or error marker.

**API:**

- `GET /api/inputs` already returns the schedule; the inspector reads it.
- Add `POST /api/inputs/{id}/poll`: sets `next_due_at` to now and announces `inputs` on the notifier. Any polling core claims it within milliseconds, by the normal lease rules, so this doesn't bypass fencing.
- Needs `runtime:control`, the same permission as redriving deliveries.
- With timer scheduling (no database pipeline) there's no schedule to change. Return 409 and hide the button.

**Size:** small. One API route, one inspector section, and a test that the poll happens (both dialects).

## 2. Config import, export and live validation

**Why:** moving a config between environments, backing one up before a big change, and catching mistakes before saving.

**Web UI (Settings → Config):**

- **Export:** download the active version, or any version from the history, as `brainstem.config.mjs` or JSON.
- **Import:** upload a JSON file or a config module and store it as a new version, with a note and the same `If-Match` protection as a save.
  - A `.mjs` module can't be evaluated in the browser or API without executing user code ([ADR-0005](adr/0005-config-as-versioned-data.md)).
  - So the UI accepts JSON, and for `.mjs` it shows the command: `brainstem config import --file ...`.
- **Live validation:** validate the editor contents against `GET /api/config/schema` while typing.
  - Show errors inline with their JSON path (`/destinations/2/decisions`).
  - Disable Save while the JSON is invalid.
  - Reuse `src/config/json-schema.mjs` in the browser; it has no dependencies.
- **Diff:** compare the editor contents, or a history version, with the active version before saving or activating.

**API:**

- `GET /api/config/versions/{id}?format=mjs|json` with `Content-Disposition` for downloads. The export logic already exists in `src/config/source.mjs` (`configModuleSource`).
- Import uses `PUT /api/config` as it is now.

**Size:** small to medium. Mostly UI; the validator and the export function already exist.

## 3. Plugins page

**Why:** see which plugins and versions each core runs, and manage plugins on a single-node npm install without a terminal.

**Web UI (Settings → Plugins):**

- **Installed** (`plugins:read`): a table of every package with:
  - version and kind (input or destination);
  - source (plugin folder or built in);
  - whether the active config uses it;
  - which cores have it.

  It flags version differences between cores, and config entries that refer to a plugin no core has.
- **Manage** (`plugins:manage`), only where it can work, which is a single `role all` process on an npm install with npm available:
  - add (package name or `name@version`), update, remove;
  - removing asks for confirmation when the config still uses the package.

  The output of npm is streamed into the page.
- **In Docker and Kubernetes,** plugins are baked into the image and every core must run the same set. There the page is read-only, with a link to the custom-image docs ([Plugins](plugins.md#docker-and-kubernetes)).

**Runtime and API:**

- **Cores report their plugins:** each core adds `{ name, version, kind, source }` for its plugin folder and built-ins to its registry row (the `topology` it already reports). This needs no migration, since the topology is stored as JSON.
- `GET /api/plugins` merges the cores' reports with the active config's `module` references.
- `POST /api/plugins` (`add`, `update`, `remove`) runs the same code as `brainstem plugins`, `src/cli/plugins.mjs`. It works only in the process that owns the plugin folder; elsewhere it returns 409, with the reason.
  - After a change, the process reloads its config so new plugins load without a restart.
  - The install is verified, and rolled back when the package is not a plugin, exactly like the CLI.
- **Security:** installing a package runs code on the server. Keep it behind `plugins:manage`, which only Administrator has by default. Log every action with the user (telemetry event `brainstem.plugins.changed`).
  - An option to turn management off entirely: `runtime.plugins.manage: false`, or `BRAINSTEM_PLUGINS_MANAGE=false`.

**Size:** medium to large. The core report and the read-only page are the first step; management is the second.

## Smaller items

- **Ignored decisions:** a filter in the core inspector ("show ignored") rather than a setting, since `--all` only exists for log output.
- **Schema version:** show `brainstem migrate status`, read-only, next to the core versions in the Cores panel. It can warn when cores run a newer schema than the API, or the other way round.
- **README screenshots:** retake them now that the Web UI shows the logo (same demo setup as for 2.0, [release notes](../CHANGELOG.md)).
