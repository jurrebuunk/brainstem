#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

import { resolveRole, runApiProcess, runCoreProcess } from "./src/cli/serve.mjs";

loadDotEnv();

const argv = process.argv.slice(2);

// Subcommands (e.g. `brainstem migrate`) run instead of the runtime.
if (/^[a-z]/.test(argv[0] ?? "")) {
  const { isCliCommand, runCli, COMMANDS_USAGE } = await import("./src/cli/index.mjs");

  if (!isCliCommand(argv)) {
    console.error(`Unknown command: ${argv[0]}\n\n${COMMANDS_USAGE}`);
    process.exit(2);
  }

  const code = await runCli(argv);
  await new Promise(done => process.stdout.write("", done));
  process.exit(code);
}

const args = new Set(argv);

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node brainstem.mjs [options]
       node brainstem.mjs <command> [options]

Commands:
  migrate       Apply database migrations; also status, import-v1, copy.
                See: node brainstem.mjs migrate --help
  config        Config versions: import, export, list, show, activate, validate.
                See: node brainstem.mjs config --help
  init          Create a config and the plugin folder with the default plugins.
  plugins       Manage plugin packages: list, add, remove, update.
                See: node brainstem.mjs plugins --help

Options:
  --config              Config file path. Default: brainstem.config.mjs
  --plugins-dir         Plugin folder (npm packages). Default: ./brainstem-plugins.
                        Env: BRAINSTEM_PLUGINS_DIR
  --role                all (default), core, api or web. Env: BRAINSTEM_ROLE
  --queues              Stages a core runs: poll,decide,deliver (default: all).
                        Env: BRAINSTEM_QUEUES
  --config-source       file (default) or database. Env: BRAINSTEM_CONFIG_SOURCE
  --health-port         Probe port (/livez, /readyz, /startupz). Default 8081
                        for role core, off for all. Env: BRAINSTEM_HEALTH_PORT
  --health-host         Probe host. Default 0.0.0.0. Env: BRAINSTEM_HEALTH_HOST
  --decide-concurrency  Decide jobs at once, each with its own Laya worker thread.
  --drain-timeout       Ms to let in-flight work finish on SIGTERM. Default 25000.
  --host, --port        API listen address (role api).
  --once                Poll each configured input once, then exit.
  --all                 Print ignored decisions too through log destinations.
  --log-level           Runtime log level: debug, info, warn, error, silent.
  --log-format          Runtime log format: pretty or json.

Setup:
  cp brainstem.config.example.mjs brainstem.config.mjs
  cp .env.example .env
`);
  process.exit(0);
}

const configPath = valueFromArgs(argv, "--config") ?? process.env.BRAINSTEM_CONFIG ?? "brainstem.config.mjs";

const pluginsDirFlag = valueFromArgs(argv, "--plugins-dir");
if (pluginsDirFlag) process.env.BRAINSTEM_PLUGINS_DIR = pluginsDirFlag;

let role;
try {
  role = resolveRole(valueFromArgs(argv, "--role"));
}
catch (error) {
  console.error(error.message);
  process.exit(2);
}

if (role === "web") {
  process.env.NODE_ENV ??= "production";
  await import("./web/server.mjs");
}
else if (role === "api") {
  await runApiProcess({
    configPath,
    host: valueFromArgs(argv, "--host"),
    port: valueFromArgs(argv, "--port")
  });
}
else {
  const drainTimeout = valueFromArgs(argv, "--drain-timeout");

  process.exitCode = await runCoreProcess({
    role,
    configPath,
    queues: valueFromArgs(argv, "--queues"),
    configSource: valueFromArgs(argv, "--config-source"),
    healthHost: valueFromArgs(argv, "--health-host"),
    healthPort: valueFromArgs(argv, "--health-port"),
    once: args.has("--once"),
    printAll: args.has("--all"),
    logLevel: valueFromArgs(argv, "--log-level"),
    logFormat: valueFromArgs(argv, "--log-format"),
    decideConcurrency: valueFromArgs(argv, "--decide-concurrency"),
    drainTimeoutMs: drainTimeout ? Number(drainTimeout) : null
  });
}

function valueFromArgs(args, name) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === name) {
      return args[index + 1];
    }

    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }

  return null;
}

function loadDotEnv(path = ".env") {
  if (!existsSync(path)) {
    return;
  }

  const text =
    readFileSync(path, "utf8");

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (
      !trimmed ||
      trimmed.startsWith("#")
    ) {
      continue;
    }

    const index = trimmed.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key =
      trimmed.slice(0, index).trim();

    let value =
      trimmed.slice(index + 1).trim();

    if (
      (
        value.startsWith("\"") &&
        value.endsWith("\"")
      ) ||
      (
        value.startsWith("'") &&
        value.endsWith("'")
      )
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] ??= value;
  }
}
