import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createBackendApiServer } from "../src/backend/api-server.mjs";
import { createConfigStore } from "../src/backend/config-store.mjs";
import { tempDir } from "./helpers/fixtures.mjs";
import { dialectTest } from "./helpers/database.mjs";
import exampleConfig from "../brainstem.config.example.mjs";

const ADMIN_PASSWORD = "v3ry-long-random-root-passphrase!";

test("config store reads the config file and cannot write it", async () => {
  const dir = await tempDir("config-read");
  const configPath = join(dir, "brainstem.config.mjs");
  await writeFile(configPath, "export default { version: 1 };\n");

  const store = createConfigStore(configPath);
  assert.deepEqual(await store.read(), { path: configPath, content: "export default { version: 1 };\n" });
  assert.equal(store.save, undefined, "the API never writes or executes config files");
});

test("with configSource file the config api is read-only", async () => {
  await withApi(async ({ api, session, configPath }) => {
    const read = await fetch(`${api.url}/api/config`, { headers: { cookie: session.cookie } }).then(response => response.json());
    assert.equal(read.source, "file");
    assert.equal(read.readOnly, true);
    assert.equal(read.content, "export default {};\n");

    const noCsrf = await fetch(`${api.url}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: session.cookie },
      body: JSON.stringify({ content: "{}" })
    });
    assert.equal(noCsrf.status, 403);

    const write = await fetch(`${api.url}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: session.cookie, "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ content: "export default { evil: process.exit() };" })
    });
    assert.equal(write.status, 409);
    assert.match((await write.json()).error, /managed as a file/);
    assert.equal(await readFile(configPath, "utf8"), "export default {};\n");
  });
});

test("with configSource database saves are validated versions guarded by If-Match", async () => {
  await withApi(async ({ api, session }) => {
    const headers = { "content-type": "application/json", cookie: session.cookie, "x-csrf-token": session.csrfToken };
    const put = (body, extra = {}) => fetch(`${api.url}/api/config`, { method: "PUT", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const spec = validSpec();

    const empty = await fetch(`${api.url}/api/config`, { headers: { cookie: session.cookie } }).then(response => response.json());
    assert.equal(empty.source, "database");
    assert.equal(empty.version, null);

    const missingPrecondition = await put({ content: JSON.stringify(spec) });
    assert.equal(missingPrecondition.status, 428);

    const invalid = await put({ content: JSON.stringify({ ...spec, policy: { dispatch: {} } }), expectedVersion: null });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /\/policy\/dispatch: must have property 'attention'/);

    const notJson = await put({ content: "export default {}", expectedVersion: null });
    assert.equal(notJson.status, 400);

    const first = await put({ content: JSON.stringify(spec), comment: "initial", expectedVersion: null });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("etag"), '"1"');
    assert.equal((await first.json()).version.author, "admin");

    const read = await fetch(`${api.url}/api/config`, { headers: { cookie: session.cookie } });
    assert.equal(read.headers.get("etag"), '"1"');
    assert.deepEqual(JSON.parse((await read.json()).content), spec);

    const second = await put({ spec: { ...spec, inputs: [] } }, { "if-match": '"1"' });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).version.id, 2);

    const stale = await put({ spec: { ...spec, destinations: [] } }, { "if-match": '"1"' });
    assert.equal(stale.status, 409, "someone else saved version 2 meanwhile");

    const unchanged = await put({ spec: { ...spec, inputs: [] } }, { "if-match": '"2"' });
    assert.equal((await unchanged.json()).unchanged, true);

    const versions = await fetch(`${api.url}/api/config/versions`, { headers: { cookie: session.cookie } }).then(response => response.json());
    assert.deepEqual(versions.map(version => [version.id, version.active]), [[2, true], [1, false]]);

    const rollback = await fetch(`${api.url}/api/config/versions/1/activate`, { method: "POST", headers, body: "{}" });
    assert.equal(rollback.status, 200);
    assert.equal((await rollback.json()).version.id, 1);

    const missing = await fetch(`${api.url}/api/config/versions/99/activate`, { method: "POST", headers, body: "{}" });
    assert.equal(missing.status, 404);

    const schema = await fetch(`${api.url}/api/config/schema`, { headers: { cookie: session.cookie } }).then(response => response.json());
    assert.equal(schema.title, "Brainstem config");
  }, { configSource: "database" });
});

dialectTest("sse fans out across api replicas and resumes from Last-Event-ID", async ({ handle }) => {
  const dir = await tempDir("api-sse-fanout");
  const configPath = join(dir, "brainstem.config.mjs");
  await writeFile(configPath, "export default {};\n");

  const options = { host: "127.0.0.1", port: 0, configPath, database: handle, token: "secret", maintenanceIntervalMs: 0 };
  const replicaA = createBackendApiServer(options);
  const replicaB = createBackendApiServer(options);
  await replicaA.listen();
  await replicaB.listen();
  await handle.notifier.ready?.();

  try {
    const session = await setupAdmin(replicaA);
    const ingest = (api, id) => fetch(`${api.url}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({ version: "1", kind: "brainstem.core.decision", payload: { observation: { payload: { id } } } })
    });

    const controller = new AbortController();
    const stream = await fetch(`${replicaB.url}/api/stream`, { headers: { cookie: session.cookie }, signal: controller.signal });
    const reader = stream.body.getReader();
    const events = readSseEvents(reader, { withIds: true });
    assert.equal((await events.next()).value.event.kind, "web.connected");

    // Ingested on replica A, streamed by replica B.
    assert.equal((await ingest(replicaA, "fan-1")).status, 204);
    const first = (await events.next()).value;
    assert.equal(first.event.payload.observation.payload.id, "fan-1");
    assert.ok(Number(first.id) > 0, "persisted events carry their row id");

    assert.equal((await ingest(replicaA, "fan-2")).status, 204);
    assert.equal((await events.next()).value.event.payload.observation.payload.id, "fan-2");
    controller.abort();
    await reader.cancel().catch(() => {});

    await ingest(replicaB, "fan-3");

    // Reconnect to the other replica with the last id seen.
    const resumed = await fetch(`${replicaA.url}/api/stream`, {
      headers: { cookie: session.cookie, "last-event-id": first.id }
    });
    const resumedReader = resumed.body.getReader();
    const replay = readSseEvents(resumedReader, { withIds: true });
    assert.equal((await replay.next()).value.event.payload.resumedFrom, Number(first.id));
    assert.deepEqual(
      [(await replay.next()).value, (await replay.next()).value].map(item => item.event.payload.observation.payload.id),
      ["fan-2", "fan-3"]
    );
    await resumedReader.cancel().catch(() => {});
  }
  finally {
    await replicaA.close();
    await replicaB.close();
  }
});

test("sse stream requires a session and receives ingested telemetry", async () => {
  await withApi(async ({ api, session }) => {
    const anonymous = await fetch(`${api.url}/api/stream`);
    assert.equal(anonymous.status, 401);

    const controller = new AbortController();
    const stream = await fetch(`${api.url}/api/stream`, {
      headers: { cookie: session.cookie },
      signal: controller.signal
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type"), /text\/event-stream/);

    const reader = stream.body.getReader();
    const events = readSseEvents(reader);

    const connected = await events.next();
    assert.equal(connected.value.kind, "web.connected");

    const ingest = await fetch(`${api.url}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({
        version: "1",
        kind: "brainstem.core.decision",
        payload: {
          timestamp: new Date().toISOString(),
          decision: { payload: { decision: "queue" } },
          observation: { payload: { id: "sse-1" } }
        }
      })
    });
    assert.equal(ingest.status, 204);

    const received = await events.next();
    assert.equal(received.value.kind, "brainstem.core.decision");
    assert.equal(received.value.payload.observation.payload.id, "sse-1");

    controller.abort();
    await reader.cancel().catch(() => {});
  });
});

function validSpec() {
  return {
    inputs: [{ id: "a", module: "./plugins/http-health/index.mjs", input: "check", config: { url: "https://example.com" } }],
    destinations: [{ id: "log", module: "./plugins/log-decisions/index.mjs" }],
    policy: exampleConfig.policy,
    laya: exampleConfig.laya
  };
}

async function setupAdmin(api) {
  const setup = await fetch(`${api.url}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD })
  });
  assert.equal(setup.status, 200);
  const body = await setup.json();
  const cookie = setup.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  return { cookie, csrfToken: body.csrfToken };
}

async function withApi(run, options = {}) {
  const dir = await tempDir("api-config-sse");
  const configPath = join(dir, "brainstem.config.mjs");
  await writeFile(configPath, "export default {};\n");

  const api = createBackendApiServer({
    host: "127.0.0.1",
    port: 0,
    configPath,
    telemetryDbPath: join(dir, "telemetry.sqlite"),
    token: "secret",
    configSource: "file",
    ...options
  });
  await api.listen();

  try {
    const setup = await fetch(`${api.url}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD })
    });
    assert.equal(setup.status, 200);
    const body = await setup.json();
    const cookie = setup.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");

    await run({ api, configPath, session: { cookie, csrfToken: body.csrfToken } });
  }
  finally {
    await api.close();
  }
}

async function* readSseEvents(reader, { withIds = false } = {}) {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = chunk.split("\n");
      const data = lines
        .filter(line => line.startsWith("data: "))
        .map(line => line.slice(6))
        .join("\n");
      const id = lines.find(line => line.startsWith("id: "))?.slice(4) ?? null;
      if (data) yield withIds ? { id, event: JSON.parse(data) } : JSON.parse(data);
    }
  }
}
