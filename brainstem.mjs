import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { BrainstemRuntime } from "./src/runtime/runtime.mjs";

loadDotEnv();

const argv = process.argv.slice(2);
const args = new Set(argv);

const once = args.has("--once");
const printAll = args.has("--all");
const configPath = configPathFromArgs(argv) ?? "brainstem.config.mjs";

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node brainstem.mjs [--config path] [--once] [--all]\n\nOptions:\n  --config  Config file path. Default: brainstem.config.mjs\n  --once    Poll each configured input once, then exit.\n  --all     Print ignored decisions too through log destinations.\n\nSetup:\n  cp brainstem.config.example.mjs brainstem.config.mjs\n  cp .env.example .env\n`);
  process.exit(0);
}

const config =
  await loadConfig(configPath);

const inputs =
  config.inputs ?? [];

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
  console.error(
    "No input plugins configured. Add entries to config.inputs or run `node run-plugin-test.mjs`."
  );

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

    console.log(
      `\nReceived ${signalName}; shutting down Brainstem...`
    );

    controller.abort();
  }

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  const runtime =
    new BrainstemRuntime({
      config,
      plugins: inputs,
      destinations
    });

  try {
    if (once) {
      console.log(
        `Polling ${inputs.length} input plugin(s) once...`
      );

      await runtime.runOnce({
        signal: controller.signal
      });
    }
    else {
      console.log(
        `Starting Brainstem with ${inputs.length} input plugin(s)...`
      );

      await runtime.start({
        signal: controller.signal
      });

      await runtime.wait();
    }
  }
  finally {
    await runtime.close();
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

function configPathFromArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--config") {
      return args[index + 1];
    }

    if (arg.startsWith("--config=")) {
      return arg.slice("--config=".length);
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
