import assert from "node:assert/strict";
import { appendFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import logFilePlugin from "../plugins/log-file/index.mjs";
import { assertObservation, createInputContext } from "../src/sdk/index.mjs";
import { silentLogger, tempDir } from "./helpers/fixtures.mjs";

/*
 * Polls like the runtime does: the deferred checkpoint is
 * committed once the poll has finished.
 */
function watcher(config) {
  let saved = null;

  return async function poll() {
    let deferred;
    const ctx = createInputContext({
      config,
      logger: silentLogger,
      checkpoint: {
        get: async () => saved,
        defer: value => { deferred = value; }
      }
    });

    const observations = [];
    for await (const observation of logFilePlugin.inputs.lines.poll(ctx)) {
      observations.push(assertObservation(observation));
    }

    if (deferred !== undefined) saved = deferred;
    return observations;
  };
}

test("log-file starts at the end of an existing file by default", async () => {
  const path = join(await tempDir("log-file"), "app.log");
  await writeFile(path, "10:00 ERROR old failure\n");
  const poll = watcher({ path });

  assert.deepEqual(await poll(), [], "existing errors are not replayed");

  await appendFile(path, "10:05 INFO ok\n10:06 ERROR db timeout\n");
  const [observation] = await poll();

  assert.equal(observation.payload.id, "log:app.log:errors");
  assert.equal(observation.payload.title, "1 error line in app.log");
  assert.deepEqual(observation.payload.data.lines, ["10:06 ERROR db timeout"]);
  assert.deepEqual(await poll(), [], "a line is matched only once");
});

test("log-file reads from the start when startFromEnd is false and folds matches into one observation", async () => {
  const path = join(await tempDir("log-file"), "app.log");
  const lines = Array.from({ length: 30 }, (_, i) => `10:${String(i).padStart(2, "0")} ERROR failure ${i} ${"x".repeat(400)}`);
  await writeFile(path, `10:00 INFO boot\n${lines.join("\n")}\n`);

  const [observation, extra] = await watcher({ path, name: "api", startFromEnd: false, maxLines: 5, maxLineChars: 50, minimumDecision: "queue" })();

  assert.equal(extra, undefined, "one observation per poll");
  assert.equal(observation.payload.title, "30 error lines in api");
  assert.equal(observation.payload.data.lines.length, 5, "only the last maxLines are kept");
  assert.ok(observation.payload.data.lines.every(line => line.length <= 51));
  assert.match(observation.payload.message, /25 earlier matching lines not shown/);
  assert.equal(observation.payload.facts.minimum_decision, "queue");
});

test("log-file leaves a partial last line for the next poll", async () => {
  const path = join(await tempDir("log-file"), "app.log");
  await writeFile(path, "");
  const poll = watcher({ path });
  await poll();

  await appendFile(path, "10:00 ERROR half");
  assert.deepEqual(await poll(), []);

  await appendFile(path, " written\n");
  const [observation] = await poll();
  assert.deepEqual(observation.payload.data.lines, ["10:00 ERROR half written"]);
});

test("log-file starts over after truncation or rotation", async () => {
  const dir = await tempDir("log-file");
  const path = join(dir, "app.log");
  await writeFile(path, "10:00 INFO a long line to move the offset forward\n");
  const poll = watcher({ path });
  await poll();

  await writeFile(path, "11:00 ERROR after truncate\n");
  assert.deepEqual((await poll())[0].payload.data.lines, ["11:00 ERROR after truncate"]);

  await rename(path, join(dir, "app.log.1"));
  await writeFile(path, "12:00 FATAL after rotate\n");
  assert.deepEqual((await poll())[0].payload.data.lines, ["12:00 FATAL after rotate"]);
});

test("log-file emits nothing for a missing file", async () => {
  const poll = watcher({ path: join(await tempDir("log-file"), "missing.log") });
  assert.deepEqual(await poll(), []);
});
