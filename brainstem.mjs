#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createBackendApiServer,
  normalizeBackendApiConfig
} from "./src/backend/api-server.mjs";
import { createRuntimeLogger } from "./src/runtime/logger.mjs";
import { BrainstemRuntime } from "./src/runtime/runtime.mjs";

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

const once = args.has("--once");
const printAll = args.has("--all");
const configPath = valueFromArgs(argv, "--config") ?? "brainstem.config.mjs";
const logLevel = valueFromArgs(argv, "--log-level");
const logFormat = valueFromArgs(argv, "--log-format");

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node brainstem.mjs [--config path] [--once] [--all] [--log-level level] [--log-format format]\n       node brainstem.mjs <command> [options]\n\nCommands:\n  migrate       Apply database migrations; also status, import-v1, copy.\n                See: node brainstem.mjs migrate --help\n\nOptions:\n  --config      Config file path. Default: brainstem.config.mjs\n  --once        Poll each configured input once, then exit.\n  --all         Print ignored decisions too through log destinations.\n  --log-level   Runtime log level: debug, info, warn, error, silent.\n  --log-format  Runtime log format: pretty or json.\n\nSetup:\n  cp brainstem.config.example.mjs brainstem.config.mjs\n  cp .env.example .env\n`);
  process.exit(0);
}

const config =
  await loadConfig(configPath);

const apiConfig = normalizeBackendApiConfig(
  config.runtime?.api ?? {},
  { repoRoot: process.cwd() }
);
let backendApi = null;

if (apiConfig.enabled) {
  backendApi = createBackendApiServer(apiConfig);
  await backendApi.listen();

  if (!config.runtime) config.runtime = {};
  const telemetry = config.runtime.telemetry;
  const telemetryConfigured = typeof telemetry === "string"
    ? telemetry.length > 0
    : Boolean(telemetry?.url);

  if (!telemetryConfigured) {
    config.runtime.telemetry = {
      ...(telemetry && typeof telemetry === "object" ? telemetry : {}),
      url: backendApi.telemetryUrl,
      ...(apiConfig.token ? { headers: { authorization: `Bearer ${apiConfig.token}` } } : {})
    };
  }
}

const inputs =
  config.inputs ?? [];

const logger =
  createRuntimeLogger({
    ...(config.runtime?.logging ?? {}),
    ...(logLevel ? { level: logLevel } : {}),
    ...(logFormat ? { format: logFormat } : {})
  });

const destinations =
  (config.destinations ?? []).map(entry => {
    if (
      !printAll ||
      !isLogDestination(entry)
    ) {
      return entry;
    }

    return {
      ...entry,
      decisions: "all"
    };
  });

if (inputs.length === 0) {
  logger.error(
    "no input plugins configured"
  );

  await backendApi?.close();
  process.exitCode = 1;
}
else {
  const controller =
    new AbortController();

  let stopping = false;

  function stop(signalName) {
    if (stopping) {
      return;
    }

    stopping = true;

    logger.info(
      "shutdown signal received",
      {
        signal: signalName
      }
    );

    controller.abort();
  }

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  const runtime =
    new BrainstemRuntime({
      config,
      plugins: inputs,
      destinations,
      logger
    });

  try {
    if (once) {
      logger.info(
        "polling inputs once",
        {
          inputs: inputs.length
        }
      );

      await runtime.runOnce({
        signal: controller.signal
      });
    }
    else {
      logger.info(
        "starting brainstem",
        {
          inputs: inputs.length
        }
      );

      await runtime.start({
        signal: controller.signal
      });

      await runtime.wait();
    }
  }
  catch (error) {
    logger.error(
      "brainstem failed",
      {
        error
      }
    );

    process.exitCode = 1;
  }
  finally {
    await runtime.close();
    await backendApi?.close();
  }
}

async function loadConfig(path) {
  const absolutePath = resolve(path);

  if (!existsSync(absolutePath)) {
    console.error(
      `Config file not found: ${path}\n\nCreate one with:\n  cp brainstem.config.example.mjs brainstem.config.mjs\n\nOr pass a config explicitly:\n  node brainstem.mjs --config ./my.config.mjs`
    );

    process.exit(1);
  }

  const module =
    await import(
      pathToFileURL(absolutePath).href
    );

  return module.default;
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

function isLogDestination(entry) {
  return entry.module ===
    "./plugins/log-decisions/index.mjs";
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
