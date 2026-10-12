import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  eventSourceKey,
  metricsForEvent
} from "../telemetry/events.mjs";

export function createTelemetryStore({
  path,
  statsPruneAfterDays,
  eventLogPruneAfterDays,
  eventLogMaxRows
}) {
  mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  initTelemetryDb(db);

  return {
    path,

    persistEvent(event) {
      db.exec("begin immediate");
      try {
        insertEvent(db, event);
        recordStatsEvent(db, event);
        pruneOldStats(db, event.receivedAt ?? event.payload?.timestamp ?? new Date().toISOString(), statsPruneAfterDays);
        pruneOldEvents(db, event.receivedAt ?? event.payload?.timestamp ?? new Date().toISOString(), {
          eventLogPruneAfterDays,
          eventLogMaxRows
        });
        db.exec("commit");
      }
      catch (error) {
        db.exec("rollback");
        throw error;
      }
    },

    getEvents(options) {
      return getEvents(db, options);
    },

    getStats() {
      return getStats(db);
    },

    eventCount() {
      return db.prepare("select count(*) as count from web_events").get().count;
    },

    close() {
      db.close();
    }
  };
}

function initTelemetryDb(db) {
  db.exec(`
    pragma journal_mode = wal;
    pragma busy_timeout = 5000;
    pragma foreign_keys = on;

    create table if not exists web_events (
      id integer primary key autoincrement,
      received_at text not null,
      kind text not null,
      level text,
      source text,
      event_json text not null
    );

    create index if not exists idx_web_events_received_at on web_events (received_at);
    create index if not exists idx_web_events_kind on web_events (kind);
    create index if not exists idx_web_events_level on web_events (level);
    create index if not exists idx_web_events_source on web_events (source);

    create table if not exists stat_counters (
      key text primary key,
      value integer not null default 0
    );

    create table if not exists stat_timeseries (
      bucket text not null,
      metric text not null,
      value integer not null default 0,
      primary key (bucket, metric)
    );
  `);
}

function insertEvent(db, event) {
  const payload = event.payload ?? {};
  db.prepare(`
    insert into web_events (received_at, kind, level, source, event_json)
    values (?, ?, ?, ?, ?)
  `).run(
    event.receivedAt ?? payload.timestamp ?? new Date().toISOString(),
    String(event.kind ?? "external.json"),
    eventLevelForStorage(event),
    eventSourceKey(event),
    JSON.stringify(event)
  );
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

function recordStatsEvent(db, event) {
  const metrics = metricsForEvent(event);
  if (metrics.length === 0) return;

  const bucket = minuteBucket(event.receivedAt ?? event.payload?.timestamp ?? new Date().toISOString());
  const counter = db.prepare(`
    insert into stat_counters (key, value) values (?, ?)
    on conflict(key) do update set value = value + excluded.value
  `);
  const series = db.prepare(`
    insert into stat_timeseries (bucket, metric, value) values (?, ?, ?)
    on conflict(bucket, metric) do update set value = value + excluded.value
  `);

  for (const metric of metrics) {
    counter.run(metric, 1);
    series.run(bucket, metric, 1);
  }
}

function pruneOldStats(db, currentBucket, statsPruneAfterDays) {
  if (!Number.isFinite(statsPruneAfterDays) || statsPruneAfterDays <= 0) return;

  const cutoff = new Date(
    Date.parse(currentBucket) - statsPruneAfterDays * 24 * 60 * 60 * 1000
  ).toISOString();

  db.prepare("delete from stat_timeseries where bucket < ?").run(cutoff);
}

function pruneOldEvents(db, currentTimestamp, { eventLogPruneAfterDays, eventLogMaxRows }) {
  if (Number.isFinite(eventLogPruneAfterDays) && eventLogPruneAfterDays > 0) {
    const cutoff = new Date(
      Date.parse(currentTimestamp) - eventLogPruneAfterDays * 24 * 60 * 60 * 1000
    ).toISOString();

    db.prepare("delete from web_events where received_at < ?").run(cutoff);
  }

  if (Number.isFinite(eventLogMaxRows) && eventLogMaxRows > 0) {
    db.prepare(`
      delete from web_events
      where id in (
        select id from web_events
        order by id desc
        limit -1 offset ?
      )
    `).run(eventLogMaxRows);
  }
}

function getEvents(db, { limit, before, after, kind, level, source } = {}) {
  const clauses = [];
  const params = [];
  const beforeIso = optionalIsoDate(before);
  const afterIso = optionalIsoDate(after);

  if (beforeIso) {
    clauses.push("received_at < ?");
    params.push(beforeIso);
  }

  if (afterIso) {
    clauses.push("received_at > ?");
    params.push(afterIso);
  }

  if (kind) {
    clauses.push("kind = ?");
    params.push(kind);
  }

  if (level) {
    clauses.push("level = ?");
    params.push(level);
  }

  if (source) {
    clauses.push("source = ?");
    params.push(source);
  }

  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  const rows = db.prepare(`
    select id, event_json
    from web_events
    ${where}
    order by received_at desc, id desc
    limit ?
  `).all(...params, limit);

  return rows
    .reverse()
    .map(row => parseStoredEvent(row.event_json, row.id))
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

function getStats(db) {
  const counters = Object.fromEntries(
    db.prepare("select key, value from stat_counters order by key").all()
      .map(row => [row.key, row.value])
  );

  const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    select bucket, metric, value
    from stat_timeseries
    where bucket >= ?
    order by bucket asc
  `).all(cutoff);

  return {
    counters,
    series: rows,
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
