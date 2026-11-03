import { createHash } from "node:crypto";
import { hostname } from "node:os";

import packageJson from "../../package.json" with { type: "json" };

/*
 * Core registry: which runtime processes exist, whether they are
 * alive, and what topology each one loaded.
 *
 * With one runtime there is one row; several cores (Phase 3)
 * simply add rows. Consumers (the API, the Web UI) never need to
 * know which core spoke last.
 */
export const DEFAULT_CORE_HEARTBEAT_MS = 10_000;

// Missed heartbeats before a running core counts as lost.
const LOST_AFTER_HEARTBEATS = 3;

export function createCoreRegistry({ database }) {
  async function db() {
    return (await database()).db;
  }

  return {
    async register({ id, role = "all", queues = [], heartbeatMs, topology, configVersion = null, now = Date.now() }) {
      const row = {
        id,
        role,
        queues_json: JSON.stringify(queues),
        version: packageJson.version ?? null,
        hostname: hostname(),
        pid: process.pid,
        status: "running",
        heartbeat_ms: heartbeatMs,
        started_at: new Date(now).toISOString(),
        last_seen_at: now,
        stopped_at: null,
        config_version: configVersion,
        ...topologyColumns(topology)
      };

      await (await db())
        .insertInto("cores")
        .values(row)
        .onConflict(conflict => conflict.column("id").doUpdateSet(row))
        .execute();
    },

    async heartbeat(id, { topology, configVersion, now = Date.now() } = {}) {
      await (await db())
        .updateTable("cores")
        .set({
          status: "running",
          last_seen_at: now,
          stopped_at: null,
          ...(configVersion === undefined ? {} : { config_version: configVersion }),
          ...(topology ? topologyColumns(topology) : {})
        })
        .where("id", "=", id)
        .execute();
    },

    async stop(id, { now = Date.now() } = {}) {
      await (await db())
        .updateTable("cores")
        .set({
          status: "stopped",
          last_seen_at: now,
          stopped_at: new Date(now).toISOString()
        })
        .where("id", "=", id)
        .execute();
    },

    async list({ now = Date.now() } = {}) {
      const rows = await (await db())
        .selectFrom("cores")
        .selectAll()
        .orderBy("last_seen_at", "desc")
        .execute();

      return rows.map(row => toCore(row, now));
    },

    /*
     * Forget cores that stopped or went silent long ago.
     */
    async prune({ olderThanMs, now = Date.now() }) {
      const result = await (await db())
        .deleteFrom("cores")
        .where("last_seen_at", "<", now - olderThanMs)
        .executeTakeFirst();

      return Number(result?.numDeletedRows ?? 0);
    }
  };
}

/*
 * The topology to serve. Cores may run different queues
 * (--queues), so inputs and destinations are merged across running
 * cores (any core when none is running), the most recently seen
 * core winning per id.
 *
 * `consistent` is false when running cores run different config
 * versions, or loaded different definitions for the same part of
 * the pipeline.
 */
export function topologyFromCores(cores) {
  const running = cores.filter(core => core.status === "running");
  const sources = running.length > 0 ? running : cores.slice(0, 1);
  const source = sources[0] ?? null;
  const inputs = new Map();
  const destinations = new Map();

  for (const core of sources) {
    for (const input of core.topology.inputs ?? []) {
      if (!inputs.has(input.id)) inputs.set(input.id, input);
    }
    for (const destination of core.topology.destinations ?? []) {
      if (!destinations.has(destination.id)) destinations.set(destination.id, destination);
    }
  }

  /*
   * Cores on the same stored config version agree by definition.
   * Otherwise compare what overlapping cores loaded: inputs among
   * cores that poll, destinations among cores that decide or deliver.
   */
  const versions = new Set(running.map(core => core.configVersion ?? null));
  const sameVersion = versions.size === 1 && !versions.has(null);
  const runs = (core, queue) => !core.queues?.length || core.queues.includes(queue);
  const inputHashes = new Set(
    running
      .filter(core => runs(core, "poll"))
      .map(core => topologyHash((core.topology.inputs ?? []).map(input => input.id)))
  );
  const destinationHashes = new Set(
    running
      .filter(core => runs(core, "decide") || runs(core, "deliver"))
      .map(core => topologyHash(core.topology.destinations ?? []))
  );
  const consistent = sameVersion || (versions.size <= 1 && inputHashes.size <= 1 && destinationHashes.size <= 1);

  return {
    source: source
      ? { coreId: source.id, status: source.status, topologyHash: source.topologyHash }
      : null,
    configVersion: versions.size === 1 ? [...versions][0] : null,
    consistent,
    inputs: [...inputs.values()],
    destinations: [...destinations.values()]
  };
}

export function topologyHash(topology) {
  return createHash("sha256")
    .update(JSON.stringify(topology))
    .digest("hex")
    .slice(0, 16);
}

function topologyColumns(topology = { inputs: [], destinations: [] }) {
  return {
    topology_json: JSON.stringify(topology),
    topology_hash: topologyHash(topology)
  };
}

function toCore(row, now) {
  const lastSeenAt = Number(row.last_seen_at);
  const heartbeatMs = Number(row.heartbeat_ms);
  const lost =
    row.status === "running" &&
    now - lastSeenAt > heartbeatMs * LOST_AFTER_HEARTBEATS;

  return {
    id: row.id,
    role: row.role,
    queues: JSON.parse(row.queues_json),
    version: row.version,
    hostname: row.hostname,
    pid: row.pid === null ? null : Number(row.pid),
    status: lost ? "lost" : row.status,
    heartbeatMs,
    startedAt: row.started_at,
    lastSeenAt: new Date(lastSeenAt).toISOString(),
    stoppedAt: row.stopped_at,
    topologyHash: row.topology_hash,
    configVersion: row.config_version === null || row.config_version === undefined
      ? null
      : Number(row.config_version),
    topology: JSON.parse(row.topology_json)
  };
}
