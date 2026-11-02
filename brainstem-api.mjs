#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createBackendApiServer,
  normalizeBackendApiConfig
} from "./src/backend/api-server.mjs";
import { openRuntimeDatabase } from "./src/runtime/bootstrap.mjs";

loadDotEnv();

const argv = process.argv.slice(2);
const args = new Set(argv);

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node brainstem-api.mjs [--config path] [--host host] [--port port]\n\nStarts the Brainstem backend API for telemetry ingestion, event history, stats, SSE, and config management.\n`);
  process.exit(0);
}

const configPath = valueFromArgs(argv, "--config") ?? process.env.BRAINSTEM_CONFIG ?? "brainstem.config.mjs";
const config = await loadOptionalConfig(configPath);
const apiConfig = normalizeBackendApiConfig(
  {
    ...(config.runtime?.api ?? {}),
    enabled: true,
    ...(valueFromArgs(argv, "--host") ? { host: valueFromArgs(argv, "--host") } : {}),
    ...(valueFromArgs(argv, "--port") ? { port: Number(valueFromArgs(argv, "--port")) } : {}),
    configPath
  },
  { repoRoot: process.cwd() }
);

// Same database as the runtime (runtime.database / BRAINSTEM_DATABASE_URL).
const database = await openRuntimeDatabase(config);
const api = createBackendApiServer({ ...apiConfig, database });
await api.listen();

console.log(`Brainstem Backend API listening on ${api.url}`);
console.log(`Telemetry ingest endpoint: ${api.telemetryUrl}`);
console.log(`Stats database: ${api.telemetryStore.path}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await api.close();
    await database.close();
    process.exit(0);
  });
}

async function loadOptionalConfig(path) {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) return {};
  const module = await import(pathToFileURL(absolutePath).href);
  return module.default ?? {};
}

function valueFromArgs(args, name) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) return args[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return null;
}

function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] ??= value;
  }
}
