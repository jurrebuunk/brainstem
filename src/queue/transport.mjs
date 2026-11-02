import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

/*
 * Transport: the job queue between pipeline stages
 * (roadmap §4.5, ADR-0003).
 *
 * Every driver implements the same contract:
 *
 *   transaction(fn)            run fn(executor) atomically; pass the
 *                              executor to enqueue/ack and to stores
 *                              that write in the same transaction
 *   enqueue(jobs, { executor }) insert jobs; a duplicate job_key is
 *                              skipped. Returns the new ids.
 *   claim({ queues, limit, leaseMs, workerId })
 *                              lock up to `limit` due jobs. Jobs that
 *                              share a queue_key run one at a time, in
 *                              id order. A claim is never an ack.
 *   ack(job, { executor })     delete a finished job; throws
 *                              LeaseLostError when another worker
 *                              reclaimed it meanwhile
 *   nack(job, { error, runAt, dead })
 *                              schedule a retry, or move to `dead`
 *   release(job)               give a job back without counting the
 *                              attempt (shutdown)
 *   extend(job, leaseMs)       heartbeat; false when the lease is lost
 *   reclaimStalled()           return expired leases to `ready` (or
 *                              `dead` when out of attempts)
 *   subscribe(fn)              wakeup on new work; returns unsubscribe
 *   nextRunAt(queues)          earliest run_at of a ready job, or null
 *
 * Admin (API / UI): listJobs, getJob, redrive, discard, counts.
 *
 * Drivers: `database` (Kysely; SQLite and Postgres) and `memory`
 * (process-local, not durable).
 */

export const JOB_STATES = ["ready", "running", "dead"];

export const DEFAULT_LEASE_MS = 60_000;

export class LeaseLostError extends Error {
  constructor(job) {
    super(`Lease on job ${job.id} (${job.queue}) was lost`);
    this.name = "LeaseLostError";
    this.code = "BRAINSTEM_LEASE_LOST";
    this.jobId = job.id;
  }
}

/*
 * Throw from a job handler to skip the remaining attempts and
 * move the job straight to `dead`.
 */
export class PermanentJobError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "PermanentJobError";
    this.permanent = true;
  }
}

export function createWorkerId() {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

/*
 * Retry policy for one queue.
 *
 * Exponential backoff with "equal jitter": half the delay is
 * fixed, half random, so retries from a burst of failures do not
 * arrive together.
 */
export function normalizeJobRetry(retry = {}, defaults = {}) {
  const merged = { ...defaults, ...retry };
  const attempts = Math.max(1, Math.floor(Number(merged.attempts ?? 1)));
  const minDelayMs = Math.max(0, Number(merged.minDelayMs ?? 0));
  const maxDelayMs = Math.max(minDelayMs, Number(merged.maxDelayMs ?? minDelayMs));
  const factor = Math.max(1, Number(merged.factor ?? 1));
  const jitter = merged.jitter !== false;

  return { attempts, minDelayMs, maxDelayMs, factor, jitter };
}

export function backoffDelayMs(retry, attempt, random = Math.random) {
  const base = Math.min(
    retry.maxDelayMs,
    retry.minDelayMs * retry.factor ** Math.max(0, attempt - 1)
  );

  if (!retry.jitter || base === 0) return base;

  return Math.round(base / 2 + random() * (base / 2));
}

export function errorText(error) {
  if (!error) return null;

  const text = error instanceof AggregateError
    ? [error.message, ...error.errors.map(item => item?.message ?? String(item))].join("; ")
    : error.message ?? String(error);

  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

export function jobFromRow(row) {
  return {
    id: Number(row.id),
    queue: row.queue,
    jobKey: row.job_key ?? null,
    queueKey: row.queue_key ?? null,
    payload: JSON.parse(row.payload_json),
    state: row.state,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    runAt: Number(row.run_at),
    lockedBy: row.locked_by ?? null,
    lockedUntil: row.locked_until === null || row.locked_until === undefined
      ? null
      : Number(row.locked_until),
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/*
 * Validate and serialize one job for enqueue().
 */
export function jobRow(job, { now }) {
  if (typeof job.queue !== "string" || job.queue.length === 0) {
    throw new TypeError("Job requires a queue name");
  }

  const maxAttempts = Math.max(1, Math.floor(Number(job.maxAttempts ?? 1)));
  const iso = new Date(now).toISOString();

  return {
    queue: job.queue,
    job_key: job.jobKey ?? null,
    queue_key: job.queueKey ?? null,
    payload_json: JSON.stringify(job.payload ?? {}),
    state: "ready",
    attempts: 0,
    max_attempts: maxAttempts,
    run_at: Number(job.runAt ?? now),
    locked_by: null,
    locked_until: null,
    last_error: null,
    created_at: iso,
    updated_at: iso
  };
}

/*
 * Tiny wakeup bus shared by both drivers. Listeners are called
 * asynchronously so a notifying transaction never runs worker
 * code inline.
 */
export function createWakeups() {
  const listeners = new Set();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    notify() {
      for (const listener of listeners) {
        queueMicrotask(() => listener());
      }
    }
  };
}
