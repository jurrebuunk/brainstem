import { DatabaseDeliveryStore, MemoryDeliveryStore, deliveryChanges } from "./deliveries.mjs";
import { DatabaseTransport } from "./database-transport.mjs";
import { MemoryTransport } from "./memory-transport.mjs";

export * from "./transport.mjs";
export * from "./deliveries.mjs";
export { DatabaseTransport } from "./database-transport.mjs";
export { MemoryTransport } from "./memory-transport.mjs";
export { JobRunner, DEFAULT_POLL_INTERVAL_MS } from "./runner.mjs";

/*
 * Pipeline storage: the job transport plus the delivery log,
 * always on the same backend so they can share transactions.
 *
 *   type "database"  jobs and deliveries tables in the runtime
 *                    database (durable)
 *   type "memory"    process-local (not durable)
 */
export function createPipelineStorage({ type, database } = {}) {
  if (type === "memory") {
    return {
      type,
      transport: new MemoryTransport(),
      deliveries: new MemoryDeliveryStore()
    };
  }

  if (type === "database") {
    return {
      type,
      transport: new DatabaseTransport({ database }),
      deliveries: new DatabaseDeliveryStore({ database })
    };
  }

  throw new Error(`Unsupported queue transport '${type}'. Use 'database' or 'memory'.`);
}

/*
 * Operator actions on dead jobs, shared by the runtime and the
 * backend API. The job and its delivery row change together.
 */
export function createPipelineAdmin({ transport, deliveries }) {
  return {
    async redrive(id) {
      return await transport.transaction(async executor => {
        const job = await transport.redrive(id, { executor });

        if (job?.queue === "deliver" && job.payload?.key) {
          await deliveries.update(job.payload.key, deliveryChanges.redriven(), { executor });
        }

        return job;
      });
    },

    async discard(id) {
      return await transport.transaction(async executor => {
        const job = await transport.discard(id, { executor });

        if (job?.queue === "deliver" && job.payload?.key) {
          await deliveries.update(job.payload.key, deliveryChanges.discarded(), { executor });
        }

        return job;
      });
    },

    async summary() {
      const [jobs, deliveryCounts] = await Promise.all([
        transport.counts(),
        deliveries.counts()
      ]);

      return {
        transport: transport.type,
        durable: transport.durable,
        jobs,
        deliveries: deliveryCounts
      };
    }
  };
}
