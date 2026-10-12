import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBackendApiServer } from "../src/backend/api-server.mjs";

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
