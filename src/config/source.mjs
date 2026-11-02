import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { BOOTSTRAP_RUNTIME_KEYS } from "./schema.mjs";

/*
 * Where a process gets its pipeline config (ADR-0005):
 *
 *   file      brainstem.config.mjs (the default; the UI is read-only)
 *   database  the active version in `config_versions`; the file, if
 *             any, only supplies bootstrap settings
 *
 * --config-source, then BRAINSTEM_CONFIG_SOURCE, then
 * runtime.configSource in the file.
 */
export const CONFIG_SOURCES = ["file", "database"];

export function resolveConfigSource({ flag = null, config = {} } = {}) {
  const source = flag ?? process.env.BRAINSTEM_CONFIG_SOURCE ?? config.runtime?.configSource ?? "file";

  if (!CONFIG_SOURCES.includes(source)) {
    throw new Error(`Unknown config source '${source}'. Use 'file' or 'database'.`);
  }

  return source;
}

/*
 * Evaluate a config module (operator-side only: never content
 * submitted through the API). Returns null when the file is
 * missing.
 */
export async function loadConfigFile(path) {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) return null;

  const module = await import(`${pathToFileURL(absolutePath).href}?t=${Date.now()}`);
  return module.default ?? {};
}

/*
 * The part of a config file that is stored as a version: everything
 * except the per-process bootstrap settings.
 */
export function specFromConfig(config) {
  const spec = structuredCloneable(config);
  const left = [];

  if (spec.runtime) {
    for (const key of BOOTSTRAP_RUNTIME_KEYS) {
      if (Object.hasOwn(spec.runtime, key)) {
        delete spec.runtime[key];
        left.push(`runtime.${key}`);
      }
    }

    delete spec.runtime.configSource;

    if (Object.keys(spec.runtime).length === 0) delete spec.runtime;
  }

  return { spec, left };
}

export function configModuleSource(spec, { version = null } = {}) {
  const header = version
    ? `// Brainstem config version ${version.id} (${version.createdAt}${version.comment ? `: ${version.comment}` : ""}).\n`
    : "";

  return `${header}export default ${JSON.stringify(spec, null, 2)};\n`;
}

/*
 * Shallow copy deep enough to delete runtime keys without touching
 * the caller's object; functions are kept so validation can report
 * them.
 */
function structuredCloneable(config) {
  return {
    ...config,
    ...(config.runtime ? { runtime: { ...config.runtime } } : {})
  };
}
