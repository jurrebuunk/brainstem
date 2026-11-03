import { sql } from "kysely";

import { DURATION_BUCKETS } from "./metrics.mjs";

/*
 * Brainstem's metrics (roadmap §5 Observability).
 *
 * Per process (every core reports its own work):
 *   brainstem_polls_total{input,outcome}            ok | failed
 *   brainstem_poll_duration_seconds{input}
 *   brainstem_observations_total{input}
 *   brainstem_input_lease_lag_seconds{input}        claim time - due time
 *   brainstem_decisions_total{decision}
 *   brainstem_job_duration_seconds{queue,outcome}   ok | retry | dead | lease_lost | released
 *   brainstem_job_failures_total{queue,dead}
 *   brainstem_deliveries_total{destination,plugin,outcome}
 *                                                   delivered | skipped | failed | dead
 *   brainstem_jobs_inflight{queue}
 *   brainstem_core_info{core_id,role,queues}, brainstem_core_draining
 *
 * Cluster-wide, read from the database at scrape time (served by the
 * API, and by role all). Every API replica reports the same values;
 * aggregate with max() across replicas:
 *   brainstem_queue_ready{queue}                    due, waiting for a core
 *   brainstem_queue_delayed{queue}                  waiting for a retry backoff
 *   brainstem_queue_running{queue}
 *   brainstem_queue_dead{queue}
 *   brainstem_queue_oldest_age_seconds{queue}       age of the oldest due job
 *   brainstem_cores{status}                         running | lost | stopped
 *   brainstem_cores_running{queue}
 *   brainstem_inputs{state}                         idle | due | leased
 *   brainstem_input_schedule_lag_seconds            oldest due, unleased input
 *   brainstem_deliveries{status}                    the delivery log
 */
export const PIPELINE_QUEUES = ["decide", "deliver"];

const CORE_QUEUES = ["poll", "decide", "deliver"];
const LOST_AFTER_HEARTBEATS = 3;

// One cluster collector per registry (role all: the API and the
// health server share the process registry).
const clusterCollectors = new WeakMap();

export function runtimeMetrics(registry) {
  return {
    polls: registry.counter({
      name: "brainstem_polls_total",
      help: "Input polls by outcome.",
      labels: ["input", "outcome"]
    }),
    pollDuration: registry.histogram({
      name: "brainstem_poll_duration_seconds",
      help: "Duration of input polls, including the commit.",
      labels: ["input"],
      buckets: DURATION_BUCKETS
    }),
    observations: registry.counter({
      name: "brainstem_observations_total",
      help: "Observations emitted by inputs and stored as decide jobs.",
      labels: ["input"]
    }),
    leaseLag: registry.gauge({
      name: "brainstem_input_lease_lag_seconds",
      help: "How late this core claimed the input after it came due, at its last claim.",
      labels: ["input"]
    }),
    decisions: registry.counter({
      name: "brainstem_decisions_total",
      help: "Decisions by outcome (ignore, notify, escalate, ...).",
      labels: ["decision"]
    }),
    jobDuration: registry.histogram({
      name: "brainstem_job_duration_seconds",
      help: "Duration of decide and deliver jobs by outcome.",
      labels: ["queue", "outcome"],
      buckets: DURATION_BUCKETS
    }),
    jobFailures: registry.counter({
      name: "brainstem_job_failures_total",
      help: "Failed job attempts; dead=\"true\" when the job ran out of attempts.",
      labels: ["queue", "dead"]
    }),
    deliveries: registry.counter({
      name: "brainstem_deliveries_total",
      help: "Delivery attempts by destination and outcome.",
      labels: ["destination", "plugin", "outcome"]
    }),
    inflight: registry.gauge({
      name: "brainstem_jobs_inflight",
      help: "Jobs this core is running now.",
      labels: ["queue"]
    }),
    coreInfo: registry.gauge({
      name: "brainstem_core_info",
      help: "This core's id, role and queues (always 1).",
      labels: ["core_id", "role", "queues"]
    }),
    draining: registry.gauge({
      name: "brainstem_core_draining",
      help: "1 while this core drains for shutdown."
    })
  };
}

/*
 * Gauges for the shared pipeline state, read from the database at
 * most once per `cacheMs` however many scrapers ask.
 */
export function registerClusterMetrics(registry, options) {
  let entry = clusterCollectors.get(registry);

  if (!entry) {
    entry = { users: 0, remove: createClusterCollector(registry, options) };
    clusterCollectors.set(registry, entry);
  }

  entry.users += 1;
  let removed = false;

  return () => {
    if (removed) return;
    removed = true;
    entry.users -= 1;

    if (entry.users === 0) {
      entry.remove();
      clusterCollectors.delete(registry);
    }
  };
}

function createClusterCollector(registry, { database, cacheMs = 5_000, now = Date.now }) {
  const queueReady = registry.gauge({ name: "brainstem_queue_ready", help: "Due jobs waiting for a core.", labels: ["queue"] });
  const queueDelayed = registry.gauge({ name: "brainstem_queue_delayed", help: "Jobs waiting for a retry backoff.", labels: ["queue"] });
  const queueRunning = registry.gauge({ name: "brainstem_queue_running", help: "Jobs claimed by a core.", labels: ["queue"] });
  const queueDead = registry.gauge({ name: "brainstem_queue_dead", help: "Jobs out of attempts (dead letter).", labels: ["queue"] });
  const queueAge = registry.gauge({
    name: "brainstem_queue_oldest_age_seconds",
    help: "Age of the oldest due job in seconds (0 when none is waiting).",
    labels: ["queue"]
  });
  const cores = registry.gauge({ name: "brainstem_cores", help: "Registered cores by status.", labels: ["status"] });
  const coresRunning = registry.gauge({ name: "brainstem_cores_running", help: "Running cores per queue they serve.", labels: ["queue"] });
  const inputs = registry.gauge({ name: "brainstem_inputs", help: "Scheduled inputs by state.", labels: ["state"] });
  const inputLag = registry.gauge({
    name: "brainstem_input_schedule_lag_seconds",
    help: "How long the most overdue unleased input has been due, in seconds (0 when none)."
  });
  const deliveries = registry.gauge({ name: "brainstem_deliveries", help: "Delivery log rows by status.", labels: ["status"] });
  const scrapeErrors = registry.counter({
    name: "brainstem_metrics_database_errors_total",
    help: "Failed database reads for cluster metrics."
  });

  let last = 0;
  let pending = null;

  async function refresh() {
    const handle = typeof database === "function" ? await database() : await database;
    const { db } = handle;
    const at = now();

    const jobRows = await sql`
      select queue,
        sum(case when state = 'ready' and run_at <= cast(${at} as bigint) then 1 else 0 end) as ready,
        sum(case when state = 'ready' and run_at > cast(${at} as bigint) then 1 else 0 end) as delayed,
        sum(case when state = 'running' then 1 else 0 end) as running,
        sum(case when state = 'dead' then 1 else 0 end) as dead,
        min(case when state = 'ready' and run_at <= cast(${at} as bigint) then run_at end) as oldest
      from jobs
      group by queue
    `.execute(db);

    for (const metric of [queueReady, queueDelayed, queueRunning, queueDead, queueAge]) metric.reset();
    for (const queue of PIPELINE_QUEUES) {
      for (const metric of [queueReady, queueDelayed, queueRunning, queueDead, queueAge]) metric.set({ queue }, 0);
    }

    for (const row of jobRows.rows) {
      const labels = { queue: row.queue };
      queueReady.set(labels, Number(row.ready ?? 0));
      queueDelayed.set(labels, Number(row.delayed ?? 0));
      queueRunning.set(labels, Number(row.running ?? 0));
      queueDead.set(labels, Number(row.dead ?? 0));
      queueAge.set(labels, row.oldest === null || row.oldest === undefined
        ? 0
        : Math.max(0, (at - Number(row.oldest)) / 1000));
    }

    const coreRows = await db.selectFrom("cores")
      .select(["status", "last_seen_at", "heartbeat_ms", "queues_json"])
      .execute();

    cores.reset();
    coresRunning.reset();
    for (const status of ["running", "lost", "stopped"]) cores.set({ status }, 0);
    for (const queue of CORE_QUEUES) coresRunning.set({ queue }, 0);

    for (const row of coreRows) {
      const lost = row.status === "running" &&
        at - Number(row.last_seen_at) > Number(row.heartbeat_ms) * LOST_AFTER_HEARTBEATS;
      const status = lost ? "lost" : row.status;
      cores.inc({ status });

      if (status === "running") {
        let queues = [];
        try {
          queues = JSON.parse(row.queues_json ?? "[]");
        }
        catch {
          // Unreadable queues count as all.
        }
        for (const queue of queues.length > 0 ? queues : CORE_QUEUES) coresRunning.inc({ queue });
      }
    }

    const inputRows = await db.selectFrom("inputs")
      .select(["next_due_at", "lease_owner", "lease_until"])
      .execute();

    inputs.reset();
    for (const state of ["idle", "due", "leased"]) inputs.set({ state }, 0);
    let oldestDue = null;

    for (const row of inputRows) {
      const leased = row.lease_owner !== null && Number(row.lease_until ?? 0) >= at;
      const due = Number(row.next_due_at) <= at;

      if (leased) inputs.inc({ state: "leased" });
      else if (due) {
        inputs.inc({ state: "due" });
        oldestDue = oldestDue === null ? Number(row.next_due_at) : Math.min(oldestDue, Number(row.next_due_at));
      }
      else inputs.inc({ state: "idle" });
    }

    inputLag.set({}, oldestDue === null ? 0 : (at - oldestDue) / 1000);

    const deliveryRows = await db.selectFrom("deliveries")
      .select(eb => ["status", eb.fn.countAll().as("count")])
      .groupBy("status")
      .execute();

    deliveries.reset();
    for (const status of ["pending", "failed", "delivered", "dead", "discarded"]) deliveries.set({ status }, 0);
    for (const row of deliveryRows) deliveries.set({ status: row.status }, Number(row.count));

    last = Date.now();
  }

  return registry.collect(async () => {
    if (Date.now() - last < cacheMs) return;

    pending ??= refresh()
      .catch(error => {
        scrapeErrors.inc();
        throw error;
      })
      .finally(() => {
        pending = null;
      });

    await pending;
  });
}
