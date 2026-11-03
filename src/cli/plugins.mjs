import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../../package.json" with { type: "json" };
import {
  BUILTIN_PLUGINS,
  PLUGIN_SCOPE,
  loadDestinationPlugin,
  loadInputPlugin,
  pluginsDir,
  readPluginManifest
} from "../runtime/plugin-loader.mjs";

/*
 * Plugins are npm packages installed into the plugin folder
 * (BRAINSTEM_PLUGINS_DIR, default ./brainstem-plugins), a small npm
 * project of its own. `init` creates it with the default plugins;
 * `plugins add|remove|update` run npm in it, so any npm spec works
 * (a name, name@version, a tarball, a git URL).
 */
export const DEFAULT_PLUGINS = [
  "http-health",
  "tls-certificate",
  "github-issues",
  "log-file",
  "static-observations",
  "http-json",
  "log-decisions",
  "matrix"
];

const BRAINSTEM_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export const PLUGINS_USAGE = `Usage:
  brainstem init [--plugins-dir path] [--no-defaults]
  brainstem plugins list [--plugins-dir path]
  brainstem plugins add <package...> [--plugins-dir path]
  brainstem plugins remove <package...> [--plugins-dir path]
  brainstem plugins update [package...] [--plugins-dir path]

Plugins are npm packages. They live in the plugin folder: --plugins-dir,
BRAINSTEM_PLUGINS_DIR, or ./brainstem-plugins. Use them in the config
by package name:

  { id: "ops-room", module: "@brainstem-dev/plugin-matrix", ... }

  init     Create brainstem.config.mjs (if missing) and the plugin folder,
           and install the default plugins (${DEFAULT_PLUGINS.join(", ")}).
           --no-defaults installs none.
  list     Installed plugins, plus the ones that ship with Brainstem
           itself (a checkout or the Docker image).
  add      Install plugins: names (@brainstem-dev/plugin-email-imap,
           brainstem-plugin-jira), name@version, tarballs or git URLs.
           Built-in names may be given short: email-imap.
  remove   Uninstall plugins.
  update   Update plugins within their version ranges.

Needs npm on the PATH. In containers, build an image with the plugins
you need instead (docs/plugins.md#docker-and-kubernetes).
`;

export async function runInit(_positionals, options, io) {
  if (options.help) {
    io.out(PLUGINS_USAGE);
    return 0;
  }

  const dir = folder(options);
  const configPath = resolve(options.config ?? process.env.BRAINSTEM_CONFIG ?? "brainstem.config.mjs");

  if (!existsSync(configPath)) {
    await copyFile(join(BRAINSTEM_ROOT, "brainstem.config.example.mjs"), configPath);
    io.out(`Created ${configPath} (from the example config).`);
  }
  else {
    io.out(`Keeping ${configPath}.`);
  }

  await ensureFolder(dir);
  io.out(`Plugin folder: ${dir}`);

  if (options["no-defaults"]) return 0;

  const specs = DEFAULT_PLUGINS.map(name => `${PLUGIN_SCOPE}/plugin-${name}@${packageJson.version}`);
  io.out(`Installing the default plugins: ${DEFAULT_PLUGINS.join(", ")}`);

  const code = await npm(["install", ...specs], dir, io);
  if (code !== 0) {
    io.err(`npm failed (exit ${code}). Retry with: brainstem plugins add ${DEFAULT_PLUGINS.join(" ")}`);
    return 1;
  }

  io.out("Done. Edit brainstem.config.mjs, then start with: brainstem");
  return 0;
}

export async function runPlugins(positionals, options, io) {
  const [action, ...names] = positionals;

  if (options.help || !action) {
    io.out(PLUGINS_USAGE);
    return action || options.help ? 0 : 2;
  }

  const dir = folder(options);

  switch (action) {
    case "list":
      return list(dir, io);

    case "add": {
      if (names.length === 0) return usage(io, "plugins add needs at least one package");
      await ensureFolder(dir);
      const specs = names.map(expandBuiltin);
      const before = await installedPackages(dir);
      const code = await npm(["install", ...specs], dir, io);
      if (code !== 0) return 1;

      // Whatever the spec (name, tarball, git URL): check the packages
      // npm added, plus named ones that were already there (reinstall).
      const after = await installedPackages(dir);
      const named = specs.filter(isRegistrySpec).map(spec => splitVersion(spec)[0]);
      const touched = after.filter(name => !before.includes(name) || named.includes(name));
      const rejected = await verify(touched, dir, io);

      // Don't leave packages behind that can't be used as plugins.
      const newlyRejected = rejected.filter(name => !before.includes(name));
      if (newlyRejected.length > 0) {
        await npm(["uninstall", ...newlyRejected], dir, quiet(io));
        io.err(`Uninstalled again: ${newlyRejected.join(", ")}.`);
      }
      return rejected.length === 0 ? 0 : 1;
    }

    case "remove": {
      if (names.length === 0) return usage(io, "plugins remove needs at least one package");
      if (!existsSync(join(dir, "package.json"))) {
        io.err(`No plugin folder at ${dir}.`);
        return 1;
      }
      const packages = names.map(expandBuiltin).map(spec => splitVersion(spec)[0]);
      const code = await npm(["uninstall", ...packages], dir, io);
      if (code !== 0) return 1;
      io.out(`Removed ${packages.join(", ")}. Remove them from the config too, or those entries fail to load.`);
      return 0;
    }

    case "update": {
      if (!existsSync(join(dir, "package.json"))) {
        io.err(`No plugin folder at ${dir}. Run: brainstem init`);
        return 1;
      }
      const code = await npm(["update", ...names.map(expandBuiltin).map(spec => splitVersion(spec)[0])], dir, io);
      return code === 0 ? list(dir, io) : 1;
    }

    default:
      return usage(io, `Unknown plugins action '${action}'`);
  }
}

async function list(dir, io) {
  const installed = await installedPackages(dir);
  const rows = [];

  for (const name of installed) {
    rows.push(describe(name, { baseDir: dir, env: { BRAINSTEM_PLUGINS_DIR: dir } }, "plugin folder"));
  }

  // Built-ins that resolve from Brainstem's own install (a checkout or
  // the Docker image) and aren't in the folder.
  for (const plugin of BUILTIN_PLUGINS) {
    const name = `${PLUGIN_SCOPE}/plugin-${plugin}`;
    if (installed.includes(name)) continue;
    const row = describe(name, { baseDir: BRAINSTEM_ROOT, env: { BRAINSTEM_PLUGINS_DIR: join(BRAINSTEM_ROOT, "node_modules") } }, "built in");
    if (row.version) rows.push(row);
  }

  const builtIn = rows.some(row => row.source === "built in");
  const created = existsSync(join(dir, "package.json"));
  io.out(`Plugin folder: ${dir}${created ? "" : builtIn ? " (not created)" : " (not created; run brainstem init)"}`);

  if (rows.length === 0) {
    io.out("No plugins installed. Add some with: brainstem plugins add <package>");
    return 0;
  }

  const width = Math.max(...rows.map(row => row.name.length));
  for (const row of rows) {
    io.out(`  ${row.name.padEnd(width)}  ${(row.version ?? "?").padEnd(8)}  ${(row.kind ?? "?").padEnd(11)}  ${row.source}`);
  }
  return 0;
}

function describe(name, options, source) {
  try {
    const manifest = readPluginManifest(name, options);
    return { name, version: manifest?.version ?? null, kind: manifest?.brainstem?.kind ?? null, source };
  }
  catch {
    return { name, version: null, kind: null, source };
  }
}

/*
 * After installing: each package must load as a Brainstem input or
 * destination plugin. Returns the ones that don't.
 */
async function verify(names, dir, io) {
  const rejected = [];

  for (const name of names) {
    const options = { baseDir: process.cwd(), env: { ...process.env, BRAINSTEM_PLUGINS_DIR: dir } };
    const manifest = readPluginManifest(name, options);
    const kind = manifest?.brainstem?.kind;
    const loaders = kind === "destination"
      ? [loadDestinationPlugin]
      : kind === "input" ? [loadInputPlugin] : [loadInputPlugin, loadDestinationPlugin];

    let loaded = null;
    let lastError = null;
    for (const load of loaders) {
      try {
        loaded = { ...(await load(name, options)), kind: load === loadInputPlugin ? "input" : "destination" };
        break;
      }
      catch (error) {
        lastError = error;
      }
    }

    if (loaded) {
      io.out(`Installed ${name}@${manifest?.version ?? "?"}: ${loaded.kind} plugin "${loaded.plugin.name}". Use it with module: "${name}".`);
    }
    else {
      rejected.push(name);
      io.err(`${name} is not a Brainstem plugin: ${lastError?.message}`);
    }
  }

  return rejected;
}

function quiet(io) {
  return { out() {}, err: line => io.err(line) };
}

async function installedPackages(dir) {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return Object.keys(manifest.dependencies ?? {}).filter(name => name !== `${PLUGIN_SCOPE}/sdk`).sort();
}

async function ensureFolder(dir) {
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, "package.json");
  if (existsSync(manifestPath)) return;

  await writeFile(manifestPath, JSON.stringify({
    name: "brainstem-plugins",
    private: true,
    description: "Brainstem plugins (managed by `brainstem plugins add|remove`).",
    dependencies: {}
  }, null, 2) + "\n");
}

function folder(options) {
  return options["plugins-dir"] ? resolve(options["plugins-dir"]) : pluginsDir();
}

// "email-imap" -> "@brainstem-dev/plugin-email-imap" (built-ins only).
function expandBuiltin(spec) {
  const [name, version] = splitVersion(spec);
  return BUILTIN_PLUGINS.includes(name) ? `${PLUGIN_SCOPE}/plugin-${name}${version ? `@${version}` : ""}` : spec;
}

// A registry spec (name or name@range), not a path, tarball or URL.
function isRegistrySpec(spec) {
  return !/^(\.|\/|file:|https?:|git[+:]|github:)/.test(spec) && !spec.endsWith(".tgz");
}

function splitVersion(spec) {
  const at = spec.lastIndexOf("@");
  return at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, null];
}

function npm(args, cwd, io) {
  const command = process.env.BRAINSTEM_NPM || "npm";

  return new Promise(resolveCode => {
    const child = spawn(command, [...args, "--no-fund", "--no-audit", "--save"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });

    child.stdout.on("data", chunk => io.out(String(chunk).trimEnd()));
    child.stderr.on("data", chunk => io.err(String(chunk).trimEnd()));
    child.on("error", error => {
      io.err(error.code === "ENOENT" ? `${command} not found: install Node.js with npm to manage plugins` : error.message);
      resolveCode(127);
    });
    child.on("close", code => resolveCode(code ?? 1));
  });
}

function usage(io, message) {
  io.err(`${message}\n\n${PLUGINS_USAGE}`);
  return 2;
}

