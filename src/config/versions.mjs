import {
  CONFIG_SCHEMA_VERSION,
  assertValidConfigSpec,
  specHash
} from "./schema.mjs";

/*
 * Config versions (roadmap 4.6, ADR-0005).
 *
 * Every save is a new immutable row in `config_versions`; the single
 * `active_config` row points at the version cores run. Saving with
 * `expectedActiveId` is optimistic concurrency (the API's If-Match):
 * when someone else activated another version meanwhile, the save
 * fails with ConfigConflictError and nothing changes. Rollback is
 * activate(<older id>).
 *
 * Activation announces "config" on the notifier, so every core
 * hot-reloads (see watch.mjs).
 */
export class ConfigConflictError extends Error {
  constructor(expected, actual) {
    super(`The active config changed (expected version ${expected ?? "none"}, active is ${actual ?? "none"}). Reload and try again.`);
    this.name = "ConfigConflictError";
    this.statusCode = 409;
    this.expected = expected;
    this.actual = actual;
  }
}

export function createConfigVersionStore({ database }) {
  async function handle() {
    return typeof database === "function" ? await database() : await database;
  }

  async function activeRow(db) {
    return await db.selectFrom("active_config").selectAll().where("id", "=", 1).executeTakeFirst();
  }

  function announce(h, versionId) {
    h.notifier?.notify("config", { versionId });
  }

  return {
    async list({ limit = 50 } = {}) {
      const { db } = await handle();
      const active = await activeRow(db);
      const rows = await db.selectFrom("config_versions")
        .select(["id", "created_at", "author", "comment", "schema_version", "hash"])
        .orderBy("id", "desc")
        .limit(limit)
        .execute();

      return rows.map(row => ({
        ...versionInfo(row),
        active: active ? Number(active.version_id) === Number(row.id) : false
      }));
    },

    async get(id) {
      const { db } = await handle();
      const row = await db.selectFrom("config_versions").selectAll().where("id", "=", Number(id)).executeTakeFirst();
      return row ? fullVersion(row) : null;
    },

    /*
     * The active version with its spec, or null when none was
     * imported yet.
     */
    async active() {
      const { db } = await handle();
      const active = await activeRow(db);
      if (!active) return null;

      const row = await db.selectFrom("config_versions").selectAll().where("id", "=", Number(active.version_id)).executeTakeFirst();
      return row ? { ...fullVersion(row), activatedAt: active.updated_at, activatedBy: active.updated_by ?? null } : null;
    },

    async activeId() {
      const { db } = await handle();
      const active = await activeRow(db);
      return active ? Number(active.version_id) : null;
    },

    /*
     * Validate and store a new version; activate it unless
     * activate is false. A spec identical to the active one is not
     * stored again ({ unchanged: true }).
     */
    async create(spec, { author = null, comment = null, activate = true, expectedActiveId } = {}) {
      assertValidConfigSpec(spec);

      const h = await handle();
      const hash = specHash(spec);
      const now = new Date().toISOString();

      const result = await h.db.transaction().execute(async trx => {
        const active = await activeRow(trx);
        const activeId = active ? Number(active.version_id) : null;

        if (expectedActiveId !== undefined && (expectedActiveId ?? null) !== activeId) {
          throw new ConfigConflictError(expectedActiveId, activeId);
        }

        if (activate && activeId !== null) {
          const current = await trx.selectFrom("config_versions").select(["id", "hash"]).where("id", "=", activeId).executeTakeFirst();
          if (current?.hash === hash) return { id: activeId, unchanged: true };
        }

        const inserted = await trx.insertInto("config_versions")
          .values({
            created_at: now,
            author,
            comment,
            schema_version: CONFIG_SCHEMA_VERSION,
            spec_json: JSON.stringify(spec),
            hash
          })
          .returning("id")
          .executeTakeFirst();
        const id = Number(inserted.id);

        if (activate) await setActive(trx, id, { author, now });

        return { id, unchanged: false };
      });

      if (activate && !result.unchanged) announce(h, result.id);

      return { ...(await this.get(result.id)), active: activate, unchanged: result.unchanged };
    },

    /*
     * Point the cores at an existing version (rollback included).
     */
    async activate(id, { author = null, expectedActiveId } = {}) {
      const h = await handle();
      const versionId = Number(id);
      const now = new Date().toISOString();

      await h.db.transaction().execute(async trx => {
        const version = await trx.selectFrom("config_versions").select("id").where("id", "=", versionId).executeTakeFirst();
        if (!version) {
          const error = new Error(`Config version ${id} does not exist`);
          error.statusCode = 404;
          throw error;
        }

        const active = await activeRow(trx);
        const activeId = active ? Number(active.version_id) : null;

        if (expectedActiveId !== undefined && (expectedActiveId ?? null) !== activeId) {
          throw new ConfigConflictError(expectedActiveId, activeId);
        }

        await setActive(trx, versionId, { author, now });
      });

      announce(h, versionId);

      return await this.active();
    }
  };
}

async function setActive(db, versionId, { author, now }) {
  await db.insertInto("active_config")
    .values({ id: 1, version_id: versionId, updated_at: now, updated_by: author })
    .onConflict(conflict => conflict.column("id").doUpdateSet({
      version_id: versionId,
      updated_at: now,
      updated_by: author
    }))
    .execute();
}

function versionInfo(row) {
  return {
    id: Number(row.id),
    createdAt: row.created_at,
    author: row.author ?? null,
    comment: row.comment ?? null,
    schemaVersion: Number(row.schema_version),
    hash: row.hash
  };
}

function fullVersion(row) {
  return { ...versionInfo(row), spec: JSON.parse(row.spec_json) };
}
