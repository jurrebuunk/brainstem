#!/usr/bin/env node
/*
 * Load every built-in plugin package the way the runtime does (by
 * package name) and check its shape and package metadata.
 */
import { BUILTIN_PLUGINS, PLUGIN_SCOPE, loadDestinationPlugin, loadInputPlugin, readPluginManifest } from "./src/runtime/plugin-loader.mjs";

import { readFileSync } from "node:fs";

let failed = 0;
const root = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const sdk = JSON.parse(readFileSync(new URL("./packages/sdk/package.json", import.meta.url), "utf8"));

// One version for every package (brainstem init installs plugins at
// the app's version).
if (sdk.version !== root.version || root.dependencies["@brainstem-dev/sdk"] !== root.version) {
  failed += 1;
  console.error(`FAILED versions: app ${root.version}, sdk ${sdk.version}, app depends on sdk ${root.dependencies["@brainstem-dev/sdk"]}`);
}

for (const name of BUILTIN_PLUGINS) {
  const specifier = `${PLUGIN_SCOPE}/plugin-${name}`;

  try {
    const manifest = readPluginManifest(specifier);
    const kind = manifest?.brainstem?.kind;
    if (!["input", "destination"].includes(kind)) throw new Error(`package.json brainstem.kind is '${kind}'`);
    if (!manifest.peerDependencies?.[`${PLUGIN_SCOPE}/sdk`]) throw new Error("missing the @brainstem-dev/sdk peer dependency");
    if (manifest.version !== root.version) throw new Error(`version ${manifest.version}, expected ${root.version} like the app`);

    const { plugin } = kind === "input" ? await loadInputPlugin(specifier) : await loadDestinationPlugin(specifier);
    console.log(`${kind} ok: ${specifier}@${manifest.version} (${plugin.name})`);
  }
  catch (error) {
    failed += 1;
    console.error(`FAILED ${specifier}: ${error.message}`);
  }
}

process.exitCode = failed === 0 ? 0 : 1;
