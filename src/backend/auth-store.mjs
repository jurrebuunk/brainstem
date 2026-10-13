import { randomBytes, randomUUID } from "node:crypto";
import argon2 from "argon2";
import { sql } from "kysely";

import {
  countValue,
  isUniqueViolation,
  lockTransaction,
  writeTransaction
} from "./db-utils.mjs";
import { DEFAULT_ROLES, normalizePermissions, PERMISSIONS } from "./permissions.mjs";

const SESSION_BYTES = 32;
const CSRF_BYTES = 24;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// Serializes every change that can add or remove an administrator,
// across connections and replicas (Postgres advisory lock).
const ADMIN_LOCK = "brainstem.auth.admins";

/*
 * Auth persistence on the shared database handle
 * ({ db, dialect } from src/db). Async; the handle is owned by
 * the caller.
 */
export async function createAuthStore({ database, sessionTtlMs = DEFAULT_SESSION_TTL_MS }) {
  const { db, dialect } = database;
  await ensureDefaultRoles(db);

  function adminTransaction(fn) {
    return writeTransaction(database, async trx => {
      await lockTransaction(trx, dialect, ADMIN_LOCK);
      return await fn(trx);
    });
  }

  return {
    sessionTtlMs,

    async close() {
      // The database handle is owned by the caller.
    },

    async setupRequired() {
      return await adminCount(db) === 0;
    },

    async createInitialAdmin({ username, password, name }) {
      if (await adminCount(db) > 0) {
        throw httpError(409, "Initial administrator already exists");
      }

      const normalized = normalizeUserInput({ username, password, name }, { requirePassword: true });
      const hash = await hashPassword(normalized.password);

      // Check and insert in one serialized transaction so concurrent
      // setup requests (or replicas) cannot both create an admin.
      const id = await adminTransaction(async trx => {
        if (await adminCount(trx) > 0) {
          throw httpError(409, "Initial administrator already exists");
        }
        const adminRole = await roleByName(trx, "Administrator");
        return await insertUser(trx, {
          ...normalized,
          active: true,
          roleIds: [adminRole.id]
        }, hash);
      });

      return await userWithPermissions(db, id);
    },

    async verifyLogin({ username, password }) {
      const user = await userByUsername(db, username);
      if (!user || !user.active) return null;
      const ok = await argon2.verify(user.password_hash, String(password ?? ""));
      return ok ? await userWithPermissions(db, user.id) : null;
    },

    async createSession(userId) {
      const token = randomToken(SESSION_BYTES);
      const csrfToken = randomToken(CSRF_BYTES);
      const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();
      await db.insertInto("auth_sessions")
        .values({
          token,
          user_id: userId,
          csrf_token: csrfToken,
          expires_at: expiresAt,
          created_at: new Date().toISOString()
        })
        .execute();
      return { token, csrfToken, expiresAt };
    },

    async getSession(token) {
      if (!token) return null;
      const row = await db.selectFrom("auth_sessions")
        .select(["token", "user_id", "csrf_token", "expires_at"])
        .where("token", "=", token)
        .where("revoked_at", "is", null)
        .where("expires_at", ">", new Date().toISOString())
        .executeTakeFirst();
      if (!row) return null;
      const user = await userWithPermissions(db, row.user_id);
      if (!user?.active) return null;
      return {
        token: row.token,
        csrfToken: row.csrf_token,
        expiresAt: row.expires_at,
        user
      };
    },

    async revokeSession(token) {
      if (!token) return;
      await db.updateTable("auth_sessions")
        .set({ revoked_at: new Date().toISOString() })
        .where("token", "=", token)
        .execute();
    },

    async pruneExpiredSessions({ now = new Date() } = {}) {
      const deleted = await db.deleteFrom("auth_sessions")
        .where(eb => eb.or([
          eb("expires_at", "<=", now.toISOString()),
          eb("revoked_at", "is not", null)
        ]))
        .executeTakeFirst();
      return Number(deleted.numDeletedRows ?? 0);
    },

    /*
     * Count one login attempt for key inside a fixed window and
     * return the attempt count for the current window. Stored in
     * the database so the limit holds across API replicas.
     */
    async registerLoginAttempt(key, { windowMs, now = new Date() }) {
      const nowIso = now.toISOString();
      const cutoff = new Date(now.getTime() - windowMs).toISOString();
      const expired = sql`auth_login_attempts.window_started_at <= ${cutoff}`;
      const row = await db.insertInto("auth_login_attempts")
        .values({ key, count: 1, window_started_at: nowIso })
        .onConflict(oc => oc.column("key").doUpdateSet({
          count: sql`case when ${expired} then 1 else auth_login_attempts.count + 1 end`,
          window_started_at: sql`case when ${expired} then excluded.window_started_at else auth_login_attempts.window_started_at end`
        }))
        .returning("count")
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },

    async resetLoginAttempts(key) {
      await db.deleteFrom("auth_login_attempts").where("key", "=", key).execute();
    },

    async pruneLoginAttempts({ windowMs, now = new Date() }) {
      const cutoff = new Date(now.getTime() - windowMs).toISOString();
      const deleted = await db.deleteFrom("auth_login_attempts")
        .where("window_started_at", "<=", cutoff)
        .executeTakeFirst();
      return Number(deleted.numDeletedRows ?? 0);
    },

    async listUsers() {
      const rows = await db.selectFrom("auth_users").select("id").orderBy("username").execute();
      return await Promise.all(rows.map(row => userWithPermissions(db, row.id)));
    },

    async getUser(id) {
      return await userWithPermissions(db, id);
    },

    async createUser(input) {
      const normalized = normalizeUserInput(input, { requirePassword: true });
      const hash = await hashPassword(normalized.password);
      const id = await writeTransaction(database, trx => insertUser(trx, normalized, hash));
      return await userWithPermissions(db, id);
    },

    async updateUser(id, input) {
      const existing = await userWithPermissions(db, id);
      if (!existing) throw httpError(404, "User not found");
      const preview = normalizeUserInput(input, { requirePassword: false, current: existing });
      const passwordHash = preview.password ? await hashPassword(preview.password) : null;

      await adminTransaction(async trx => {
        const current = await userWithPermissions(trx, id);
        if (!current) throw httpError(404, "User not found");
        const normalized = normalizeUserInput(input, { requirePassword: false, current });

        if (current.permissions.includes("roles:manage") && normalized.active === false && await adminCount(trx) <= 1) {
          throw httpError(409, "Cannot disable the last active administrator");
        }

        const roleIds = normalized.roleIds ?? current.roles.map(role => role.id);
        const willBeAdmin = await rolesHavePermission(trx, roleIds, "roles:manage");
        if (current.permissions.includes("roles:manage") && !willBeAdmin && await adminCount(trx) <= 1) {
          throw httpError(409, "Cannot remove the last active administrator");
        }

        try {
          await trx.updateTable("auth_users")
            .set({
              username: normalized.username,
              name: normalized.name,
              ...(passwordHash ? { password_hash: passwordHash } : {}),
              active: normalized.active ? 1 : 0,
              updated_at: new Date().toISOString()
            })
            .where("id", "=", id)
            .execute();
        }
        catch (error) {
          if (isUniqueViolation(error)) throw httpError(409, "Username already exists");
          throw error;
        }

        if (normalized.roleIds) await setUserRoles(trx, id, normalized.roleIds);
      });

      return await userWithPermissions(db, id);
    },

    async deleteUser(id) {
      await adminTransaction(async trx => {
        const user = await userWithPermissions(trx, id);
        if (!user) throw httpError(404, "User not found");
        if (user.permissions.includes("roles:manage") && await adminCount(trx) <= 1) {
          throw httpError(409, "Cannot remove the last active administrator");
        }
        await trx.deleteFrom("auth_users").where("id", "=", id).execute();
      });
    },

    async listRoles() {
      const rows = await db.selectFrom("auth_roles").selectAll().orderBy("name").execute();
      return rows.map(roleFromRow);
    },

    async createRole(input) {
      return await createRole(db, input);
    },

    async updateRole(id, input) {
      return await adminTransaction(trx => updateRole(trx, id, input));
    },

    async deleteRole(id) {
      await adminTransaction(async trx => {
        const role = await roleById(trx, id);
        if (!role) throw httpError(404, "Role not found");
        if (role.system) throw httpError(409, "System roles cannot be deleted");
        if (role.permissions.includes("roles:manage") && await adminCountExcludingRole(trx, id) <= 0) {
          throw httpError(409, "Cannot remove the last active administrator");
        }
        await trx.deleteFrom("auth_roles").where("id", "=", id).execute();
      });
    },

    permissions() {
      return PERMISSIONS;
    }
  };
}

async function ensureDefaultRoles(db) {
  // Idempotent across replicas starting at the same time.
  const now = new Date().toISOString();
  for (const role of DEFAULT_ROLES) {
    const normalized = normalizeRoleInput(role);
    await db.insertInto("auth_roles")
      .values(roleValues(randomUUID(), normalized, now))
      .onConflict(oc => oc.column("name").doNothing())
      .execute();
  }
}

async function insertUser(db, normalized, passwordHash) {
  const now = new Date().toISOString();
  const id = randomUUID();

  try {
    await db.insertInto("auth_users")
      .values({
        id,
        username: normalized.username,
        name: normalized.name,
        password_hash: passwordHash,
        active: normalized.active ? 1 : 0,
        created_at: now,
        updated_at: now
      })
      .execute();
  }
  catch (error) {
    if (isUniqueViolation(error)) throw httpError(409, "Username already exists");
    throw error;
  }

  await setUserRoles(db, id, normalized.roleIds);
  return id;
}

async function createRole(db, input) {
  const normalized = normalizeRoleInput(input);
  const id = randomUUID();
  try {
    await db.insertInto("auth_roles")
      .values(roleValues(id, normalized, new Date().toISOString()))
      .execute();
  }
  catch (error) {
    if (isUniqueViolation(error)) throw httpError(409, "Role name already exists");
    throw error;
  }
  return await roleById(db, id);
}

function roleValues(id, normalized, now) {
  return {
    id,
    name: normalized.name,
    description: normalized.description,
    permissions_json: JSON.stringify(normalized.permissions),
    system: normalized.system ? 1 : 0,
    created_at: now,
    updated_at: now
  };
}

async function updateRole(db, id, input) {
  const current = await roleById(db, id);
  if (!current) throw httpError(404, "Role not found");
  const normalized = normalizeRoleInput({ ...current, ...input, system: current.system });

  if (current.system && current.name === "Administrator" && !normalized.permissions.includes("roles:manage")) {
    throw httpError(409, "Administrator role must retain role management permission");
  }
  if (current.permissions.includes("roles:manage") && !normalized.permissions.includes("roles:manage") && await adminCountExcludingRole(db, id) <= 0) {
    throw httpError(409, "Cannot remove the last active administrator");
  }

  try {
    await db.updateTable("auth_roles")
      .set({
        name: normalized.name,
        description: normalized.description,
        permissions_json: JSON.stringify(normalized.permissions),
        updated_at: new Date().toISOString()
      })
      .where("id", "=", id)
      .execute();
  }
  catch (error) {
    if (isUniqueViolation(error)) throw httpError(409, "Role name already exists");
    throw error;
  }
  return await roleById(db, id);
}

async function setUserRoles(db, userId, roleIds) {
  const validIds = [...new Set(roleIds ?? [])];
  for (const roleId of validIds) {
    if (!await roleById(db, roleId)) throw httpError(400, `Unknown role '${roleId}'`);
  }
  await db.deleteFrom("auth_user_roles").where("user_id", "=", userId).execute();
  if (validIds.length === 0) return;
  await db.insertInto("auth_user_roles")
    .values(validIds.map(roleId => ({ user_id: userId, role_id: roleId })))
    .execute();
}

async function userWithPermissions(db, id) {
  const row = await db.selectFrom("auth_users").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return null;
  const roleRows = await db.selectFrom("auth_roles as r")
    .innerJoin("auth_user_roles as ur", "ur.role_id", "r.id")
    .selectAll("r")
    .where("ur.user_id", "=", id)
    .orderBy("r.name")
    .execute();
  const roles = roleRows.map(roleFromRow);
  const permissions = normalizePermissions(roles.flatMap(role => role.permissions));
  return sanitizeUser(row, roles, permissions);
}

async function userByUsername(db, username) {
  const row = await db.selectFrom("auth_users")
    .selectAll()
    .where(eb => eb(eb.fn("lower", ["username"]), "=", String(username ?? "").toLowerCase()))
    .executeTakeFirst();
  return row ? { ...row, active: Number(row.active) === 1 } : null;
}

function sanitizeUser(row, roles, permissions) {
  return {
    id: row.id,
    username: row.username,
    name: row.name ?? "",
    active: Number(row.active) === 1,
    roles,
    permissions,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function roleFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    permissions: normalizePermissions(JSON.parse(row.permissions_json)),
    system: Number(row.system) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function roleByName(db, name) {
  const row = await db.selectFrom("auth_roles").selectAll().where("name", "=", name).executeTakeFirst();
  return row ? roleFromRow(row) : null;
}

async function roleById(db, id) {
  const row = await db.selectFrom("auth_roles").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? roleFromRow(row) : null;
}

async function rolesHavePermission(db, roleIds, permission) {
  for (const roleId of roleIds ?? []) {
    if ((await roleById(db, roleId))?.permissions.includes(permission)) return true;
  }
  return false;
}

async function adminCount(db, { excludingRoleId } = {}) {
  let query = db.selectFrom("auth_users as u")
    .innerJoin("auth_user_roles as ur", "ur.user_id", "u.id")
    .innerJoin("auth_roles as r", "r.id", "ur.role_id")
    .select(sql`count(distinct u.id)`.as("count"))
    .where("u.active", "=", 1)
    .where("r.permissions_json", "like", "%\"roles:manage\"%");
  if (excludingRoleId) query = query.where("r.id", "!=", excludingRoleId);
  return countValue(await query.executeTakeFirst());
}

function adminCountExcludingRole(db, roleId) {
  return adminCount(db, { excludingRoleId: roleId });
}

function normalizeUserInput(input, { requirePassword, current } = {}) {
  const username = String(input.username ?? current?.username ?? "").trim();
  if (!/^[a-zA-Z0-9_.@-]{3,80}$/.test(username)) {
    throw httpError(400, "Username must be 3-80 characters and contain only letters, numbers, dot, underscore, at-sign, or dash");
  }

  const password = input.password === undefined ? undefined : String(input.password);
  if (requirePassword || password) validatePassword(password, { username });

  return {
    username,
    password,
    name: String(input.name ?? current?.name ?? "").trim().slice(0, 120),
    active: input.active ?? current?.active ?? true,
    roleIds: input.roleIds ? [...new Set(input.roleIds.map(String))] : undefined
  };
}

function normalizeRoleInput(input) {
  const name = String(input.name ?? "").trim();
  if (!/^[\p{L}\p{N} _.-]{2,80}$/u.test(name)) {
    throw httpError(400, "Role name must be 2-80 characters");
  }
  return {
    name,
    description: String(input.description ?? "").trim().slice(0, 300),
    permissions: normalizePermissions(input.permissions),
    system: input.system === true
  };
}

function validatePassword(password, { username } = {}) {
  if (typeof password !== "string" || password.length < 12) {
    throw httpError(400, "Password must be at least 12 characters");
  }
  if (password.length > 512) {
    throw httpError(400, "Password is too long");
  }
  const normalized = password.toLowerCase();
  const common = new Set([
    "password1234",
    "password12345",
    "password123456",
    "correct horse battery staple",
    "adminadminadmin",
    "brainstembrainstem"
  ]);
  if (common.has(normalized) || /^(.)\1{11,}$/.test(password)) {
    throw httpError(400, "Password is too easy to guess");
  }
  if (username && normalized.includes(String(username).toLowerCase())) {
    throw httpError(400, "Password must not contain the username");
  }
}

function hashPassword(password) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1
  });
}

function randomToken(bytes) {
  return randomBytes(bytes).toString("base64url");
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
