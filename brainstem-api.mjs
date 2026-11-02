#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

import { runApiProcess } from "./src/cli/serve.mjs";

loadDotEnv();

const argv = process.argv.slice(2);
const args = new Set(argv);

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node brainstem-api.mjs [--config path] [--host host] [--port port]\n\nStarts the Brainstem backend API for telemetry ingestion, event history, stats, SSE, and config management.\nSame as: node brainstem.mjs --role api (but migrates the database on start unless BRAINSTEM_MIGRATE=false).\n`);
  process.exit(0);
}

await runApiProcess({
  configPath: valueFromArgs(argv, "--config") ?? process.env.BRAINSTEM_CONFIG ?? "brainstem.config.mjs",
  host: valueFromArgs(argv, "--host"),
  port: valueFromArgs(argv, "--port"),
  // The standalone API keeps migrating on start, as in 1.x.
  migrate: process.env.BRAINSTEM_MIGRATE === "false" || process.env.BRAINSTEM_MIGRATE === "0" ? false : true
});

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
