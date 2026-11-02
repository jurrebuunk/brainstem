import { Kysely, PostgresDialect } from "kysely";

import { createNodeSqliteDialect } from "./node-sqlite-dialect.mjs";
import { createNotifier } from "./notifier.mjs";

export const DEFAULT_DATABASE_URL = "sqlite:data/brainstem.sqlite";

/*
 * Parse a Brainstem database URL.
 *
 *   sqlite:data/brainstem.sqlite   (relative to cwd)
 *   sqlite:/abs/path.sqlite
 *   sqlite::memory:
 *   postgres://user:pass@host:5432/db   (also postgresql://)
 */
export function parseDatabaseUrl(url = DEFAULT_DATABASE_URL) {
  const value = String(url);

  if (value.startsWith("sqlite:")) {
    const path = value.slice("sqlite:".length).replace(/^\/\/(?=\/)/, "");
    if (!path) throw new Error(`Invalid SQLite database URL '${value}'`);
    return { dialect: "sqlite", path };
  }

  if (/^postgres(ql)?:\/\//.test(value)) {
    return { dialect: "postgres", connectionString: value };
  }

  throw new Error(
    `Unsupported database URL '${value}'. Use sqlite:<path> or postgres://...`
  );
}

export function resolveDatabaseUrl(config = {}) {
  return config.url
    ?? process.env.BRAINSTEM_DATABASE_URL
    ?? (config.path ? `sqlite:${config.path}` : DEFAULT_DATABASE_URL);
}

/*
 * Open a database handle.
 *
 * Returns { db, dialect, schema, notifier, close() } where db is a
 * Kysely instance. All Brainstem stores take this handle instead of
 * opening their own connections. `notifier` (src/db/notifier.mjs)
 * is created on first use and connects only when something listens.
 */
export async function openDatabase({ url, pool = {} } = {}) {
  const parsed = parseDatabaseUrl(url ?? resolveDatabaseUrl());
  let dialect;

  if (parsed.dialect === "sqlite") {
    dialect = createNodeSqliteDialect({ path: parsed.path });
  }
  else {
    const { default: pg } = await import("pg");
    // Return BIGINT (int8) as JS numbers; counters stay well below 2^53.
    pg.types.setTypeParser(20, value => Number(value));
    dialect = new PostgresDialect({
      pool: new pg.Pool({
        connectionString: parsed.connectionString,
        max: pool.max ?? 10
      })
    });
  }

  const db = new Kysely({ dialect });
  let closed = false;

  // Pin the schema so migrations and lookups never leak into other
  // schemas on a shared Postgres server.
  let schema = null;
  if (parsed.dialect === "postgres") {
    const result = await db.executeQuery({
      sql: "select current_schema() as schema",
      parameters: [],
      query: { kind: "RawNode" }
    });
    schema = result.rows[0]?.schema ?? "public";
  }

  const resolvedUrl = url ?? resolveDatabaseUrl();
  let notifier = null;

  return {
    db,
    dialect: parsed.dialect,
    schema,
    url: resolvedUrl,
    get notifier() {
      notifier ??= createNotifier({ dialect: parsed.dialect, url: resolvedUrl, schema });
      return notifier;
    },
    async close() {
      if (closed) return;
      closed = true;
      await notifier?.close();
      await db.destroy();
    }
  };
}
