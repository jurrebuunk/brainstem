import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  validateDestinationPlugin,
  validateInputPlugin
} from "../sdk/index.mjs";

/*
 * Plugins are npm packages (docs/plugins.md#installing-plugins):
 *
 *   module: "@brainstem-dev/plugin-matrix"     a package
 *   module: "brainstem-plugin-jira"            a third-party package
 *   module: "./my-plugin/index.mjs"            a local file, as before
 *
 * Packages are found, in order, in the plugin folder
 * (BRAINSTEM_PLUGINS_DIR, default ./brainstem-plugins, managed by
 * `brainstem plugins add|remove`), next to the working directory,
 * and next to Brainstem itself (the built-in plugins in a checkout
 * or the Docker image).
 *
 * The built-in plugins' old paths (./plugins/<name>/index.mjs) keep
 * working: when that file doesn't exist, as after an npm install,
 * they load @brainstem-dev/plugin-<name>.
 */
export const PLUGIN_SCOPE = "@brainstem-dev";

export const BUILTIN_PLUGINS = [
  "agentos-runner",
  "email-imap",
  "github-issues",
  "http-health",
  "http-json",
  "log-decisions",
  "log-file",
  "matrix",
  "opencode-runner",
  "static-observations",
  "tls-certificate"
];

const BRAINSTEM_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export class PluginNotFoundError extends Error {
  constructor(specifier, searched) {
    super(
      `Plugin package '${specifier}' is not installed. Install it with: brainstem plugins add ${specifier}` +
      ` (looked in ${searched.join(", ")})`
    );
    this.name = "PluginNotFoundError";
    this.code = "BRAINSTEM_PLUGIN_NOT_FOUND";
    this.specifier = specifier;
  }
}

export async function loadInputPlugin(specifier, options = {}) {
  const url = resolvePluginModuleUrl(specifier, options);
  const module = await import(url);
  const plugin = module.default;
  validateInputPlugin(plugin);
  return { plugin, url };
}

export async function loadDestinationPlugin(specifier, options = {}) {
  const url = resolvePluginModuleUrl(specifier, options);
  const module = await import(url);
  const plugin = module.default;
  validateDestinationPlugin(plugin);
  return { plugin, url };
}

export function pluginsDir({ baseDir = process.cwd(), env = process.env } = {}) {
  return resolve(baseDir, env.BRAINSTEM_PLUGINS_DIR || "brainstem-plugins");
}

export function resolvePluginModuleUrl(specifier, { baseDir = process.cwd(), env = process.env } = {}) {
  if (typeof specifier !== "string" || specifier.length === 0) {
    throw new TypeError("Plugin module specifier must be a non-empty string");
  }

  if (specifier.startsWith("file:")) return specifier;

  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    const filePath = isAbsolute(specifier) ? specifier : resolve(baseDir, specifier);
    if (existsSync(filePath)) return pathToFileURL(filePath).href;

    const legacy = legacyBuiltinPackage(specifier);
    if (legacy) return resolvePackageUrl(legacy, { baseDir, env });

    // Let import() report the missing file.
    return pathToFileURL(filePath).href;
  }

  return resolvePackageUrl(specifier, { baseDir, env });
}

/*
 * "./plugins/matrix/index.mjs" -> "@brainstem-dev/plugin-matrix"
 */
export function legacyBuiltinPackage(specifier) {
  const match = /(?:^|\/)plugins\/([a-z0-9-]+)\/index\.mjs$/.exec(specifier);
  return match && BUILTIN_PLUGINS.includes(match[1]) ? `${PLUGIN_SCOPE}/plugin-${match[1]}` : null;
}

function resolvePackageUrl(specifier, { baseDir, env }) {
  const { name, subpath } = splitSpecifier(specifier);
  const roots = searchRoots({ baseDir, env });

  for (const root of roots) {
    const packageDir = join(root, "node_modules", name);
    const manifestPath = join(packageDir, "package.json");
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return pathToFileURL(join(packageDir, packageEntry(manifest, subpath))).href;
  }

  throw new PluginNotFoundError(specifier, roots.map(root => join(root, "node_modules")));
}

/*
 * The plugin folder, the working directory and its parents, then
 * Brainstem's own directory and its parents (a global or nested
 * install hoists packages upwards).
 */
function searchRoots({ baseDir, env }) {
  const roots = [pluginsDir({ baseDir, env })];

  for (const start of [resolve(baseDir), BRAINSTEM_ROOT]) {
    let dir = start;
    while (true) {
      roots.push(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return [...new Set(roots)];
}

function splitSpecifier(specifier) {
  const parts = specifier.split("/");
  const count = specifier.startsWith("@") ? 2 : 1;

  if (parts.length < count || parts.slice(0, count).some(part => part.length === 0)) {
    throw new TypeError(`Invalid plugin package name '${specifier}'`);
  }

  return {
    name: parts.slice(0, count).join("/"),
    subpath: parts.length > count ? `./${parts.slice(count).join("/")}` : "."
  };
}

/*
 * The file a package exposes for `import`: its "exports" (string, or
 * the "." / subpath entry, preferring import then default), else
 * "main", else index.js.
 */
function packageEntry(manifest, subpath) {
  const exportsField = manifest.exports;

  if (exportsField !== undefined) {
    const entry = typeof exportsField === "string" || Array.isArray(exportsField) || !Object.keys(exportsField).some(key => key.startsWith("."))
      ? (subpath === "." ? exportsField : undefined)
      : exportsField[subpath];
    const target = conditionalTarget(entry);

    if (!target) {
      throw new Error(`Package '${manifest.name}' does not export '${subpath}'`);
    }

    return target;
  }

  if (subpath !== ".") return subpath;
  return manifest.main ?? "index.js";
}

function conditionalTarget(entry) {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry)) return entry.map(conditionalTarget).find(Boolean);
  if (entry && typeof entry === "object") {
    for (const condition of ["import", "node", "default"]) {
      const target = conditionalTarget(entry[condition]);
      if (target) return target;
    }
  }
  return undefined;
}

/*
 * Read a plugin package's manifest (name, version, kind) without
 * importing it, for `brainstem plugins list`.
 */
export function readPluginManifest(specifier, options = {}) {
  const url = resolvePluginModuleUrl(specifier, options);
  let dir = dirname(fileURLToPath(url));

  while (true) {
    const manifestPath = join(dir, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name) return { ...manifest, dir };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
