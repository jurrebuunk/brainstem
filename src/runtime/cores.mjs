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
    async register({ id, role = "all", queues = [], heartbeatMs, topology, now = Date.now() }) {
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
        ...topologyColumns(topology)
      };

      await (await db())
        .insertInto("cores")
        .values(row)
        .onConflict(conflict => conflict.column("id").doUpdateSet(row))
        .execute();
    },

    async heartbeat(id, { topology, now = Date.now() } = {}) {
      await (await db())
        .updateTable("cores")
        .set({
          status: "running",
          last_seen_at: now,
          stopped_at: null,
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
 * The topology to serve: from the most recently seen running
 * core (any core when none is running), plus whether all running
 * cores agree on it.
 */
export function topologyFromCores(cores) {
  const running = cores.filter(core => core.status === "running");
  const source = running[0] ?? cores[0] ?? null;
  const hashes = new Set(running.map(core => core.topologyHash));

  return {
    source: source
      ? { coreId: source.id, status: source.status, topologyHash: source.topologyHash }
      : null,
    consistent: hashes.size <= 1,
    inputs: source?.topology.inputs ?? [],
    destinations: source?.topology.destinations ?? []
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
    topology: JSON.parse(row.topology_json)
  };
}
