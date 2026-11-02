import {
  LeaseLostError,
  createWakeups,
  errorText,
  jobFromRow,
  jobRow
} from "./transport.mjs";

/*
 * In-process transport with the same semantics as the database
 * driver: dedupe by job_key, per-queue_key FIFO, leases, retries
 * and dead jobs.
 *
 * Not durable: jobs live in this process only. Used when the
 * runtime keeps no database state (memory/json checkpoints) and
 * in tests. Payloads are stored as JSON text, so a payload that
 * would not survive the database driver fails here too.
 */
export class MemoryTransport {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.rows = new Map();
    this.nextId = 1;
    this.wakeups = createWakeups();
  }

  get type() {
    return "memory";
  }

  get durable() {
    return false;
  }

  async open() {}

  subscribe(listener) {
    return this.wakeups.subscribe(listener);
  }

  notify() {
    this.wakeups.notify();
  }

  /*
   * No rollback: writes made before a failure stay. Callers order
   * their writes so a partial transaction only causes a retry.
   */
  async transaction(fn) {
    const result = await fn(null);
    this.notify();
    return result;
  }

  async enqueue(jobs, { executor } = {}) {
    const now = this.now();
    const ids = [];

    for (const job of jobs) {
      const row = jobRow(job, { now });

      if (
        row.job_key !== null &&
        [...this.rows.values()].some(existing => existing.job_key === row.job_key)
      ) {
        continue;
      }

      const id = this.nextId++;
      this.rows.set(id, { id, ...row });
      ids.push(id);
    }

    if (executor === undefined && ids.length > 0) this.notify();

    return ids;
  }

  async claim({ queues, limit = 1, leaseMs, workerId }) {
    if (!queues?.length || limit <= 0) return [];

    const now = this.now();
    const ordered = [...this.rows.values()].sort((a, b) => a.id - b.id);
    const due = ordered
      .filter(row =>
        row.state === "ready" &&
        queues.includes(row.queue) &&
        row.run_at <= now &&
        (
          row.queue_key === null ||
          !ordered.some(other =>
            other.queue_key === row.queue_key &&
            other.id < row.id &&
            (other.state === "ready" || other.state === "running")
          )
        )
      )
      .sort((a, b) => a.run_at - b.run_at || a.id - b.id)
      .slice(0, limit);

    for (const row of due) {
      row.state = "running";
      row.attempts += 1;
      row.locked_by = workerId;
      row.locked_until = now + leaseMs;
      row.updated_at = new Date(now).toISOString();
    }

    return due.map(row => jobFromRow(row));
  }

  #owned(job) {
    const row = this.rows.get(job.id);

    return row &&
      row.state === "running" &&
      row.locked_by === job.lockedBy
      ? row
      : null;
  }

  async ack(job) {
    if (!this.#owned(job)) throw new LeaseLostError(job);
    this.rows.delete(job.id);
  }

  async nack(job, { error, runAt, dead = false } = {}) {
    const row = this.#owned(job);
    if (!row) return false;

    const now = this.now();
    row.state = dead ? "dead" : "ready";
    row.run_at = dead ? now : Number(runAt ?? now);
    row.locked_by = null;
    row.locked_until = null;
    row.last_error = errorText(error);
    row.updated_at = new Date(now).toISOString();
    return true;
  }

  async release(job) {
    const row = this.#owned(job);
    if (!row) return false;

    row.state = "ready";
    row.attempts = Math.max(0, row.attempts - 1);
    row.locked_by = null;
    row.locked_until = null;
    row.updated_at = new Date(this.now()).toISOString();
    this.notify();
    return true;
  }

  async extend(job, leaseMs) {
    const row = this.#owned(job);
    if (!row) return false;

    row.locked_until = this.now() + leaseMs;
    job.lockedUntil = row.locked_until;
    return true;
  }

  async reclaimStalled() {
    const now = this.now();
    const reclaimed = [];

    for (const row of this.rows.values()) {
      if (row.state !== "running" || row.locked_until >= now) continue;

      row.state = row.attempts >= row.max_attempts ? "dead" : "ready";
      row.run_at = now;
      row.locked_by = null;
      row.locked_until = null;
      row.last_error = "Lease expired before the job finished";
      row.updated_at = new Date(now).toISOString();
      reclaimed.push(jobFromRow(row));
    }

    if (reclaimed.some(job => job.state === "ready")) this.notify();
    return reclaimed;
  }

  async nextRunAt(queues) {
    let next = null;

    for (const row of this.rows.values()) {
      if (row.state !== "ready" || !queues.includes(row.queue)) continue;
      if (next === null || row.run_at < next) next = row.run_at;
    }

    return next;
  }

  async getJob(id) {
    const row = this.rows.get(Number(id));
    return row ? jobFromRow(row) : null;
  }

  async listJobs({ state, queue, limit = 100, beforeId } = {}) {
    return [...this.rows.values()]
      .filter(row =>
        (!state || row.state === state) &&
        (!queue || row.queue === queue) &&
        (!beforeId || row.id < Number(beforeId))
      )
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map(row => jobFromRow(row));
  }

  async redrive(id, { executor } = {}) {
    const row = this.rows.get(Number(id));
    if (!row || row.state !== "dead") return null;

    row.state = "ready";
    row.attempts = 0;
    row.run_at = this.now();
    row.updated_at = new Date(row.run_at).toISOString();
    if (executor === undefined) this.notify();
    return jobFromRow(row);
  }

  async discard(id) {
    const row = this.rows.get(Number(id));
    if (!row || row.state !== "dead") return null;

    this.rows.delete(row.id);
    return jobFromRow(row);
  }

  async counts() {
    const groups = new Map();

    for (const row of this.rows.values()) {
      const key = `${row.queue}\u0000${row.state}`;
      const group = groups.get(key) ?? {
        queue: row.queue,
        state: row.state,
        count: 0,
        oldestRunAt: null
      };

      group.count += 1;
      group.oldestRunAt = group.oldestRunAt === null
        ? row.run_at
        : Math.min(group.oldestRunAt, row.run_at);
      groups.set(key, group);
    }

    return [...groups.values()];
  }

  async close() {}
}
