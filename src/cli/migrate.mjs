import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { openDatabase, parseDatabaseUrl } from "../db/database.mjs";
import { migrateToLatest, migrationStatus } from "../db/migrate.mjs";
import { copyDatabase, DEFAULT_COPY_BATCH_SIZE } from "./copy.mjs";
import { importV1, legacyPaths } from "./import-v1.mjs";
import { formatSummary } from "./tables.mjs";

export const MIGRATE_USAGE = `Usage:
  brainstem migrate [--database url]
  brainstem migrate status [--database url]
  brainstem migrate import-v1 [--data-dir data] [--database url]
  brainstem migrate copy --from url --to url [--force] [--batch-size n]
  brainstem migrate sqlite-to-pg --from url --to url [--force]   (alias of copy)

Database URLs:
  sqlite:data/brainstem.sqlite    (relative to the working directory)
  sqlite:/abs/path/brainstem.sqlite
  postgres://user:pass@host:5432/db

Without --database the URL comes from runtime.database.url in the
config file (--config, default brainstem.config.mjs, skipped when
missing), then BRAINSTEM_DATABASE_URL, then sqlite:data/brainstem.sqlite.

import-v1 options:
  --data-dir         1.x data directory. Default: data
  --records-db       1.x records file. Default: <data-dir>/brainstem.sqlite
  --telemetry-db     1.x telemetry/auth file. Default: <data-dir>/web-stats.sqlite
  --checkpoints-file 1.x checkpoints file. Default: <data-dir>/checkpoints.json
`;

export async function runMigrate(positionals, options, io) {
  const [action = "latest", ...rest] = positionals;

  if (options.help) {
    io.out(MIGRATE_USAGE);
    return 0;
  }

  if (rest.length > 0) {
    io.err(`Unexpected argument: ${rest[0]}\n\n${MIGRATE_USAGE}`);
    return 2;
  }

  switch (action) {
    case "latest":
    case "up":
      return withDatabase(options, io, async handle => {
        const results = await migrateToLatest(handle);
        if (results.length === 0) {
          io.out(`Database ${redact(handle.url)} is up to date.`);
        }
        else {
          for (const result of results) io.out(`applied ${result.name}`);
        }
        return 0;
      });

    case "status":
      return withDatabase(options, io, async handle => {
        const status = await migrationStatus(handle);
        io.out(`Database ${redact(handle.url)}`);
        for (const migration of status) {
          const state = migration.executedAt
            ? `applied ${new Date(migration.executedAt).toISOString()}`
            : "pending";
          io.out(`  ${migration.name}  ${state}`);
        }
        return 0;
      });

    case "import-v1":
      return withDatabase(options, io, async handle => {
        const paths = legacyPaths({
          dataDir: options["data-dir"] ?? "data",
          recordsDb: options["records-db"],
          telemetryDb: options["telemetry-db"],
          checkpointsFile: options["checkpoints-file"]
        });
        io.out(`Importing 1.x state into ${redact(handle.url)}`);
        io.out(`  records:     ${paths.recordsDb}`);
        io.out(`  telemetry:   ${paths.telemetryDb}`);
        io.out(`  checkpoints: ${paths.checkpointsFile}`);

        const summary = await importV1(handle, paths);
        io.out(formatSummary(summary.map(entry => ({
          table: entry.table,
          text: `${entry.read} read, ${entry.inserted} inserted${entry.note ? ` (${entry.note})` : ""}`
        }))));
        return 0;
      });

    case "copy":
    case "sqlite-to-pg":
      return runCopy(options, io);

    default:
      io.err(`Unknown migrate command: ${action}\n\n${MIGRATE_USAGE}`);
      return 2;
  }
}

async function runCopy(options, io) {
  if (!options.from || !options.to) {
    io.err(`migrate copy needs --from and --to\n\n${MIGRATE_USAGE}`);
    return 2;
  }

  const batchSize = options["batch-size"] ? Number(options["batch-size"]) : DEFAULT_COPY_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    io.err(`Invalid --batch-size: ${options["batch-size"]}`);
    return 2;
  }

  const from = parseDatabaseUrl(options.from);
  if (from.dialect === "sqlite" && from.path !== ":memory:" && !existsSync(resolve(from.path))) {
    io.err(`Source database not found: ${from.path}`);
    return 1;
  }

  const source = await openDatabase({ url: options.from, pool: { max: 2 } });
  let target;

  try {
    target = await openDatabase({ url: options.to, pool: { max: 2 } });
    io.out(`Copying ${redact(options.from)} → ${redact(options.to)}`);
    const summary = await copyDatabase(source, target, { force: Boolean(options.force), batchSize });
    io.out(formatSummary(summary.map(entry => ({
      table: entry.table,
      text: entry.read === entry.inserted
        ? `${entry.inserted} copied`
        : `${entry.read} read, ${entry.inserted} copied (${entry.read - entry.inserted} skipped on conflict)`
    }))));
    return 0;
  }
  catch (error) {
    io.err(`migrate copy failed: ${error.message}`);
    return 1;
  }
  finally {
    await source.close();
    await target?.close();
  }
}

async function withDatabase(options, io, fn) {
  let handle;

  try {
    handle = await openDatabase({ url: options.databaseUrl, pool: { max: 2 } });
    return await fn(handle);
  }
  catch (error) {
    io.err(`migrate failed: ${error.message}`);
    return 1;
  }
  finally {
    await handle?.close();
  }
}

/*
 * Hide passwords in URLs before printing them.
 */
export function redact(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "***";
      return parsed.toString();
    }
  }
  catch {}
  return String(url);
}
