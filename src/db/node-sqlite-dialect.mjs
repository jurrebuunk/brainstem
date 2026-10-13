import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SqliteDialect } from "kysely";

/*
 * Kysely dialect backed by Node's built-in node:sqlite.
 *
 * Adapts DatabaseSync to the better-sqlite3 shaped interface
 * that Kysely's SqliteDialect expects, so Brainstem keeps
 * zero native SQLite dependencies.
 */
export function createNodeSqliteDialect({ path, busyTimeoutMs = 5_000 }) {
  return new SqliteDialect({
    database: async () => openNodeSqlite({ path, busyTimeoutMs })
  });
}

export function openNodeSqlite({ path, busyTimeoutMs = 5_000 }) {
  let database;

  if (path === ":memory:") {
    database = new DatabaseSync(":memory:");
  }
  else {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    database = new DatabaseSync(absolute);
    database.exec("PRAGMA journal_mode = WAL;");
  }

  database.exec(`
    PRAGMA busy_timeout = ${Number(busyTimeoutMs)};
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
  `);

  return {
    close() {
      database.close();
    },

    prepare(sql) {
      const statement = database.prepare(sql);
      const reader = statement.columns().length > 0;

      return {
        reader,
        all(parameters) {
          return statement.all(...parameters);
        },
        run(parameters) {
          return statement.run(...parameters);
        },
        iterate(parameters) {
          return statement.iterate(...parameters);
        }
      };
    }
  };
}
