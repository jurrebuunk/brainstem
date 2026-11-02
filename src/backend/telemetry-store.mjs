import {
  eventSourceKey,
  metricsForEvent
} from "../telemetry/events.mjs";
import { describeDatabase } from "./db-utils.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

/*
 * Telemetry persistence on the shared database handle
 * ({ db, dialect } from src/db). Writes only insert and bump
 * counters; retention pruning runs from periodic maintenance
 * (prune()) instead of the per-event write path.
 */
export function createTelemetryStore({
  database,
  statsPruneAfterDays,
  eventLogPruneAfterDays,
  eventLogMaxRows
}) {
  const { db } = database;

  return {
    path: describeDatabase(database.url),

    async persistEvent(event) {
      await db.transaction().execute(async trx => {
        await insertEvent(trx, event);
        await recordStatsEvent(trx, event);
      });
    },

    async prune({ now = new Date() } = {}) {
      return await pruneTelemetry(db, {
        now,
        statsPruneAfterDays,
        eventLogPruneAfterDays,
        eventLogMaxRows
      });
    },

    async getEvents(options) {
      return await getEvents(db, options);
    },

    async getStats() {
      return await getStats(db);
    },

    async eventCount() {
      const row = await db.selectFrom("web_events")
        .select(eb => eb.fn.countAll().as("count"))
        .executeTakeFirst();
      return Number(row?.count ?? 0);
    },

    async close() {
      // The database handle is owned by the caller.
    }
  };
}

async function insertEvent(db, event) {
  const payload = event.payload ?? {};
  await db.insertInto("web_events")
    .values({
      received_at: event.receivedAt ?? payload.timestamp ?? new Date().toISOString(),
      kind: String(event.kind ?? "external.json"),
      level: eventLevelForStorage(event),
      source: eventSourceKey(event),
      event_json: JSON.stringify(event)
    })
    .execute();
}

function eventLevelForStorage(event) {
  const payload = event.payload ?? {};
  if (event.kind === "brainstem.plugin.log" || event.kind === "brainstem.log") {
    return payload.level ? String(payload.level) : "info";
  }
  if (String(event.kind ?? "").includes("failed")) return "error";
  if (event.kind === "brainstem.output") return "output";
  return null;
}

async function recordStatsEvent(db, event) {
  // Sorted so concurrent writers lock counter rows in the same order.
  const metrics = [...new Set(metricsForEvent(event))].sort();
  if (metrics.length === 0) return;

  const bucket = minuteBucket(event.receivedAt ?? event.payload?.timestamp ?? new Date().toISOString());

  await db.insertInto("stat_counters")
    .values(metrics.map(metric => ({ key: metric, value: 1 })))
    .onConflict(oc => oc.column("key").doUpdateSet({
      value: eb => eb("stat_counters.value", "+", eb.ref("excluded.value"))
    }))
    .execute();

  await db.insertInto("stat_timeseries")
    .values(metrics.map(metric => ({ bucket, metric, value: 1 })))
    .onConflict(oc => oc.columns(["bucket", "metric"]).doUpdateSet({
      value: eb => eb("stat_timeseries.value", "+", eb.ref("excluded.value"))
    }))
    .execute();
}

async function pruneTelemetry(db, { now, statsPruneAfterDays, eventLogPruneAfterDays, eventLogMaxRows }) {
  const result = { stats: 0, eventsByAge: 0, eventsByRows: 0 };

  if (Number.isFinite(statsPruneAfterDays) && statsPruneAfterDays > 0) {
    const cutoff = new Date(now.getTime() - statsPruneAfterDays * DAY_MS).toISOString();
    const deleted = await db.deleteFrom("stat_timeseries")
      .where("bucket", "<", cutoff)
      .executeTakeFirst();
    result.stats = Number(deleted.numDeletedRows ?? 0);
  }

  if (Number.isFinite(eventLogPruneAfterDays) && eventLogPruneAfterDays > 0) {
    const cutoff = new Date(now.getTime() - eventLogPruneAfterDays * DAY_MS).toISOString();
    const deleted = await db.deleteFrom("web_events")
      .where("received_at", "<", cutoff)
      .executeTakeFirst();
    result.eventsByAge = Number(deleted.numDeletedRows ?? 0);
  }

  if (Number.isFinite(eventLogMaxRows) && eventLogMaxRows > 0) {
    // Keep the newest eventLogMaxRows rows: find the id of the
    // first row past the limit and delete it and everything older.
    const boundary = await db.selectFrom("web_events")
      .select("id")
      .orderBy("id", "desc")
      .limit(1)
      .offset(eventLogMaxRows)
      .executeTakeFirst();

    if (boundary) {
      const deleted = await db.deleteFrom("web_events")
        .where("id", "<=", boundary.id)
        .executeTakeFirst();
      result.eventsByRows = Number(deleted.numDeletedRows ?? 0);
    }
  }

  return result;
}

async function getEvents(db, { limit, before, after, kind, level, source } = {}) {
  const beforeIso = optionalIsoDate(before);
  const afterIso = optionalIsoDate(after);
  let query = db.selectFrom("web_events").select(["id", "event_json"]);

  if (beforeIso) query = query.where("received_at", "<", beforeIso);
  if (afterIso) query = query.where("received_at", ">", afterIso);
  if (kind) query = query.where("kind", "=", kind);
  if (level) query = query.where("level", "=", level);
  if (source) query = query.where("source", "=", source);

  const rows = await query
    .orderBy("received_at", "desc")
    .orderBy("id", "desc")
    .limit(limit ?? 2000)
    .execute();

  return rows
    .reverse()
    .map(row => parseStoredEvent(row.event_json, Number(row.id)))
    .filter(Boolean);
}

function parseStoredEvent(value, id) {
  try {
    const event = JSON.parse(value);
    if (event && typeof event === "object") {
      return { ...event, persistedId: id };
    }
  }
  catch {
    return null;
  }

  return null;
}

async function getStats(db) {
  const counterRows = await db.selectFrom("stat_counters")
    .select(["key", "value"])
    .orderBy("key")
    .execute();
  const counters = Object.fromEntries(counterRows.map(row => [row.key, Number(row.value)]));

  const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const rows = await db.selectFrom("stat_timeseries")
    .select(["bucket", "metric", "value"])
    .where("bucket", ">=", cutoff)
    .orderBy("bucket", "asc")
    .execute();

  return {
    counters,
    series: rows.map(row => ({ ...row, value: Number(row.value) })),
    generatedAt: new Date().toISOString()
  };
}

function minuteBucket(value) {
  const date = new Date(value);
  date.setSeconds(0, 0);
  return date.toISOString();
}

function optionalIsoDate(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}
