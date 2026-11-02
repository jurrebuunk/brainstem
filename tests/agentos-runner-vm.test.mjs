import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import agentosRunnerPlugin from "../plugins/agentos-runner/index.mjs";
import { toolCommandName } from "../plugins/agentos-runner/prompt.mjs";
import { MemoryPluginStateStore } from "../src/runtime/plugin-state.mjs";
import { createDestinationContext, createOutputEnvelope } from "../src/sdk/index.mjs";
import { tempDir } from "./helpers/fixtures.mjs";

/*
 * Runs the plugin against a real agentOS VM (no AI key needed).
 *
 * Skipped when the optional dependency is not installed, and on
 * NixOS unless AGENTOS_SIDECAR_BIN points at a wrapper that can
 * start the generic-Linux sidecar binary (see the plugin docs);
 * without one, VM creation hangs instead of failing.
 */
const missingPackage = await import("@rivet-dev/agentos-core")
  .then(() => false, () => "@rivet-dev/agentos-core is not installed");

const skip = missingPackage || (
  existsSync("/etc/NIXOS") && !process.env.AGENTOS_SIDECAR_BIN
    ? "NixOS needs AGENTOS_SIDECAR_BIN to start the agentOS sidecar"
    : false
);

test("agentos-runner runs a command task in a real agentOS VM", { skip, timeout: 120_000 }, async () => {
  const logsDir = await tempDir("agentos-logs");
  await mkdir(logsDir, { recursive: true });
  await writeFile(join(logsDir, "app.log"), "10:00 INFO ok\n10:01 ERROR db timeout\n10:02 ERROR db timeout\n");

  const reports = [];
  const results = [];
  const logs = [];
  const logger = Object.fromEntries(
    ["debug", "info", "warn", "error"].map(level => [
      level,
      (message, data) => logs.push({ level, message, data })
    ])
  );
  const store = new MemoryPluginStateStore();

  const output = createOutputEnvelope({
    idempotencyKey: "log-triage:http:api:r0:e1",
    decision: {
      version: "1",
      kind: "decision",
      payload: { observationId: "http:api", revision: 0, decision: "escalate", route: "infrastructure", confidence: { route: 0.9 } }
    },
    observation: {
      version: "1",
      kind: "observation",
      payload: { id: "http:api", source: { type: "http", name: "api" }, type: "health_check", state: "unhealthy", timestamp: "2026-11-02T10:00:00.000Z", title: "api is down", message: "api returned 503", facts: {}, data: { name: "api" } }
    }
  });

  // Exercises everything a task touches: the envelope, a
  // read-only mount, env, the network policy and a host tool.
  const command = [
    "set -u",
    // agentOS 0.4.6 drops node's stdout when it is redirected
    // (`>`, `|`, `$( )`), so node writes its files itself.
    "node -e \"const fs=require('fs'); fs.writeFileSync('/tmp/name', JSON.parse(fs.readFileSync('/inbox/envelope.json','utf8')).payload.observation.payload.data.name)\"",
    "name=$(cat /tmp/name)",
    "errors=$(grep -c ERROR /mnt/logs/app.log)",
    "if echo x > /mnt/logs/new.txt 2>/dev/null; then ro=no; else ro=yes; fi",
    "node -e \"const w=v=>require('fs').writeFileSync('/tmp/net', v); fetch('https://github.com').then(()=>w('open'), ()=>w('blocked'))\"",
    "net=$(cat /tmp/net)",
    "agentos-tools send-report --title \"$name: $errors errors\" --count \"$errors\" --markdown \"$(grep ERROR /mnt/logs/app.log | head -1)\"",
    "echo \"{\\\"service\\\":\\\"$name\\\",\\\"errors\\\":$errors,\\\"readOnly\\\":\\\"$ro\\\",\\\"network\\\":\\\"$net\\\",\\\"greeting\\\":\\\"$GREETING\\\"}\" > /outbox/result.json",
    "echo service={{observation.data.name}}"
  ].join("\n");

  const ctx = createDestinationContext({
    config: {
      command,
      env: { GREETING: "hello" },
      mounts: [{ path: "/mnt/logs", hostPath: logsDir }],
      tools: {
        sendReport: {
          description: "Send a short report to the operator",
          input: { title: "string", markdown: "string", count: "integer" },
          required: true,
          maxCalls: 1,
          // agentOS 0.4.6 keeps the host function's timeout timer
          // alive after the call returns, which holds the process
          // open for that long; keep it short in the test.
          timeoutMs: 15_000,
          run: async args => {
            reports.push(args);
            return { sent: true };
          }
        }
      },
      onResult: run => results.push(run)
    },
    stateStore: store,
    plugin: "@brainstem/agentos-runner",
    destination: "default",
    id: "log-triage",
    idempotencyKey: output.payload.idempotencyKey,
    logger
  });

  try {
    await agentosRunnerPlugin.destinations.default.handle(ctx, output);
  }
  catch (error) {
    // The VM's output is the only way to see why a run failed in CI.
    error.message += `\nplugin logs:\n${JSON.stringify(logs, null, 2)}`;
    throw error;
  }

  assert.deepEqual(reports, [{ title: "api: 2 errors", markdown: "10:01 ERROR db timeout", count: 2 }]);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].result, {
    service: "api",
    errors: 2,
    readOnly: "yes",
    network: "blocked",
    greeting: "hello"
  });
  // The quoted template value reaches the shell as one word.
  assert.match(results[0].stdout, /service=api\n?$/);
  assert.equal(existsSync(join(logsDir, "new.txt")), false, "the read-only mount was not written");
});

test("tool command names match agentOS", { skip: missingPackage }, async () => {
  const { hostFunctionCommandName } = await import("@rivet-dev/agentos-core");

  for (const name of ["sendReport", "send-report", "send_report", "postToMatrix", "a1b2"]) {
    assert.equal(toolCommandName(name), hostFunctionCommandName(name), name);
  }
});
