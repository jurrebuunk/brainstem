import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBackendApiServer, normalizeBackendApiConfig } from "../src/backend/api-server.mjs";
import { openMigratedDatabase } from "../src/db/index.mjs";
import { DIALECTS, isolatedDatabaseUrl } from "./helpers/database.mjs";

test("backend api persists telemetry and exposes stats/history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brainstem-api-"));
  const configPath = join(dir, "brainstem.config.mjs");
  const telemetryDbPath = join(dir, "telemetry.sqlite");
  await writeFile(configPath, "export default {}\n");

  const api = createBackendApiServer({
    host: "127.0.0.1",
    port: 0,
    configPath,
    telemetryDbPath,
    token: "secret"
  });
  await api.listen();

  try {
    const setup = await fetch(`${api.url}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "v3ry-long-random-root-passphrase!" })
    });
    assert.equal(setup.status, 200);
    const setupBody = await setup.json();
    const cookie = setup.headers.getSetCookie?.().join("; ")
      ?? setup.headers.get("set-cookie");
    assert.ok(cookie);
    assert.ok(setupBody.user.permissions.includes("events:read"));

    const setupAgain = await fetch(`${api.url}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "other", password: "another-safe-passphrase-123!" })
    });
    assert.equal(setupAgain.status, 409);

    const event = {
      version: "1",
      kind: "brainstem.core.decision",
      payload: {
        timestamp: "2026-10-12T10:00:00.000Z",
        decision: { payload: { decision: "queue" } },
        observation: { payload: { id: "obs-1" } },
        pollId: "input-1:1"
      }
    };

    const unauthorized = await fetch(`${api.url}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event)
    });
    assert.equal(unauthorized.status, 401);

    const ingest = await fetch(`${api.url}/api/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret"
      },
      body: JSON.stringify(event)
    });
    assert.equal(ingest.status, 204);

    const events = await fetch(`${api.url}/api/events`, {
      headers: { cookie }
    }).then(response => response.json());
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "brainstem.core.decision");

    const stats = await fetch(`${api.url}/api/stats`, {
      headers: { cookie }
    }).then(response => response.json());
    assert.equal(stats.counters["decisions.queue"], 1);
  }
  finally {
    await api.close();
  }
});

test("backend api rejects weak first-run passwords", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brainstem-api-weak-password-"));
  const configPath = join(dir, "brainstem.config.mjs");
  const telemetryDbPath = join(dir, "telemetry.sqlite");
  await writeFile(configPath, "export default {}\n");

  const api = createBackendApiServer({ host: "127.0.0.1", port: 0, configPath, telemetryDbPath });
  await api.listen();

  try {
    const weak = await fetch(`${api.url}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "adminadminadmin" })
    });
    assert.equal(weak.status, 400);
  }
  finally {
    await api.close();
  }
});

test("backend api enforces permissions, csrf, and session revocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brainstem-api-rbac-"));
  const configPath = join(dir, "brainstem.config.mjs");
  const telemetryDbPath = join(dir, "telemetry.sqlite");
  await writeFile(configPath, "export default {}\n");

  const api = createBackendApiServer({ host: "127.0.0.1", port: 0, configPath, telemetryDbPath });
  await api.listen();

  try {
    const setup = await fetch(`${api.url}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "v3ry-long-random-root-passphrase!" })
    });
    const cookie = setup.headers.getSetCookie?.().join("; ") ?? setup.headers.get("set-cookie");
    const { csrfToken } = await setup.json();

    const roles = await fetch(`${api.url}/api/roles`, { headers: { cookie } }).then(response => response.json());
    const viewer = roles.roles.find(role => role.name === "Viewer");
    assert.ok(viewer);

    const viewerUser = await fetch(`${api.url}/api/users`, {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ username: "viewer", password: "v3ry-long-random-root-passphrase!", roleIds: [viewer.id] })
    });
    assert.equal(viewerUser.status, 201);

    const login = await fetch(`${api.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "viewer", password: "v3ry-long-random-root-passphrase!" })
    });
    const viewerCookie = login.headers.getSetCookie?.().join("; ") ?? login.headers.get("set-cookie");
    const viewerBody = await login.json();

    const configRead = await fetch(`${api.url}/api/config`, { headers: { cookie: viewerCookie } });
    assert.equal(configRead.status, 403);

    const noCsrf = await fetch(`${api.url}/api/auth/logout`, { method: "POST", headers: { cookie: viewerCookie } });
    assert.equal(noCsrf.status, 403);

    const logout = await fetch(`${api.url}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: viewerCookie, "x-csrf-token": viewerBody.csrfToken }
    });
    assert.equal(logout.status, 200);

    const afterLogout = await fetch(`${api.url}/api/stats`, { headers: { cookie: viewerCookie } });
    assert.equal(afterLogout.status, 401);

    const viewerRecord = await viewerUser.json();
    const disableViewer = await fetch(`${api.url}/api/users/${viewerRecord.id}`, {
      method: "PUT",
      headers: { cookie, "x-csrf-token": csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ username: "viewer", active: false, roleIds: [viewer.id] })
    });
    assert.equal(disableViewer.status, 200);

    const disabledLogin = await fetch(`${api.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "viewer", password: "v3ry-long-random-root-passphrase!" })
    });
    assert.equal(disabledLogin.status, 401);

    const customRole = await fetch(`${api.url}/api/roles`, {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ name: "Responder", description: "Can inspect events", permissions: ["events:read", "stats:read"] })
    });
    assert.equal(customRole.status, 201);
    const customRoleBody = await customRole.json();

    const deleteRole = await fetch(`${api.url}/api/roles/${customRoleBody.id}`, {
      method: "DELETE",
      headers: { cookie, "x-csrf-token": csrfToken }
    });
    assert.equal(deleteRole.status, 200);

    const deleteViewer = await fetch(`${api.url}/api/users/${viewerRecord.id}`, {
      method: "DELETE",
      headers: { cookie, "x-csrf-token": csrfToken }
    });
    assert.equal(deleteViewer.status, 200);
  }
  finally {
    await api.close();
  }
});

test("backend api prevents removal of the last active administrator", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brainstem-api-last-admin-"));
  const configPath = join(dir, "brainstem.config.mjs");
  const telemetryDbPath = join(dir, "telemetry.sqlite");
  await writeFile(configPath, "export default {}\n");

  const api = createBackendApiServer({ host: "127.0.0.1", port: 0, configPath, telemetryDbPath });
  await api.listen();

  try {
    const setup = await fetch(`${api.url}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "v3ry-long-random-root-passphrase!" })
    });
    const cookie = setup.headers.getSetCookie?.().join("; ") ?? setup.headers.get("set-cookie");
    const { user, csrfToken } = await setup.json();

    const deleteLast = await fetch(`${api.url}/api/users/${user.id}`, {
      method: "DELETE",
      headers: { cookie, "x-csrf-token": csrfToken }
    });
    assert.equal(deleteLast.status, 409);
  }
  finally {
    await api.close();
  }
});

for (const dialect of DIALECTS) {
  test(`[${dialect}] backend api serves auth and telemetry from a database url`, async () => {
    await withDatabaseApi(dialect, {}, async api => {
      const { cookie } = await setupAdmin(api);

      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      for (const id of ["obs-1", "obs-2"]) {
        const ingest = await fetch(`${api.url}/api/events`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer secret" },
          body: JSON.stringify({
            version: "1",
            kind: "brainstem.core.decision",
            payload: { timestamp: new Date().toISOString(), decision: { payload: { decision: "queue" } }, observation: { payload: { id } } }
          })
        });
        assert.equal(ingest.status, 204);
      }
      await api.telemetryStore.persistEvent({ version: "1", kind: "brainstem.core.decision", receivedAt: old, payload: {} });

      const health = await fetch(`${api.url}/api/health`).then(response => response.json());
      assert.equal(health.persistedEvents, 3);
      assert.equal(health.setupRequired, false);

      const stats = await fetch(`${api.url}/api/stats`, { headers: { cookie } }).then(response => response.json());
      assert.equal(stats.counters["decisions.queue"], 2);

      const maintenance = await api.runMaintenance({ force: true });
      assert.equal(maintenance["telemetry.prune"].ran, true);
      assert.equal(maintenance["telemetry.prune"].result.eventsByAge, 1);
      assert.equal(maintenance["auth.prune"].ran, true);

      // Another run inside the interval is skipped (as if another replica ran it).
      const skipped = await api.runMaintenance();
      assert.equal(skipped["telemetry.prune"].ran, false);

      const events = await fetch(`${api.url}/api/events`, { headers: { cookie } }).then(response => response.json());
      assert.deepEqual(events.map(event => event.payload.observation.payload.id), ["obs-1", "obs-2"]);
    });
  });

  test(`[${dialect}] backend api allows exactly one concurrent first-admin setup`, async () => {
    await withDatabaseApi(dialect, {}, async api => {
      const responses = await Promise.all([0, 1, 2, 3, 4].map(index => fetch(`${api.url}/api/auth/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: `admin${index}`, password: "v3ry-long-random-root-passphrase!" })
      })));
      const statuses = responses.map(response => response.status).sort();
      await Promise.all(responses.map(response => response.arrayBuffer()));

      assert.deepEqual(statuses, [200, 409, 409, 409, 409]);
      assert.equal((await api.authStore.listUsers()).length, 1);
    });
  });

  test(`[${dialect}] backend api rate limits logins per client ip in the database`, async () => {
    await withDatabaseApi(dialect, {}, async api => {
      await setupAdmin(api);
      const login = forwardedFor => fetch(`${api.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
        body: JSON.stringify({ username: "admin", password: "wrong-password-123" })
      }).then(async response => {
        await response.arrayBuffer();
        return response.status;
      });

      for (let attempt = 0; attempt < 8; attempt += 1) {
        assert.equal(await login("198.51.100.1"), 401);
      }
      assert.equal(await login("198.51.100.1"), 429);
      // Behind the trusted loopback proxy, another client is unaffected.
      assert.equal(await login("198.51.100.2"), 401);

      const rows = await api.database.db.selectFrom("auth_login_attempts").selectAll()
        .where("key", "like", "ip:198.51.100.%").orderBy("key").execute();
      assert.deepEqual(rows.map(row => [row.key, Number(row.count)]), [["ip:198.51.100.1", 9], ["ip:198.51.100.2", 1]]);
    });

    await withDatabaseApi(dialect, { trustedProxies: [] }, async api => {
      await setupAdmin(api);
      const statuses = [];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const response = await fetch(`${api.url}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${attempt}` },
          body: JSON.stringify({ username: "admin", password: "wrong-password-123" })
        });
        await response.arrayBuffer();
        statuses.push(response.status);
      }
      // Untrusted X-Forwarded-For is ignored: setup + 8 logins share the socket ip.
      assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401, 401, 429]);
    });
  });
}

test("backend api uses a provided database handle without closing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brainstem-api-handle-"));
  const configPath = join(dir, "brainstem.config.mjs");
  await writeFile(configPath, "export default {}\n");
  const database = await openMigratedDatabase({ url: `sqlite:${join(dir, "shared.sqlite")}` });

  try {
    const api = createBackendApiServer({ host: "127.0.0.1", port: 0, configPath, database, maintenanceIntervalMs: 0 });
    await api.listen();
    try {
      assert.equal(api.database, database);
      await setupAdmin(api);
    }
    finally {
      await api.close();
    }

    const users = await database.db.selectFrom("auth_users").select("username").execute();
    assert.deepEqual(users.map(user => user.username), ["admin"]);
  }
  finally {
    await database.close();
  }
});

test("backend api config exposes database url, trusted proxies and maintenance interval", () => {
  const keys = ["BRAINSTEM_DATABASE_URL", "BRAINSTEM_TRUSTED_PROXIES", "BRAINSTEM_MAINTENANCE_INTERVAL_MS"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];

  try {
    const defaults = normalizeBackendApiConfig({ telemetryDbPath: "data/x.sqlite" }, { repoRoot: "/srv" });
    assert.equal(defaults.databaseUrl, "sqlite:/srv/data/x.sqlite");
    assert.deepEqual(defaults.trustedProxies, ["loopback"]);
    assert.equal(defaults.maintenanceIntervalMs, 10 * 60 * 1000);

    process.env.BRAINSTEM_DATABASE_URL = "postgres://u@h/db";
    process.env.BRAINSTEM_TRUSTED_PROXIES = "10.0.0.0/8";
    process.env.BRAINSTEM_MAINTENANCE_INTERVAL_MS = "60000";
    const fromEnv = normalizeBackendApiConfig({}, { repoRoot: "/srv" });
    assert.equal(fromEnv.databaseUrl, "postgres://u@h/db");
    assert.equal(fromEnv.trustedProxies, "10.0.0.0/8");
    assert.equal(fromEnv.maintenanceIntervalMs, 60_000);

    const explicit = normalizeBackendApiConfig({ databaseUrl: "sqlite::memory:", trustedProxies: ["::1"] });
    assert.equal(explicit.databaseUrl, "sqlite::memory:");
    assert.deepEqual(explicit.trustedProxies, ["::1"]);
  }
  finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

async function withDatabaseApi(dialect, options, run) {
  const dir = await mkdtemp(join(tmpdir(), `brainstem-api-${dialect}-`));
  const configPath = join(dir, "brainstem.config.mjs");
  await writeFile(configPath, "export default {}\n");
  const isolated = await isolatedDatabaseUrl(dialect);

  const api = createBackendApiServer({
    host: "127.0.0.1",
    port: 0,
    configPath,
    databaseUrl: isolated.url,
    token: "secret",
    ...options
  });

  try {
    await api.listen();
    await run(api);
  }
  finally {
    await api.close();
    await isolated.drop();
  }
}

async function setupAdmin(api) {
  const setup = await fetch(`${api.url}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "v3ry-long-random-root-passphrase!" })
  });
  assert.equal(setup.status, 200);
  const body = await setup.json();
  const cookie = setup.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  return { cookie, csrfToken: body.csrfToken, user: body.user };
}
