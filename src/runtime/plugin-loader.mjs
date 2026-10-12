import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  validateDestinationPlugin,
  validateInputPlugin
} from "../sdk/index.mjs";

export async function loadInputPlugin(specifier, { baseDir = process.cwd() } = {}) {
  const url = resolveLocalModuleUrl(specifier, baseDir);
  const module = await import(url);
  const plugin = module.default;
  validateInputPlugin(plugin);
  return { plugin, url };
}

export async function loadDestinationPlugin(specifier, { baseDir = process.cwd() } = {}) {
  const url = resolveLocalModuleUrl(specifier, baseDir);
  const module = await import(url);
  const plugin = module.default;
  validateDestinationPlugin(plugin);
  return { plugin, url };
}

export function resolveLocalModuleUrl(specifier, baseDir) {
  if (typeof specifier !== "string") {
    throw new TypeError("Plugin module specifier must be a string");
  }

  if (specifier.startsWith("file:")) {
    return specifier;
  }

  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    throw new Error(
      "Phase 1 only supports local file input plugins. Use './plugin.mjs' or an absolute path."
    );
  }

  const filePath = isAbsolute(specifier)
    ? specifier
    : resolve(baseDir, specifier);

  return pathToFileURL(filePath).href;
}
