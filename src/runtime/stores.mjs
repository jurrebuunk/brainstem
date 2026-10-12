import { resolve } from "node:path";

import {
  JsonFileCheckpointStore,
  MemoryCheckpointStore
} from "./checkpoints.mjs";
import {
  MemoryRecordStore,
  SqliteRecordStore
} from "../core/record-stores.mjs";

export function createRecordStore(config, baseDir) {
  const records = config.runtime?.records;

  if (!records || records === false) {
    return new MemoryRecordStore();
  }

  const type = records.type ?? "memory";

  if (type === "memory") {
    return new MemoryRecordStore();
  }

  if (type === "sqlite") {
    return new SqliteRecordStore({
      path: resolve(baseDir, records.path ?? "data/brainstem.sqlite"),
      pruneAfterDays: records.pruneAfterDays ?? null
    });
  }

  throw new Error(`Unsupported record store type '${type}'`);
}

export function createCheckpointStore(config, baseDir) {
  const checkpoints = config.runtime?.checkpoints;

  if (checkpoints === false) {
    return new MemoryCheckpointStore();
  }

  const type = checkpoints?.type ?? "json";

  if (type === "memory") {
    return new MemoryCheckpointStore();
  }

  if (type === "json") {
    return new JsonFileCheckpointStore(
      resolve(baseDir, checkpoints?.path ?? "data/checkpoints.json")
    );
  }

  throw new Error(`Unsupported checkpoint store type '${type}'`);
}

export function storeInfo(store) {
  if (!store) return null;
  return {
    type: store.constructor?.name ?? "unknown",
    path: store.path ?? null
  };
}
