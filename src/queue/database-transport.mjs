import { sql } from "kysely";

import {
  LeaseLostError,
  createWakeups,
  errorText,
  jobFromRow,
  jobRow
} from "./transport.mjs";

/*
 * Database transport on the `jobs` table (migration 0002).
 *
 * One implementation for both dialects. Every state change is a
 * single statement, so it is atomic on SQLite (one writer at a
 * time) and on Postgres, where the claim additionally uses
 * FOR UPDATE SKIP LOCKED so concurrent claimers never block on
 * each other.
 *
 * Wakeups are in-process. Other processes sharing the database
 * (e.g. the API redriving a job) are seen on the workers' next
 * poll; LISTEN/NOTIFY arrives with the Postgres cluster driver
 * (roadmap Phase 3).
 *
 * `database` is a handle from openDatabase() ({ db, dialect }),
 * a promise of one, or a function returning one. The transport
 * never closes it.
 */
export class DatabaseTransport {
  constructor({ database, now = Date.now } = {}) {
    if (!database) {
      throw new Error("DatabaseTransport requires a database handle");
    }

    this.database = database;
    this.now = now;
    this.handle = null;
    this.opening = null;
    this.wakeups = createWakeups();
  }

  get type() {
    return "database";
  }

  get durable() {
    return true;
  }

  async open() {
    if (this.handle) return this.handle;

    this.opening ??= (async () => {
      const handle = typeof this.database === "function"
        ? await this.database()
        : await this.database;

      this.handle = handle;
      return handle;
    })();

    try {
      return await this.opening;
    }
    catch (error) {
      this.opening = null;
      throw error;
    }
  }

  async #db(executor) {
    return executor ?? (await this.open()).db;
  }

  subscribe(listener) {
    return this.wakeups.subscribe(listener);
  }

  notify() {
    this.wakeups.notify();
  }

  async transaction(fn) {
    const { db } = await this.open();
    const result = await db.transaction().execute(trx => fn(trx));
    this.notify();
    return result;
  }

  async enqueue(jobs, { executor } = {}) {
    const db = await this.#db(executor);
    const now = this.now();
    const ids = [];

    for (const job of jobs) {
      const row = await db.insertInto("jobs")
        .values(jobRow(job, { now }))
        .onConflict(conflict => conflict.column("job_key").doNothing())
        .returning("id")
        .executeTakeFirst();

      if (row) ids.push(Number(row.id));
    }

    if (!executor && ids.length > 0) this.notify();

    return ids;
  }

  async claim({ queues, limit = 1, leaseMs, workerId }) {
    if (!queues?.length || limit <= 0) return [];

    const { db, dialect } = await this.open();
    const now = this.now();
    const lockClause = dialect === "postgres"
      ? sql`for update skip locked`
      : sql``;

    /*
     * A job is due when it is ready and its run_at has passed,
     * and no earlier job with the same queue_key is still ready
     * or running (per-key FIFO, graphile-worker style). Dead jobs
     * do not block their key.
     */
    const result = await sql`
      update jobs
      set state = 'running',
          attempts = attempts + 1,
          locked_by = ${workerId},
          locked_until = ${now + leaseMs},
          updated_at = ${new Date(now).toISOString()}
      where id in (
        select j.id from jobs j
        where j.state = 'ready'
          and j.queue in (${sql.join(queues)})
          and j.run_at <= ${now}
          and (
            j.queue_key is null
            or not exists (
              select 1 from jobs o
              where o.queue_key = j.queue_key
                and o.id < j.id
                and o.state in ('ready', 'running')
            )
          )
        order by j.run_at, j.id
        limit ${limit}
        ${lockClause}
      )
      returning *
    `.execute(db);

    return result.rows
      .map(jobFromRow)
      .sort((a, b) => a.id - b.id);
  }

  async ack(job, { executor } = {}) {
    const db = await this.#db(executor);
    const result = await db.deleteFrom("jobs")
      .where("id", "=", job.id)
      .where("locked_by", "=", job.lockedBy)
      .where("state", "=", "running")
      .executeTakeFirst();

    if (Number(result?.numDeletedRows ?? 0) === 0) {
      throw new LeaseLostError(job);
    }
  }

  async nack(job, { error, runAt, dead = false, executor } = {}) {
    const db = await this.#db(executor);
    const now = this.now();
    const result = await db.updateTable("jobs")
      .set({
        state: dead ? "dead" : "ready",
        run_at: dead ? now : Number(runAt ?? now),
        locked_by: null,
        locked_until: null,
        last_error: errorText(error),
        updated_at: new Date(now).toISOString()
      })
      .where("id", "=", job.id)
      .where("locked_by", "=", job.lockedBy)
      .where("state", "=", "running")
      .executeTakeFirst();

    return Number(result?.numUpdatedRows ?? 0) > 0;
  }

  async release(job) {
    const { db } = await this.open();
    const now = this.now();
    const result = await db.updateTable("jobs")
      .set(eb => ({
        state: "ready",
        attempts: eb("attempts", "-", 1),
        locked_by: null,
        locked_until: null,
        updated_at: new Date(now).toISOString()
      }))
      .where("id", "=", job.id)
      .where("locked_by", "=", job.lockedBy)
      .where("state", "=", "running")
      .executeTakeFirst();

    const released = Number(result?.numUpdatedRows ?? 0) > 0;
    if (released) this.notify();
    return released;
  }

  async extend(job, leaseMs) {
    const { db } = await this.open();
    const now = this.now();
    const lockedUntil = now + leaseMs;
    const result = await db.updateTable("jobs")
      .set({ locked_until: lockedUntil })
      .where("id", "=", job.id)
      .where("locked_by", "=", job.lockedBy)
      .where("state", "=", "running")
      .executeTakeFirst();

    if (Number(result?.numUpdatedRows ?? 0) === 0) return false;

    job.lockedUntil = lockedUntil;
    return true;
  }

  /*
   * Expired leases (a crashed or partitioned worker) go back to
   * `ready`, or to `dead` once their attempts are used up.
   * Returns the affected jobs with their new state.
   */
  async reclaimStalled() {
    const { db } = await this.open();
    const now = this.now();
    const result = await sql`
      update jobs
      set state = case when attempts >= max_attempts then 'dead' else 'ready' end,
          run_at = ${now},
          locked_by = null,
          locked_until = null,
          last_error = ${"Lease expired before the job finished"},
          updated_at = ${new Date(now).toISOString()}
      where state = 'running'
        and locked_until < ${now}
      returning *
    `.execute(db);

    const jobs = result.rows.map(jobFromRow);
    if (jobs.some(job => job.state === "ready")) this.notify();
    return jobs;
  }

  async nextRunAt(queues) {
    if (!queues?.length) return null;

    const { db } = await this.open();
    const row = await db.selectFrom("jobs")
      .select(eb => eb.fn.min("run_at").as("run_at"))
      .where("state", "=", "ready")
      .where("queue", "in", queues)
      .executeTakeFirst();

    return row?.run_at === null || row?.run_at === undefined
      ? null
      : Number(row.run_at);
  }

  // Admin.

  async getJob(id, { executor } = {}) {
    const db = await this.#db(executor);
    const row = await db.selectFrom("jobs")
      .selectAll()
      .where("id", "=", Number(id))
      .executeTakeFirst();

    return row ? jobFromRow(row) : null;
  }

  async listJobs({ state, queue, limit = 100, beforeId } = {}) {
    const { db } = await this.open();
    let query = db.selectFrom("jobs").selectAll();

    if (state) query = query.where("state", "=", state);
    if (queue) query = query.where("queue", "=", queue);
    if (beforeId) query = query.where("id", "<", Number(beforeId));

    const rows = await query
      .orderBy("id", "desc")
      .limit(limit)
      .execute();

    return rows.map(jobFromRow);
  }

  /*
   * Put a dead job back in the queue with fresh attempts.
   */
  async redrive(id, { executor } = {}) {
    const db = await this.#db(executor);
    const now = this.now();
    const row = await db.updateTable("jobs")
      .set({
        state: "ready",
        attempts: 0,
        run_at: now,
        locked_by: null,
        locked_until: null,
        updated_at: new Date(now).toISOString()
      })
      .where("id", "=", Number(id))
      .where("state", "=", "dead")
      .returningAll()
      .executeTakeFirst();

    if (row && !executor) this.notify();

    return row ? jobFromRow(row) : null;
  }

  async discard(id, { executor } = {}) {
    const db = await this.#db(executor);
    const row = await db.deleteFrom("jobs")
      .where("id", "=", Number(id))
      .where("state", "=", "dead")
      .returningAll()
      .executeTakeFirst();

    return row ? jobFromRow(row) : null;
  }

  async counts() {
    const { db } = await this.open();
    const rows = await db.selectFrom("jobs")
      .select(eb => [
        "queue",
        "state",
        eb.fn.countAll().as("count"),
        eb.fn.min("run_at").as("oldest_run_at")
      ])
      .groupBy(["queue", "state"])
      .execute();

    return rows.map(row => ({
      queue: row.queue,
      state: row.state,
      count: Number(row.count),
      oldestRunAt: row.oldest_run_at === null ? null : Number(row.oldest_run_at)
    }));
  }

  async close() {}
}
