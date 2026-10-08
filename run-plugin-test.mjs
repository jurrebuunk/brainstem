#!/usr/bin/env node
import { validateDestinationPlugin, validateInputPlugin } from "./src/sdk/index.mjs";

const inputPlugins = [
  "./plugins/static-observations/index.mjs",
  "./plugins/github-issues/index.mjs",
  "./plugins/http-health/index.mjs",
  "./plugins/tls-certificate/index.mjs",
  "./plugins/email-imap/index.mjs"
];

const destinationPlugins = [
  "./plugins/log-decisions/index.mjs",
  "./plugins/matrix/index.mjs"
];

for (const specifier of inputPlugins) {
  const plugin = (await import(specifier)).default;
  validateInputPlugin(plugin);
  console.log(`input ok: ${plugin.name}`);
}

for (const specifier of destinationPlugins) {
  const plugin = (await import(specifier)).default;
  validateDestinationPlugin(plugin);
  console.log(`destination ok: ${plugin.name}`);
}
