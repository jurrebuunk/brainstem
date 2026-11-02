import { sql } from "kysely";

/*
 * Input scheduling by leases (roadmap 4.3, ADR-0002).
 *
 * Scheduling is data in the `inputs` table, so any core polls any
 * due input and there is no leader:
 *
 *   declare(inputs)   upsert the inputs this core loaded
 *   claim(...)        lease up to `limit` due inputs; every claim
 *                     bumps lease_epoch
 *   extend(lease)     renew while polling (long polls, IMAP IDLE)
 *   fence(lease)      inside the commit transaction: fails when the
 *                     epoch moved on, so a stale poller (GC pause,
 *                     partition) can never commit a checkpoint
 *   release(lease)    done; set the next due time
 *
 * A lease held by a core that stopped, or that missed its
 * heartbeats (the `cores` registry), is claimable at once instead
 * of after lease expiry.
 */
export const DEFAULT_INPUT_LEASE_MS = 30_000;

// Missed core heartbeats after which a lease counts as abandoned.
const LOST_AFTER_HEARTBEATS = 3;

export class InputLeaseLostError extends Error {
  constructor(lease) {
    super(`Lease on input '${lease.id}' (epoch ${lease.epoch}) was lost`);
    this.name = "InputLeaseLostError";
    this.code = "BRAINSTEM_INPUT_LEASE_LOST";
    this.inputId = lease.id;
  }
}

export function createInputLeaseStore({ database, now = Date.now }) {
  async function handle() {
    return typeof database === "function" ? await database() : await database;
  }

  return {
    async declare(inputs, { at = now() } = {}) {
      const { db } = await handle();
      const iso = new Date(at).toISOString();

      for (const input of inputs) {
        await db.insertInto("inputs")
          .values({
            id: input.id,
            plugin: input.plugin ?? null,
            input: input.input ?? null,
            interval_ms: input.intervalMs,
            next_due_at: at,
            lease_owner: null,
            lease_until: null,
            lease_epoch: 0,
            last_poll_at: null,
            last_error: null,
            seen_at: at,
            created_at: iso,
            updated_at: iso
          })
          .onConflict(conflict => conflict.column("id").doUpdateSet({
            plugin: input.plugin ?? null,
            input: input.input ?? null,
            interval_ms: input.intervalMs,
            seen_at: at,
            updated_at: iso
          }))
          .execute();
      }
    },

    /*
     * Lease due inputs among `ids` (the inputs this core can poll).
     * `force` ignores the schedule (run-once) but never takes a live
     * lease from another core.
     */
    async claim({ ids, owner, limit = 1, leaseMs = DEFAULT_INPUT_LEASE_MS, force = false, at = now() }) {
      if (!ids?.length || limit <= 0) return [];

      const { db, dialect } = await handle();
      const lockClause = dialect === "postgres" ? sql`for update skip locked` : sql``;
      const due = force ? sql`1 = 1` : sql`i.next_due_at <= cast(${at} as bigint)`;

      const result = await sql`
        update inputs
        set lease_owner = ${owner},
            lease_until = cast(${at + leaseMs} as bigint),
            lease_epoch = lease_epoch + 1,
            updated_at = ${new Date(at).toISOString()}
        where id in (
          select i.id from inputs i
          where i.id in (${sql.join(ids)})
            and ${due}
            and (
              i.lease_owner is null
              or i.lease_until < cast(${at} as bigint)
              or i.lease_owner = ${owner}
              or exists (
                select 1 from cores c
                where c.id = i.lease_owner
                  and (
                    c.status = 'stopped'
                    or c.last_seen_at < cast(${at} as bigint) - c.heartbeat_ms * ${LOST_AFTER_HEARTBEATS}
                  )
              )
            )
          order by i.next_due_at, i.id
          limit ${limit}
          ${lockClause}
        )
        returning *
      `.execute(db);

      return result.rows.map(leaseFromRow);
    },

    async extend(lease, { leaseMs = DEFAULT_INPUT_LEASE_MS, at = now() } = {}) {
      const { db } = await handle();
      const until = at + leaseMs;
      const result = await db.updateTable("inputs")
        .set({ lease_until: until })
        .where("id", "=", lease.id)
        .where("lease_owner", "=", lease.owner)
        .where("lease_epoch", "=", lease.epoch)
        .executeTakeFirst();

      if (Number(result?.numUpdatedRows ?? 0) === 0) return false;

      lease.until = until;
      return true;
    },

    /*
     * Fencing check, run inside the transaction that commits the
     * poll's checkpoint and decide jobs. Throws InputLeaseLostError
     * (rolling the transaction back) when the epoch moved on.
     */
    async fence(lease, { executor, at = now() } = {}) {
      const db = executor ?? (await handle()).db;
      const result = await db.updateTable("inputs")
        .set({ updated_at: new Date(at).toISOString() })
        .where("id", "=", lease.id)
        .where("lease_owner", "=", lease.owner)
        .where("lease_epoch", "=", lease.epoch)
        .executeTakeFirst();

      if (Number(result?.numUpdatedRows ?? 0) === 0) {
        throw new InputLeaseLostError(lease);
      }
    },

    /*
     * Give the lease back. With `nextDueAt` this ends a poll
     * (success or failure) and schedules the next one; without it
     * (shutdown) the schedule is left as it was.
     */
    async release(lease, { nextDueAt, polled = false, error = null, at = now() } = {}) {
      const { db } = await handle();
      const iso = new Date(at).toISOString();
      const result = await db.updateTable("inputs")
        .set({
          lease_owner: null,
          lease_until: null,
          updated_at: iso,
          ...(nextDueAt === undefined ? {} : { next_due_at: nextDueAt }),
          ...(polled ? { last_poll_at: iso, last_error: error ? String(error).slice(0, 2_000) : null } : {})
        })
        .where("id", "=", lease.id)
        .where("lease_owner", "=", lease.owner)
        .where("lease_epoch", "=", lease.epoch)
        .executeTakeFirst();

      return Number(result?.numUpdatedRows ?? 0) > 0;
    },

    async releaseAll(owner, { at = now() } = {}) {
      const { db } = await handle();
      const result = await db.updateTable("inputs")
        .set({ lease_owner: null, lease_until: null, updated_at: new Date(at).toISOString() })
        .where("lease_owner", "=", owner)
        .executeTakeFirst();

      return Number(result?.numUpdatedRows ?? 0);
    },

    /*
     * Earliest time one of `ids` becomes claimable: its due time,
     * or the end of the lease another core holds on it.
     */
    async nextClaimAt(ids) {
      if (!ids?.length) return null;

      const { db } = await handle();
      const rows = await db.selectFrom("inputs")
        .select(["next_due_at", "lease_until", "lease_owner"])
        .where("id", "in", ids)
        .execute();

      let next = null;

      for (const row of rows) {
        const at = row.lease_owner
          ? Math.max(Number(row.next_due_at), Number(row.lease_until ?? 0))
          : Number(row.next_due_at);
        next = next === null ? at : Math.min(next, at);
      }

      return next;
    },

    async list() {
      const { db } = await handle();
      const rows = await db.selectFrom("inputs").selectAll().orderBy("id").execute();
      return rows.map(inputFromRow);
    },

    /*
     * Forget inputs no core declared for `olderThanMs` and that are
     * not leased (removed from every config).
     */
    async prune({ olderThanMs, at = now() }) {
      const { db } = await handle();
      const result = await db.deleteFrom("inputs")
        .where("seen_at", "<", at - olderThanMs)
        .where(eb => eb.or([
          eb("lease_owner", "is", null),
          eb("lease_until", "<", at)
        ]))
        .executeTakeFirst();

      return Number(result?.numDeletedRows ?? 0);
    }
  };
}

/*
 * Next due time: one interval after now plus jitter (up to 10% of
 * the interval, at most 5 s) so inputs with equal intervals don't
 * all come due in the same instant.
 */
export function nextDueAt(intervalMs, { at = Date.now(), random = Math.random } = {}) {
  const jitter = Math.min(intervalMs * 0.1, 5_000) * random();
  return Math.round(at + intervalMs + jitter);
}

function leaseFromRow(row) {
  return {
    id: row.id,
    owner: row.lease_owner,
    epoch: Number(row.lease_epoch),
    until: Number(row.lease_until),
    nextDueAt: Number(row.next_due_at),
    intervalMs: Number(row.interval_ms)
  };
}

function inputFromRow(row) {
  return {
    id: row.id,
    plugin: row.plugin,
    input: row.input,
    intervalMs: Number(row.interval_ms),
    nextDueAt: new Date(Number(row.next_due_at)).toISOString(),
    leaseOwner: row.lease_owner ?? null,
    leaseUntil: row.lease_until === null || row.lease_until === undefined
      ? null
      : new Date(Number(row.lease_until)).toISOString(),
    leaseEpoch: Number(row.lease_epoch),
    lastPollAt: row.last_poll_at ?? null,
    lastError: row.last_error ?? null,
    seenAt: new Date(Number(row.seen_at)).toISOString()
  };
}
