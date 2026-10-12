import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import argon2 from "argon2";

import { DEFAULT_ROLES, normalizePermissions, PERMISSIONS } from "./permissions.mjs";

const SESSION_BYTES = 32;
const CSRF_BYTES = 24;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function createAuthStore({ path, sessionTtlMs = DEFAULT_SESSION_TTL_MS }) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  initAuthDb(db);
  ensureDefaultRoles(db);

  return {
    sessionTtlMs,

    close() {
      db.close();
    },

    setupRequired() {
      return adminCount(db) === 0;
    },

    async createInitialAdmin({ username, password, name }) {
      if (adminCount(db) > 0) {
        throw httpError(409, "Initial administrator already exists");
      }

      const adminRole = roleByName(db, "Administrator");
      const user = await createUser(db, {
        username,
        password,
        name,
        active: true,
        roleIds: [adminRole.id]
      });
      return userWithPermissions(db, user.id);
    },

    async verifyLogin({ username, password }) {
      const user = userByUsername(db, username);
      if (!user || !user.active) return null;
      const ok = await argon2.verify(user.password_hash, String(password ?? ""));
      return ok ? userWithPermissions(db, user.id) : null;
    },

    createSession(userId) {
      pruneExpiredSessions(db);
      const token = randomToken(SESSION_BYTES);
      const csrfToken = randomToken(CSRF_BYTES);
      const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();
      db.prepare(`
        insert into auth_sessions (token, user_id, csrf_token, expires_at, created_at)
        values (?, ?, ?, ?, ?)
      `).run(token, userId, csrfToken, expiresAt, new Date().toISOString());
      return { token, csrfToken, expiresAt };
    },

    getSession(token) {
      if (!token) return null;
      pruneExpiredSessions(db);
      const row = db.prepare(`
        select token, user_id, csrf_token, expires_at
        from auth_sessions
        where token = ? and revoked_at is null and expires_at > ?
      `).get(token, new Date().toISOString());
      if (!row) return null;
      const user = userWithPermissions(db, row.user_id);
      if (!user?.active) return null;
      return {
        token: row.token,
        csrfToken: row.csrf_token,
        expiresAt: row.expires_at,
        user
      };
    },

    revokeSession(token) {
      if (!token) return;
      db.prepare("update auth_sessions set revoked_at = ? where token = ?")
        .run(new Date().toISOString(), token);
    },

    listUsers() {
      return db.prepare("select id from auth_users order by username").all()
        .map(row => userWithPermissions(db, row.id));
    },

    getUser(id) {
      return userWithPermissions(db, id);
    },

    async createUser(input) {
      return await createUser(db, input);
    },

    async updateUser(id, input) {
      return await updateUser(db, id, input);
    },

    deleteUser(id) {
      const user = userWithPermissions(db, id);
      if (!user) throw httpError(404, "User not found");
      if (user.permissions.includes("roles:manage") && adminCount(db) <= 1) {
        throw httpError(409, "Cannot remove the last active administrator");
      }
      db.prepare("delete from auth_users where id = ?").run(id);
    },

    listRoles() {
      return db.prepare("select * from auth_roles order by name").all()
        .map(roleFromRow);
    },

    createRole(input) {
      return createRole(db, input);
    },

    updateRole(id, input) {
      return updateRole(db, id, input);
    },

    deleteRole(id) {
      const role = roleById(db, id);
      if (!role) throw httpError(404, "Role not found");
      if (role.system) throw httpError(409, "System roles cannot be deleted");
      if (role.permissions.includes("roles:manage") && adminCountExcludingRole(db, id) <= 0) {
        throw httpError(409, "Cannot remove the last active administrator");
      }
      db.prepare("delete from auth_roles where id = ?").run(id);
    },

    permissions() {
      return PERMISSIONS;
    }
  };
}

function initAuthDb(db) {
  db.exec(`
    pragma journal_mode = wal;
    pragma busy_timeout = 5000;
    pragma foreign_keys = on;

    create table if not exists auth_users (
      id text primary key,
      username text not null unique,
      name text,
      password_hash text not null,
      active integer not null default 1,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists auth_roles (
      id text primary key,
      name text not null unique,
      description text,
      permissions_json text not null,
      system integer not null default 0,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists auth_user_roles (
      user_id text not null references auth_users(id) on delete cascade,
      role_id text not null references auth_roles(id) on delete cascade,
      primary key (user_id, role_id)
    );

    create table if not exists auth_sessions (
      token text primary key,
      user_id text not null references auth_users(id) on delete cascade,
      csrf_token text not null,
      expires_at text not null,
      created_at text not null,
      revoked_at text
    );

    create index if not exists auth_sessions_user_idx on auth_sessions(user_id);
    create index if not exists auth_sessions_expires_idx on auth_sessions(expires_at);
  `);
}

function ensureDefaultRoles(db) {
  for (const role of DEFAULT_ROLES) {
    const existing = roleByName(db, role.name);
    if (existing) continue;
    createRole(db, role);
  }
}

async function createUser(db, input) {
  const normalized = normalizeUserInput(input, { requirePassword: true });
  const now = new Date().toISOString();
  const id = randomUUID();
  const hash = await hashPassword(normalized.password);

  db.exec("begin immediate");
  try {
    db.prepare(`
      insert into auth_users (id, username, name, password_hash, active, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?)
    `).run(id, normalized.username, normalized.name, hash, normalized.active ? 1 : 0, now, now);
    setUserRoles(db, id, normalized.roleIds);
    db.exec("commit");
  }
  catch (error) {
    db.exec("rollback");
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Username already exists");
    throw error;
  }

  return userWithPermissions(db, id);
}

async function updateUser(db, id, input) {
  const current = userWithPermissions(db, id);
  if (!current) throw httpError(404, "User not found");
  const normalized = normalizeUserInput(input, { requirePassword: false, current });

  if (current.permissions.includes("roles:manage") && normalized.active === false && adminCount(db) <= 1) {
    throw httpError(409, "Cannot disable the last active administrator");
  }

  const roleIds = normalized.roleIds ?? current.roles.map(role => role.id);
  const willBeAdmin = rolesHavePermission(db, roleIds, "roles:manage");
  if (current.permissions.includes("roles:manage") && !willBeAdmin && adminCount(db) <= 1) {
    throw httpError(409, "Cannot remove the last active administrator");
  }

  const now = new Date().toISOString();
  const passwordHash = normalized.password ? await hashPassword(normalized.password) : null;

  db.exec("begin immediate");
  try {
    if (passwordHash) {
      db.prepare(`
        update auth_users set username = ?, name = ?, password_hash = ?, active = ?, updated_at = ? where id = ?
      `).run(normalized.username, normalized.name, passwordHash, normalized.active ? 1 : 0, now, id);
    }
    else {
      db.prepare(`
        update auth_users set username = ?, name = ?, active = ?, updated_at = ? where id = ?
      `).run(normalized.username, normalized.name, normalized.active ? 1 : 0, now, id);
    }

    if (normalized.roleIds) setUserRoles(db, id, normalized.roleIds);
    db.exec("commit");
  }
  catch (error) {
    db.exec("rollback");
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "Username already exists");
    throw error;
  }

  return userWithPermissions(db, id);
}

function createRole(db, input) {
  const normalized = normalizeRoleInput(input);
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(`
    insert into auth_roles (id, name, description, permissions_json, system, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?)
  `).run(id, normalized.name, normalized.description, JSON.stringify(normalized.permissions), normalized.system ? 1 : 0, now, now);
  return roleById(db, id);
}

function updateRole(db, id, input) {
  const current = roleById(db, id);
  if (!current) throw httpError(404, "Role not found");
  const normalized = normalizeRoleInput({ ...current, ...input, system: current.system });

  if (current.system && current.name === "Administrator" && !normalized.permissions.includes("roles:manage")) {
    throw httpError(409, "Administrator role must retain role management permission");
  }
  if (current.permissions.includes("roles:manage") && !normalized.permissions.includes("roles:manage") && adminCountExcludingRole(db, id) <= 0) {
    throw httpError(409, "Cannot remove the last active administrator");
  }

  db.prepare(`
    update auth_roles set name = ?, description = ?, permissions_json = ?, updated_at = ? where id = ?
  `).run(normalized.name, normalized.description, JSON.stringify(normalized.permissions), new Date().toISOString(), id);
  return roleById(db, id);
}

function setUserRoles(db, userId, roleIds) {
  const validIds = [...new Set(roleIds ?? [])];
  for (const roleId of validIds) {
    if (!roleById(db, roleId)) throw httpError(400, `Unknown role '${roleId}'`);
  }
  db.prepare("delete from auth_user_roles where user_id = ?").run(userId);
  const stmt = db.prepare("insert into auth_user_roles (user_id, role_id) values (?, ?)");
  for (const roleId of validIds) stmt.run(userId, roleId);
}

function userWithPermissions(db, id) {
  const row = db.prepare("select * from auth_users where id = ?").get(id);
  if (!row) return null;
  const roles = db.prepare(`
    select r.* from auth_roles r
    join auth_user_roles ur on ur.role_id = r.id
    where ur.user_id = ?
    order by r.name
  `).all(id).map(roleFromRow);
  const permissions = normalizePermissions(roles.flatMap(role => role.permissions));
  return sanitizeUser(row, roles, permissions);
}

function userByUsername(db, username) {
  const row = db.prepare("select * from auth_users where lower(username) = lower(?)").get(String(username ?? ""));
  return row ? { ...row, active: row.active === 1 } : null;
}

function sanitizeUser(row, roles, permissions) {
  return {
    id: row.id,
    username: row.username,
    name: row.name ?? "",
    active: row.active === 1,
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
    system: row.system === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function roleByName(db, name) {
  const row = db.prepare("select * from auth_roles where name = ?").get(name);
  return row ? roleFromRow(row) : null;
}

function roleById(db, id) {
  const row = db.prepare("select * from auth_roles where id = ?").get(id);
  return row ? roleFromRow(row) : null;
}

function rolesHavePermission(db, roleIds, permission) {
  return (roleIds ?? []).some(roleId => roleById(db, roleId)?.permissions.includes(permission));
}

function adminCount(db) {
  return db.prepare(`
    select count(distinct u.id) as count
    from auth_users u
    join auth_user_roles ur on ur.user_id = u.id
    join auth_roles r on r.id = ur.role_id
    where u.active = 1 and r.permissions_json like '%"roles:manage"%'
  `).get().count;
}

function adminCountExcludingRole(db, roleId) {
  return db.prepare(`
    select count(distinct u.id) as count
    from auth_users u
    join auth_user_roles ur on ur.user_id = u.id
    join auth_roles r on r.id = ur.role_id
    where u.active = 1 and r.id != ? and r.permissions_json like '%"roles:manage"%'
  `).get(roleId).count;
}

function pruneExpiredSessions(db) {
  db.prepare("delete from auth_sessions where expires_at <= ? or revoked_at is not null")
    .run(new Date().toISOString());
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
