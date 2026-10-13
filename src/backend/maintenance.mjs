/*
 * Periodic maintenance shared across API replicas.
 *
 * Each task records its last run in `maintenance_runs`. A replica
 * claims a run with one conditional upsert, so when several
 * replicas tick at the same time only one of them does the work
 * and the others skip until the interval has passed again.
 */
export const DEFAULT_MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;

export async function claimMaintenanceRun(db, task, { minIntervalMs, now = new Date() }) {
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - Math.max(0, minIntervalMs)).toISOString();

  const claimed = await db.insertInto("maintenance_runs")
    .values({ task, last_run_at: nowIso })
    .onConflict(oc => oc.column("task")
      .doUpdateSet({ last_run_at: eb => eb.ref("excluded.last_run_at") })
      .where("maintenance_runs.last_run_at", "<=", cutoff))
    .returning("task")
    .executeTakeFirst();

  return Boolean(claimed);
}

export async function lastMaintenanceRun(db, task) {
  const row = await db.selectFrom("maintenance_runs")
    .select("last_run_at")
    .where("task", "=", task)
    .executeTakeFirst();
  return row?.last_run_at ?? null;
}

/*
 * Run `tasks` ({ name: async ({ now }) => result }) every
 * intervalMs. The timer is unref'd so it never keeps the process
 * alive. intervalMs <= 0 disables the timer; run() still works.
 *
 * run({ force: true }) ignores the skip window (used by tests).
 */
export function createMaintenanceScheduler({
  db,
  tasks,
  intervalMs = DEFAULT_MAINTENANCE_INTERVAL_MS,
  logger = console
}) {
  // Skip if another replica ran the task within most of the interval;
  // the slack keeps timer jitter from making a replica skip its turn.
  const skipWindowMs = (intervalMs > 0 ? intervalMs : DEFAULT_MAINTENANCE_INTERVAL_MS) * 0.9;
  let timer = null;
  let chain = Promise.resolve();

  async function runAll({ force = false, now = new Date() } = {}) {
    const results = {};
    for (const [name, task] of Object.entries(tasks)) {
      const claimed = await claimMaintenanceRun(db, name, {
        minIntervalMs: force ? 0 : skipWindowMs,
        now
      });
      results[name] = claimed
        ? { ran: true, result: await task({ now }) }
        : { ran: false };
    }
    return results;
  }

  // Runs never overlap inside one process.
  function run(options) {
    const result = chain.then(() => runAll(options));
    chain = result.catch(() => {});
    return result;
  }

  function tick() {
    run().catch(error => logger.error?.("brainstem maintenance failed", error));
  }

  return {
    intervalMs,
    run,

    start() {
      if (timer || !(intervalMs > 0)) return;
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },

    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await chain;
    }
  };
}
