import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { resolveDatabaseUrl } from "../db/database.mjs";
import { MIGRATE_USAGE, runMigrate } from "./migrate.mjs";

/*
 * Subcommands handled before the runtime starts:
 *
 *   brainstem migrate [status|import-v1|copy|sqlite-to-pg] ...
 *
 * Everything else (no subcommand, or flags only) falls through
 * to the runtime in brainstem.mjs.
 */
export const COMMANDS = {
  migrate: runMigrate
};

export const COMMANDS_USAGE = `Commands:
  migrate               Apply database migrations (see: brainstem migrate --help)
  migrate status        Show applied and pending migrations
  migrate import-v1     Import 1.x state (data/*.sqlite, checkpoints.json)
  migrate copy          Copy all tables between databases (alias: sqlite-to-pg)`;

const OPTIONS = {
  config: { type: "string" },
  database: { type: "string" },
  "data-dir": { type: "string" },
  "records-db": { type: "string" },
  "telemetry-db": { type: "string" },
  "checkpoints-file": { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  force: { type: "boolean" },
  "batch-size": { type: "string" },
  help: { type: "boolean", short: "h" }
};

export function isCliCommand(argv) {
  return Object.hasOwn(COMMANDS, argv[0] ?? "");
}

/*
 * Run a CLI subcommand. Returns the process exit code.
 */
export async function runCli(argv, io = consoleIo()) {
  const [command, ...rest] = argv;
  const handler = COMMANDS[command];

  if (!handler) {
    io.err(`Unknown command: ${command}\n\n${COMMANDS_USAGE}`);
    return 2;
  }

  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
  }
  catch (error) {
    io.err(`${error.message}\n\n${MIGRATE_USAGE}`);
    return 2;
  }

  const options = { ...parsed.values };

  try {
    options.databaseUrl = options.database ?? await databaseUrlFromConfig(options.config);
  }
  catch (error) {
    io.err(error.message);
    return 1;
  }

  return handler(parsed.positionals, options, io);
}

/*
 * Same precedence as the runtime (resolveDatabaseUrl):
 * runtime.database.url in the config file, then
 * BRAINSTEM_DATABASE_URL, then runtime.database.path, then
 * the SQLite default.
 */
async function databaseUrlFromConfig(configPath) {
  const path = resolve(configPath ?? process.env.BRAINSTEM_CONFIG ?? "brainstem.config.mjs");
  if (!existsSync(path)) {
    if (configPath) throw new Error(`Config file not found: ${configPath}`);
    return resolveDatabaseUrl();
  }

  const module = await import(pathToFileURL(path).href);
  return resolveDatabaseUrl(module.default?.runtime?.database ?? {});
}

function consoleIo() {
  return {
    out: line => console.log(line),
    err: line => console.error(line)
  };
}
