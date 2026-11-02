import assert from "node:assert/strict";
import test from "node:test";

import { createAuthStore } from "../src/backend/auth-store.mjs";
import { clientIp, createTrustedProxies } from "../src/backend/client-ip.mjs";
import {
  claimMaintenanceRun,
  createMaintenanceScheduler,
  lastMaintenanceRun
} from "../src/backend/maintenance.mjs";
import { createTelemetryStore } from "../src/backend/telemetry-store.mjs";
import { dialectTest } from "./helpers/database.mjs";

const PASSWORD = "v3ry-long-random-root-passphrase!";
const DAY_MS = 24 * 60 * 60 * 1000;

function decisionEvent(id, receivedAt, decision = "queue") {
  return {
    version: "1",
    kind: "brainstem.core.decision",
    receivedAt,
    payload: {
      timestamp: receivedAt,
      decision: { payload: { decision } },
      observation: { payload: { id } }
    }
  };
}

dialectTest("telemetry store persists events, filters history and counts stats", async ({ handle }) => {
  const store = createTelemetryStore({ database: handle });
  const now = Date.now();

  await store.persistEvent(decisionEvent("a", new Date(now - 3000).toISOString()));
  await store.persistEvent(decisionEvent("b", new Date(now - 2000).toISOString(), "ignore"));
  await store.persistEvent({
    version: "1",
    kind: "brainstem.plugin.log",
    receivedAt: new Date(now - 1000).toISOString(),
    payload: { level: "error", plugin: "p", message: "boom" }
  });

  assert.equal(await store.eventCount(), 3);

  const all = await store.getEvents({ limit: 10 });
  assert.deepEqual(all.map(event => event.payload.observation?.payload.id ?? event.kind),
    ["a", "b", "brainstem.plugin.log"]);
  assert.ok(all.every(event => typeof event.persistedId === "number"));

  const latest = await store.getEvents({ limit: 1 });
  assert.equal(latest[0].kind, "brainstem.plugin.log");

  const errors = await store.getEvents({ limit: 10, level: "error" });
  assert.equal(errors.length, 1);

  const decisions = await store.getEvents({
    limit: 10,
    kind: "brainstem.core.decision",
    after: new Date(now - 2500).toISOString()
  });
  assert.deepEqual(decisions.map(event => event.payload.observation.payload.id), ["b"]);

  const stats = await store.getStats();
  assert.equal(stats.counters["events.total"], 3);
  assert.equal(stats.counters["decisions.total"], 2);
  assert.equal(stats.counters["decisions.queue"], 1);
  assert.equal(stats.counters["errors.total"], 1);
  assert.ok(stats.series.some(row => row.metric === "decisions.total" && row.value >= 1));
});

dialectTest("telemetry writes do not prune; prune() applies age and row limits", async ({ handle }) => {
  const store = createTelemetryStore({
    database: handle,
    statsPruneAfterDays: 7,
    eventLogPruneAfterDays: 7,
    eventLogMaxRows: 3
  });
  const now = new Date();
  const old = new Date(now.getTime() - 10 * DAY_MS).toISOString();

  await store.persistEvent(decisionEvent("old", old));
  for (let index = 0; index < 5; index += 1) {
    await store.persistEvent(decisionEvent(`new-${index}`, new Date(now.getTime() - (5 - index) * 1000).toISOString()));
  }

  // The write path keeps everything until maintenance runs.
  assert.equal(await store.eventCount(), 6);

  const result = await store.prune({ now });
  assert.equal(result.eventsByAge, 1);
  assert.equal(result.eventsByRows, 2);
  assert.ok(result.stats >= 1);

  const remaining = await store.getEvents({ limit: 10 });
  assert.deepEqual(remaining.map(event => event.payload.observation.payload.id), ["new-2", "new-3", "new-4"]);

  const series = await handle.db.selectFrom("stat_timeseries").select("bucket").execute();
  assert.ok(series.every(row => row.bucket >= new Date(now.getTime() - 7 * DAY_MS).toISOString()));
});

dialectTest("maintenance runs are claimed once per interval across replicas", async ({ handle }) => {
  const now = new Date("2026-10-13T12:00:00.000Z");

  const claims = await Promise.all([1, 2, 3, 4].map(() =>
    claimMaintenanceRun(handle.db, "task", { minIntervalMs: 60_000, now })));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await lastMaintenanceRun(handle.db, "task"), now.toISOString());

  const soon = new Date(now.getTime() + 30_000);
  assert.equal(await claimMaintenanceRun(handle.db, "task", { minIntervalMs: 60_000, now: soon }), false);

  const later = new Date(now.getTime() + 61_000);
  assert.equal(await claimMaintenanceRun(handle.db, "task", { minIntervalMs: 60_000, now: later }), true);
  assert.equal(await lastMaintenanceRun(handle.db, "task"), later.toISOString());

  let runs = 0;
  const replicas = [1, 2].map(() => createMaintenanceScheduler({
    db: handle.db,
    intervalMs: 60_000,
    tasks: { prune: async () => { runs += 1; } }
  }));
  const results = await Promise.all(replicas.map(replica => replica.run()));
  assert.equal(runs, 1);
  assert.deepEqual(results.map(result => result.prune.ran).sort(), [false, true]);

  await replicas[0].run({ force: true });
  assert.equal(runs, 2);
});

dialectTest("auth store creates exactly one initial admin under concurrency", async ({ handle }) => {
  const auth = await createAuthStore({ database: handle });
  assert.equal(await auth.setupRequired(), true);

  const results = await Promise.allSettled([0, 1, 2, 3, 4].map(index =>
    auth.createInitialAdmin({ username: `admin${index}`, password: PASSWORD })));

  const fulfilled = results.filter(result => result.status === "fulfilled");
  const rejected = results.filter(result => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.ok(rejected.every(result => result.reason.statusCode === 409));
  assert.equal(await auth.setupRequired(), false);
  assert.equal((await auth.listUsers()).length, 1);
  assert.ok(fulfilled[0].value.permissions.includes("roles:manage"));

  // Default roles are created idempotently by every replica.
  const second = await createAuthStore({ database: handle });
  assert.equal((await second.listRoles()).filter(role => role.name === "Administrator").length, 1);
});

dialectTest("auth store manages users, roles, sessions and last-admin guards", async ({ handle }) => {
  const auth = await createAuthStore({ database: handle });
  const admin = await auth.createInitialAdmin({ username: "admin", password: PASSWORD });

  assert.equal((await auth.verifyLogin({ username: "ADMIN", password: PASSWORD }))?.id, admin.id);
  assert.equal(await auth.verifyLogin({ username: "admin", password: "wrong-password-123" }), null);

  const viewerRole = (await auth.listRoles()).find(role => role.name === "Viewer");
  const viewer = await auth.createUser({ username: "viewer", password: PASSWORD.toUpperCase(), roleIds: [viewerRole.id] });
  assert.deepEqual(viewer.roles.map(role => role.name), ["Viewer"]);

  await assert.rejects(
    () => auth.createUser({ username: "viewer", password: PASSWORD, roleIds: [] }),
    error => error.statusCode === 409
  );

  const updated = await auth.updateUser(viewer.id, { name: "View Er", active: false });
  assert.equal(updated.active, false);
  assert.equal(updated.name, "View Er");
  assert.equal(await auth.verifyLogin({ username: "viewer", password: PASSWORD.toUpperCase() }), null);

  await assert.rejects(() => auth.deleteUser(admin.id), error => error.statusCode === 409);
  await assert.rejects(() => auth.updateUser(admin.id, { active: false }), error => error.statusCode === 409);

  const role = await auth.createRole({ name: "Responder", permissions: ["events:read"] });
  const renamed = await auth.updateRole(role.id, { name: "Responders" });
  assert.equal(renamed.name, "Responders");
  await auth.deleteRole(role.id);
  const adminRole = (await auth.listRoles()).find(entry => entry.name === "Administrator");
  await assert.rejects(() => auth.deleteRole(adminRole.id), error => error.statusCode === 409);

  const session = await auth.createSession(admin.id);
  assert.equal((await auth.getSession(session.token))?.user.id, admin.id);
  await auth.revokeSession(session.token);
  assert.equal(await auth.getSession(session.token), null);

  const live = await auth.createSession(admin.id);
  assert.equal(await auth.pruneExpiredSessions(), 1);
  assert.equal(await auth.pruneExpiredSessions({ now: new Date(Date.now() + 13 * 60 * 60 * 1000) }), 1);
  assert.equal(await auth.getSession(live.token), null);

  await auth.deleteUser(viewer.id);
  assert.equal(await auth.getUser(viewer.id), null);
});

dialectTest("login attempts are counted in a shared fixed window", async ({ handle }) => {
  const auth = await createAuthStore({ database: handle });
  const windowMs = 15 * 60 * 1000;
  const start = new Date("2026-10-13T12:00:00.000Z");

  const counts = await Promise.all([1, 2, 3].map(() =>
    auth.registerLoginAttempt("ip:1.2.3.4", { windowMs, now: start })));
  assert.deepEqual(counts.sort(), [1, 2, 3]);

  assert.equal(await auth.registerLoginAttempt("ip:1.2.3.4", { windowMs, now: new Date(start.getTime() + windowMs - 1) }), 4);
  assert.equal(await auth.registerLoginAttempt("ip:5.6.7.8", { windowMs, now: start }), 1);

  // The window restarts once it has elapsed.
  assert.equal(await auth.registerLoginAttempt("ip:1.2.3.4", { windowMs, now: new Date(start.getTime() + windowMs) }), 1);

  await auth.resetLoginAttempts("ip:1.2.3.4");
  assert.equal(await auth.registerLoginAttempt("ip:1.2.3.4", { windowMs, now: start }), 1);

  assert.equal(await auth.pruneLoginAttempts({ windowMs, now: new Date(start.getTime() + windowMs) }), 2);
});

test("client ip honours X-Forwarded-For only from trusted proxies", () => {
  const request = (remoteAddress, forwarded) => ({
    socket: { remoteAddress },
    headers: forwarded ? { "x-forwarded-for": forwarded } : {}
  });
  const loopback = createTrustedProxies();

  assert.equal(clientIp(request("203.0.113.9", "198.51.100.1"), loopback), "203.0.113.9");
  assert.equal(clientIp(request("::ffff:127.0.0.1", "198.51.100.1"), loopback), "198.51.100.1");
  assert.equal(clientIp(request("::1", "198.51.100.1, 127.0.0.1"), loopback), "198.51.100.1");
  assert.equal(clientIp(request("127.0.0.1"), loopback), "127.0.0.1");
  assert.equal(clientIp(request("127.0.0.1", "not-an-ip"), loopback), "127.0.0.1");

  const cluster = createTrustedProxies("10.0.0.0/8, 192.168.1.5");
  assert.equal(clientIp(request("10.1.2.3", "198.51.100.7, 10.9.9.9"), cluster), "198.51.100.7");
  assert.equal(clientIp(request("192.168.1.5", "198.51.100.8"), cluster), "198.51.100.8");
  assert.equal(clientIp(request("127.0.0.1", "198.51.100.1"), cluster), "127.0.0.1");

  const none = createTrustedProxies("");
  assert.equal(clientIp(request("127.0.0.1", "198.51.100.1"), none), "127.0.0.1");

  assert.throws(() => createTrustedProxies("nope"), /Invalid trusted proxy/);
});
