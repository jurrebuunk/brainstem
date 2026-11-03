import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { openMigratedDatabase } from "../db/index.mjs";
import { validateConfigSpec } from "../config/schema.mjs";
import { configModuleSource, loadConfigFile, specFromConfig } from "../config/source.mjs";
import { createConfigVersionStore } from "../config/versions.mjs";

export const CONFIG_USAGE = `Usage:
  brainstem config import [--file path] [--comment text] [--author name] [--no-activate]
  brainstem config export [--version id] [--out path] [--format mjs|json]
  brainstem config list
  brainstem config show [id]
  brainstem config activate <id>
  brainstem config validate [--file path]

Config as versioned data (docs/configuration.md#versioned-config):

  import    Evaluate a config module here, check it is plain data that
            matches the schema, and store it as a new version (active
            unless --no-activate). Running cores reload it when they run
            with BRAINSTEM_CONFIG_SOURCE=database. Bootstrap settings
            (runtime.database, api, logging, telemetry, coreId, role,
            queues) stay per process and are not stored.
  export    Write a version (default: the active one) as a config module
            (--format mjs, default) or JSON. Without --out it is printed.
  activate  Point every core at an existing version (rollback).
  validate  Check a config module without a database.

--file defaults to --config, then brainstem.config.mjs. The database
comes from --database, then the config file, then
BRAINSTEM_DATABASE_URL.
`;

export async function runConfig(positionals, options, io) {
  const [action, ...rest] = positionals;

  if (options.help || !action) {
    io.out(CONFIG_USAGE);
    return action || options.help ? 0 : 2;
  }

  const file = resolve(options.file ?? options.config ?? process.env.BRAINSTEM_CONFIG ?? "brainstem.config.mjs");

  switch (action) {
    case "validate": {
      const loaded = await loadSpec(file, io);
      if (!loaded) return 1;
      io.out(`${file} is a valid config (${describe(loaded.spec)}).`);
      return 0;
    }

    case "import":
      return withStore(options, io, async store => {
        const loaded = await loadSpec(file, io);
        if (!loaded) return 1;

        const version = await store.create(loaded.spec, {
          author: options.author ?? process.env.USER ?? null,
          comment: options.comment ?? `imported from ${file}`,
          activate: !options["no-activate"]
        });

        if (version.unchanged) {
          io.out(`Unchanged: the active version ${version.id} already has this config.`);
        }
        else {
          io.out(`Stored config version ${version.id}${options["no-activate"] ? "" : " (active)"}: ${describe(loaded.spec)}.`);
        }

        if (loaded.left.length > 0) {
          io.out(`Kept per process, not stored: ${loaded.left.join(", ")}.`);
        }

        return 0;
      });

    case "export":
      return withStore(options, io, async store => {
        const version = options.version ? await store.get(options.version) : await store.active();

        if (!version) {
          io.err(options.version ? `Config version ${options.version} does not exist.` : "No active config version. Import one with: brainstem config import");
          return 1;
        }

        const format = options.format ?? (options.out?.endsWith(".json") ? "json" : "mjs");
        if (!["mjs", "json"].includes(format)) {
          io.err(`Unknown --format '${format}'. Use mjs or json.`);
          return 2;
        }

        const content = format === "json"
          ? `${JSON.stringify(version.spec, null, 2)}\n`
          : configModuleSource(version.spec, { version });

        if (options.out) {
          await writeFile(resolve(options.out), content);
          io.out(`Wrote config version ${version.id} to ${options.out}.`);
        }
        else {
          io.out(content.trimEnd());
        }

        return 0;
      });

    case "list":
      return withStore(options, io, async store => {
        const versions = await store.list({ limit: 50 });

        if (versions.length === 0) {
          io.out("No config versions yet. Import one with: brainstem config import");
          return 0;
        }

        for (const version of versions) {
          io.out(`${version.active ? "*" : " "} ${String(version.id).padStart(4)}  ${version.createdAt}  ${version.author ?? "-"}  ${version.comment ?? ""}`);
        }

        return 0;
      });

    case "show":
      return withStore(options, io, async store => {
        const version = rest[0] ? await store.get(rest[0]) : await store.active();

        if (!version) {
          io.err(rest[0] ? `Config version ${rest[0]} does not exist.` : "No active config version.");
          return 1;
        }

        io.out(JSON.stringify(version, null, 2));
        return 0;
      });

    case "activate":
      return withStore(options, io, async store => {
        if (!rest[0]) {
          io.err(`activate needs a version id.\n\n${CONFIG_USAGE}`);
          return 2;
        }

        const active = await store.activate(rest[0], { author: options.author ?? process.env.USER ?? null });
        io.out(`Config version ${active.id} is now active.`);
        return 0;
      });

    default:
      io.err(`Unknown config action: ${action}\n\n${CONFIG_USAGE}`);
      return 2;
  }
}

async function loadSpec(file, io) {
  const config = await loadConfigFile(file);

  if (!config) {
    io.err(`Config file not found: ${file}`);
    return null;
  }

  const { spec, left } = specFromConfig(config);
  const errors = validateConfigSpec(spec);

  if (errors.length > 0) {
    io.err(`${file} is not a valid config:\n  ${errors.join("\n  ")}`);
    return null;
  }

  return { spec, left };
}

async function withStore(options, io, fn) {
  let handle;

  try {
    handle = await openMigratedDatabase({ url: options.databaseUrl });
  }
  catch (error) {
    io.err(error.message);
    return 1;
  }

  try {
    return await fn(createConfigVersionStore({ database: handle }));
  }
  catch (error) {
    io.err(error.message);
    return 1;
  }
  finally {
    await handle.close();
  }
}

function describe(spec) {
  return `${spec.inputs?.length ?? 0} inputs, ${spec.destinations?.length ?? 0} destinations`;
}
