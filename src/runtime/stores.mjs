import { isAbsolute, resolve } from "node:path";

import {
  DatabaseCheckpointStore,
  JsonFileCheckpointStore,
  MemoryCheckpointStore
} from "./checkpoints.mjs";
import {
  DatabaseRecordStore,
  MemoryRecordStore,
  SqliteRecordStore
} from "../core/record-stores.mjs";
import { resolveDatabaseUrl } from "../db/database.mjs";
import { openMigratedDatabase } from "../db/index.mjs";

/*
 * Shared database handle for the runtime's stores.
 *
 *   runtime: {
 *     database: { url, path, pool }
 *   }
 *
 * Falls back to resolveDatabaseUrl()
 * (BRAINSTEM_DATABASE_URL, then
 * sqlite:data/brainstem.sqlite). Relative SQLite
 * paths resolve against baseDir.
 *
 * When `database` (an already-open
 * { db, dialect, close } handle) is given, it is
 * shared as-is and never closed here: whoever
 * opened it owns it.
 *
 * Otherwise the handle is opened (and migrated)
 * lazily on first use and closed by close().
 */
export function createDatabaseProvider(config, baseDir, { database } = {}) {
  if (database) {
    return {
      owned: false,
      url: database.url ?? null,
      async get() {
        return database;
      },
      async close() {}
    };
  }

  const options =
    config.runtime?.database ?? {};

  const url =
    runtimeDatabaseUrl(options, baseDir);

  let opening = null;
  let closed = false;

  return {
    owned: true,
    url,

    get() {
      if (closed) {
        return Promise.reject(
          new Error("Runtime database has been closed")
        );
      }

      opening ??=
        openMigratedDatabase({
          url,
          pool: options.pool ?? {}
        })
          .catch(error => {
            opening = null;
            throw error;
          });

      return opening;
    },

    async close() {
      closed = true;

      const handle =
        await opening?.catch(() => null);

      opening = null;

      await handle?.close();
    }
  };
}

export function createRecordStore(config, baseDir, { provider: shared } = {}) {
  const records = config.runtime?.records;

  if (records === false) {
    return new MemoryRecordStore();
  }

  const type = records?.type ?? "database";

  if (type === "memory") {
    return new MemoryRecordStore();
  }

  if (type === "database") {
    const provider =
      shared ??
      createDatabaseProvider(config, baseDir);

    const store = new DatabaseRecordStore({
      database: () => provider.get(),
      ownsDatabase: false,
      pruneAfterDays: records?.pruneAfterDays ?? null,
      pruneIntervalMs: records?.pruneIntervalMs
    });

    store.url = provider.url;

    // A provider created just for this store
    // is closed together with it.
    if (!shared) {
      const close = store.close.bind(store);
      store.close = async () => {
        await close();
        await provider.close();
      };
    }

    return store;
  }

  if (type === "sqlite") {
    return new SqliteRecordStore({
      path: resolve(baseDir, records.path ?? "data/brainstem.sqlite"),
      pruneAfterDays: records.pruneAfterDays ?? null,
      pruneIntervalMs: records.pruneIntervalMs
    });
  }

  throw new Error(`Unsupported record store type '${type}'`);
}

export function createCheckpointStore(config, baseDir, { provider: shared } = {}) {
  const checkpoints = config.runtime?.checkpoints;

  if (checkpoints === false) {
    return new MemoryCheckpointStore();
  }

  const type = checkpoints?.type ?? "database";

  if (type === "memory") {
    return new MemoryCheckpointStore();
  }

  if (type === "json") {
    return new JsonFileCheckpointStore(
      resolve(baseDir, checkpoints?.path ?? "data/checkpoints.json")
    );
  }

  if (type === "database") {
    const provider =
      shared ??
      createDatabaseProvider(config, baseDir);

    /*
     * One-time import of the 1.x JSON file.
     * `legacyPath: false` disables it.
     */
    const legacyPath =
      checkpoints?.legacyPath ??
      checkpoints?.path ??
      "data/checkpoints.json";

    const store = new DatabaseCheckpointStore({
      database: () => provider.get(),
      ownsDatabase: false,
      legacyJsonPath: legacyPath
        ? resolve(baseDir, legacyPath)
        : null
    });

    store.url = provider.url;

    if (!shared) {
      const close = store.close.bind(store);
      store.close = async () => {
        await close();
        await provider.close();
      };
    }

    return store;
  }

  throw new Error(`Unsupported checkpoint store type '${type}'`);
}

export function storeInfo(store) {
  if (!store) return null;
  return {
    type: store.constructor?.name ?? "unknown",
    path: store.path ?? null,
    ...(store.url ? { database: redactUrl(store.url) } : {})
  };
}

export function runtimeDatabaseUrl(options, baseDir) {
  const url = resolveDatabaseUrl({
    url: options.url,
    path: options.path
  });

  if (!url.startsWith("sqlite:")) {
    return url;
  }

  const path =
    url.slice("sqlite:".length);

  if (
    path === ":memory:" ||
    path.startsWith("//") ||
    isAbsolute(path)
  ) {
    return url;
  }

  return `sqlite:${resolve(baseDir, path)}`;
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);

    if (parsed.password) {
      parsed.password = "***";
    }

    return parsed.toString();
  }
  catch {
    return url;
  }
}
