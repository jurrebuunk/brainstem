# 0010. Plugins are npm packages in a managed plugin folder

- Status: Accepted
- Date: 2026-11-03

## Context

Up to 2.0 the plugin loader only accepted file paths (`./plugins/matrix/index.mjs`). The built-in plugins lived inside the app, imported its source by relative path (`../../src/sdk`), and their dependencies (`imapflow`, `mailparser`, the agentOS runtime) were the app's dependencies. A plugin could not be installed, versioned or removed on its own, and third-party plugins had no supported way in.

The goal: the app installable from npm, every plugin an npm package, a few installed by default but still removable and reinstallable like any other.

## Decision

- One repository with npm workspaces:
  - `@brainstem-dev/brainstem`: the app, at the root;
  - `@brainstem-dev/sdk`: the plugin API and test kit, with no dependencies;
  - `@brainstem-dev/plugin-<name>`: one package per built-in plugin, with its own dependencies and the SDK as a peer dependency.
- Plugins are installed into a **plugin folder** (`BRAINSTEM_PLUGINS_DIR`, default `./brainstem-plugins`), a small npm project managed by `brainstem plugins add|remove|update` (which run npm in it).
  - `brainstem init` installs the default set there, pinned to the app's version.
  - The defaults are **not** dependencies of the app, because npm would then reinstall anything a user removed.
- The config names plugins by package (`module: "@brainstem-dev/plugin-matrix"`). The loader looks in the plugin folder, then next to the working directory, then next to Brainstem. Paths still work, and the built-ins' 1.x paths map to their packages.
- Containers don't install at runtime. The image contains every built-in plugin (as workspace packages), and other plugins go into a derived image.
- All packages share one version and are published together from the release tag, with provenance (`scripts/npm-publish.mjs`).

## Alternatives considered

- **Built-ins as dependencies of the app**: rejected. They can't be removed, and every install pulls in every plugin's dependencies.
- **Installing plugins listed in the config at start-up**: rejected for containers. It makes starts slow and fragile and needs npm and network in the pod, and unpinned packages can change under a running cluster. A signed image with the plugins baked in is the 2.0 deployment model.
- **Independent versions per package (changesets)**: not now. Lockstep versions keep `brainstem init` (plugins at the app's version) and the release simple while everything lives in one repository. It can change later without affecting users.
- **A separate repository per plugin**: rejected for the built-ins. They change together with the runtime and share CI.

## Consequences

Positive:

- Users install only the plugins they use, with only those plugins' dependencies.
- Third-party plugins are ordinary npm packages: `brainstem plugins add brainstem-plugin-x`, built on a small SDK with a test kit.
- Existing configs (path-based) keep working.

Negative:

- `brainstem plugins` needs npm on the machine. The runtime image has none (2.0 removed it), so containers use the derived-image pattern.
- The SDK is a peer dependency, so a plugin folder gets its own copy next to the app's. That's harmless, because the SDK holds no shared state the runtime relies on, but plugins must not depend on identity checks (`instanceof`) across the boundary.

Follow-ups:

- JSON Schemas for plugin configs, used in config validation and, later, generated forms in the Web UI.
