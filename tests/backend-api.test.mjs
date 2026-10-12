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
      headers: { authorization: "Bearer secret" }
    }).then(response => response.json());
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "brainstem.core.decision");

    const stats = await fetch(`${api.url}/api/stats`, {
      headers: { authorization: "Bearer secret" }
    }).then(response => response.json());
    assert.equal(stats.counters["decisions.queue"], 1);
  }
  finally {
    await api.close();
  }
});
