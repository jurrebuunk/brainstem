import {
  DEFAULT_LEASE_MS,
  LeaseLostError,
  backoffDelayMs,
  createWorkerId
} from "./transport.mjs";

export const DEFAULT_POLL_INTERVAL_MS = 1_000;

/*
 * Runs jobs from one transport.
 *
 *   new JobRunner({
 *     transport,
 *     queues: {
 *       decide: { handler, concurrency, retry, retryFor, onFailure },
 *       deliver: { ... }
 *     }
 *   })
 *
 * handler(job, { signal, commit }) does the work. To write the
 * stage's outputs atomically with the ack, call
 * commit(executor => ...) once; otherwise the job is acked after
 * the handler returns. A thrown error schedules a retry with
 * backoff, or moves the job to `dead` once its attempts are used
 * up (or the error has `permanent: true`). The backoff comes from
 * retryFor(job) or `retry`. onFailure(job, error,
 * { dead, retryInMs }) runs after the job was rescheduled.
 *
 * While a job runs its lease is extended every leaseMs / 3. A
 * lost lease aborts the handler's signal.
 *
 * start(signal, { stop }) keeps claiming until `stop` or `signal`
 * aborts, then waits for running jobs. `stop` only ends claiming
 * (graceful drain: in-flight jobs finish); `signal` also aborts
 * the running handlers. Jobs interrupted that way are released
 * without counting the attempt.
 *
 * onSettled(job, { outcome, durationMs }) is told how every run
 * ended (metrics): ok, retry, dead, lease_lost or released.
 *
 * drain() runs every due job (including jobs those jobs enqueue)
 * until none is left, then returns { processed, failures }.
 */
export class JobRunner {
  constructor({
    transport,
    queues,
    leaseMs = DEFAULT_LEASE_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    workerId = createWorkerId(),
    logger = null,
    random = Math.random,
    onSettled = null
  }) {
    this.transport = transport;
    this.queues = queues;
    this.leaseMs = leaseMs;
    this.pollIntervalMs = pollIntervalMs;
    this.workerId = workerId;
    this.logger = logger;
    this.random = random;
    this.onSettled = onSettled;

    this.inflight = new Map();
    this.wakeups = new Set();
    this.lastReclaimAt = 0;
  }

  get queueNames() {
    return Object.keys(this.queues);
  }

  async start(signal, { stop } = {}) {
    const unsubscribe = this.transport.subscribe(() => this.#wakeAll());
    const claiming = stop ? AbortSignal.any([stop, signal]) : signal;

    try {
      await Promise.all(
        this.queueNames.map(queue => this.#loop(queue, signal, claiming))
      );
    }
    finally {
      unsubscribe();
      await Promise.allSettled([...this.inflight.values()]);
    }
  }

  async drain(signal) {
    const result = { processed: 0, failures: [] };

    while (!signal?.aborted) {
      await this.#reclaim();

      const runs = [];

      for (const queue of this.queueNames) {
        const jobs = await this.transport.claim({
          queues: [queue],
          limit: this.#concurrency(queue),
          leaseMs: this.leaseMs,
          workerId: this.workerId
        });

        for (const job of jobs) {
          runs.push(this.#run(job, signal, result));
        }
      }

      if (runs.length === 0) break;

      await Promise.all(runs);
    }

    return result;
  }

  #concurrency(queue) {
    return Math.max(1, Math.floor(Number(this.queues[queue].concurrency ?? 1)));
  }

  async #loop(queue, signal, claiming = signal) {
    const wake = createWakeSignal();
    this.wakeups.add(wake);

    try {
      while (!claiming.aborted) {
        await this.#reclaimMaybe();

        const running = [...this.inflight.values()]
          .filter(run => run.queue === queue).length;
        const capacity = this.#concurrency(queue) - running;
        let claimed = [];

        if (capacity > 0) {
          try {
            claimed = await this.transport.claim({
              queues: [queue],
              limit: capacity,
              leaseMs: this.leaseMs,
              workerId: this.workerId
            });
          }
          catch (error) {
            if (claiming.aborted) break;
            this.logger?.error?.("job claim failed", { queue, error });
          }

          for (const job of claimed) {
            const run = this.#run(job, signal, null)
              .finally(() => {
                this.inflight.delete(job.id);
                wake.notify();
              });

            run.queue = queue;
            this.inflight.set(job.id, run);
          }
        }

        // A full batch may mean more work is waiting.
        if (capacity > 0 && claimed.length === capacity) continue;

        await wake.wait(claiming, await this.#idleDelay(queue));
      }
    }
    finally {
      this.wakeups.delete(wake);
    }
  }

  async #idleDelay(queue) {
    try {
      const next = await this.transport.nextRunAt([queue]);
      const delay = next === null ? this.pollIntervalMs : next - Date.now();

      /*
       * A job that is already due but was not claimed is blocked
       * behind an earlier job with the same queue_key. Finishing
       * that job wakes this loop; don't spin until then.
       */
      if (delay <= 0) return this.pollIntervalMs;

      return Math.min(this.pollIntervalMs, delay);
    }
    catch {
      return this.pollIntervalMs;
    }
  }

  #wakeAll() {
    for (const wake of this.wakeups) wake.notify();
  }

  async #reclaimMaybe() {
    const interval = Math.max(this.pollIntervalMs, Math.floor(this.leaseMs / 2));
    if (Date.now() - this.lastReclaimAt < interval) return;

    await this.#reclaim();
  }

  async #reclaim() {
    this.lastReclaimAt = Date.now();

    let jobs;

    try {
      jobs = await this.transport.reclaimStalled();
    }
    catch (error) {
      this.logger?.error?.("stalled job reclaim failed", { error });
      return;
    }

    for (const job of jobs) {
      const error = new Error(job.lastError ?? "Lease expired");

      this.logger?.warn?.(
        job.state === "dead"
          ? "stalled job moved to dead"
          : "stalled job reclaimed",
        { queue: job.queue, jobId: job.id, attempts: job.attempts }
      );

      if (job.state === "dead") {
        await this.#onFailure(job, error, { dead: true, retryInMs: null });
      }
    }
  }

  async #run(job, signal, result) {
    const definition = this.queues[job.queue];
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);

    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    const heartbeat = setInterval(async () => {
      try {
        if (!await this.transport.extend(job, this.leaseMs)) {
          controller.abort(new LeaseLostError(job));
        }
      }
      catch (error) {
        this.logger?.warn?.("job lease extension failed", { queue: job.queue, jobId: job.id, error });
      }
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    heartbeat.unref?.();

    let committed = false;
    let outcome = "ok";
    const startedAt = performance.now();

    const commit = async fn => {
      if (committed) throw new Error(`Job ${job.id} was already committed`);

      await this.transport.transaction(async executor => {
        if (fn) await fn(executor);
        await this.transport.ack(job, { executor });
      });

      committed = true;
    };

    try {
      await definition.handler(job, { signal: controller.signal, commit });

      if (!committed) await commit();

      if (result) result.processed += 1;
    }
    catch (error) {
      if (
        error instanceof LeaseLostError ||
        controller.signal.reason instanceof LeaseLostError
      ) {
        this.logger?.warn?.("job lease lost; another worker owns it now", {
          queue: job.queue,
          jobId: job.id
        });
        outcome = "lease_lost";
        return;
      }

      if (signal?.aborted && !committed) {
        await this.transport.release(job).catch(() => {});
        outcome = "released";
        return;
      }

      const dead = error?.permanent === true || job.attempts >= job.maxAttempts;
      outcome = dead ? "dead" : "retry";
      const retryInMs = dead
        ? null
        : backoffDelayMs(
            definition.retryFor?.(job) ??
              definition.retry ??
              { minDelayMs: 0, maxDelayMs: 0, factor: 1 },
            job.attempts,
            this.random
          );

      let rescheduled = false;

      try {
        rescheduled = await this.transport.nack(job, {
          error,
          dead,
          runAt: dead ? undefined : Date.now() + retryInMs
        });
      }
      catch (nackError) {
        this.logger?.error?.("job reschedule failed", { queue: job.queue, jobId: job.id, error: nackError });
      }

      result?.failures.push({ job, error, dead });

      if (rescheduled) {
        await this.#onFailure(job, error, { dead, retryInMs });
      }
    }
    finally {
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", abort);

      try {
        this.onSettled?.(job, { outcome, durationMs: performance.now() - startedAt });
      }
      catch {
        // Metrics never break a job.
      }
    }
  }

  async #onFailure(job, error, details) {
    try {
      await this.queues[job.queue]?.onFailure?.(job, error, details);
    }
    catch (hookError) {
      this.logger?.error?.("job failure hook failed", {
        queue: job.queue,
        jobId: job.id,
        error: hookError
      });
    }
  }
}

/*
 * A wakeup that is never lost: notify() before wait() makes the
 * next wait() return immediately.
 */
function createWakeSignal() {
  let pending = false;
  let resolveWait = null;

  return {
    notify() {
      pending = true;
      resolveWait?.();
    },

    wait(signal, timeoutMs) {
      if (pending || signal.aborted) {
        pending = false;
        return Promise.resolve();
      }

      return new Promise(resolve => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolveWait = null;
          pending = false;
          resolve();
        };

        const timer = setTimeout(done, timeoutMs);
        resolveWait = done;
        signal.addEventListener("abort", done, { once: true });
      });
    }
  };
}
