import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createBackendApiServer } from "../src/backend/api-server.mjs";
import { createConfigStore } from "../src/backend/config-store.mjs";
import { tempDir } from "./helpers/fixtures.mjs";

const ADMIN_PASSWORD = "v3ry-long-random-root-passphrase!";

test("config store saves valid modules atomically and keeps a backup", async () => {
  const dir = await tempDir("config-save");
  const configPath = join(dir, "brainstem.config.mjs");
  await writeFile(configPath, "export default { version: 1 };\n");

  const store = createConfigStore(configPath);
  const result = await store.save("export default { version: 2 };\n");

  assert.equal(result.ok, true);
  assert.equal(await readFile(configPath, "utf8"), "export default { version: 2 };\n");

  const files = await readdir(dir);
  const backups = files.filter(name => name.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(dir, backups[0]), "utf8"), "export default { version: 1 };\n");
  assert.equal(files.filter(name => name.endsWith(".tmp")).length, 0);
});

test("config store rejects syntax errors and leaves the file untouched", async () => {
  const dir = await tempDir("config-invalid");
  const configPath = join(dir, "brainstem.config.mjs");
  await writeFile(configPath, "export default { version: 1 };\n");

  const store = createConfigStore(configPath);

  await assert.rejects(
    () => store.save("export default { version: ;\n"),
    /syntax check failed/i
  );
  assert.equal(await readFile(configPath, "utf8"), "export default { version: 1 };\n");
  assert.deepEqual(await readdir(dir), ["brainstem.config.mjs"]);
});

test("config api requires csrf and persists through the store", async () => {
  await withApi(async ({ api, session, configPath }) => {
    const content = "export default { saved: true };\n";

    const noCsrf = await fetch(`${api.url}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: session.cookie },
      body: JSON.stringify({ content })
    });
    assert.equal(noCsrf.status, 403);

    const saved = await fetch(`${api.url}/api/config`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken
      },
      body: JSON.stringify({ content })
    });
    assert.equal(saved.status, 200);
    assert.equal(await readFile(configPath, "utf8"), content);

    const read = await fetch(`${api.url}/api/config`, {
      headers: { cookie: session.cookie }
    }).then(response => response.json());
    assert.equal(read.content, content);
  });
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

async function withApi(run) {
  const dir = await tempDir("api-config-sse");
  const configPath = join(dir, "brainstem.config.mjs");
  await writeFile(configPath, "export default {};\n");

  const api = createBackendApiServer({
    host: "127.0.0.1",
    port: 0,
    configPath,
    telemetryDbPath: join(dir, "telemetry.sqlite"),
    token: "secret"
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

async function* readSseEvents(reader) {
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
      const data = chunk
        .split("\n")
        .filter(line => line.startsWith("data: "))
        .map(line => line.slice(6))
        .join("\n");
      if (data) yield JSON.parse(data);
    }
  }
}
