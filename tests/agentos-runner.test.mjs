import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import agentosRunnerPlugin, { defineAgentOsTask } from "../plugins/agentos-runner/index.mjs";
import { normalizeConfig } from "../plugins/agentos-runner/config.mjs";
import {
  buildAgentPrompt,
  renderCommand,
  renderTemplate,
  toolCommandName
} from "../plugins/agentos-runner/prompt.mjs";
import { MemoryPluginStateStore } from "../src/runtime/plugin-state.mjs";
import { createDestinationContext, createOutputEnvelope } from "../src/sdk/index.mjs";

const handle = (ctx, output) =>
  agentosRunnerPlugin.destinations.default.handle(ctx, output);

/*
 * A stand-in for the agentOS adapter. `script(vm, command)` plays
 * the part of whatever runs inside the VM: it can call the host
 * tools and write files, and returns the command's exit result.
 */
function fakeAdapter(script = async () => ({ exitCode: 0 })) {
  const adapter = {
    vms: [],
    async createVm(options) {
      const files = new Map();
      const vm = {
        options,
        files,
        commands: [],
        disposed: false,
        async writeFile(path, text) { files.set(path, text); },
        // A write from inside the VM: lands in the host directory
        // when the path is under a mount.
        write(path, text) {
          const mount = options.mounts.find(m => path.startsWith(`${m.path}/`));
          if (!mount) throw new Error(`no mount for ${path}`);
          if (mount.readOnly) throw new Error(`read-only: ${path}`);
          writeFileSync(join(mount.hostPath, path.slice(mount.path.length + 1)), text);
        },
        async exec(command, execOptions) {
          vm.commands.push({ command, execOptions });
          const result = await script(vm, command);
          return { stdout: "", stderr: "", ...result };
        },
        async runSession(session) {
          vm.session = session;
          return await script(vm, session.prompt);
        },
        async dispose() { vm.disposed = true; },
        callTool(name, args) {
          return options.tools[name].execute(args);
        }
      };

      adapter.vms.push(vm);
      return vm;
    }
  };

  return adapter;
}

function outputEnvelope({
  id = "github:repo#1",
  revision = 0,
  emission = "e1",
  decision = "queue",
  route = "coding",
  routeConfidence = 0.9,
  data = { title: "Crash on start" }
} = {}) {
  return createOutputEnvelope({
    idempotencyKey: `issue-summary:${id}:r${revision}:${emission}`,
    decision: {
      version: "1",
      kind: "decision",
      payload: {
        observationId: id,
        revision,
        decision,
        route,
        confidence: { route: routeConfidence },
        reason: "test"
      }
    },
    observation: {
      version: "1",
      kind: "observation",
      payload: {
        id,
        source: "github",
        type: "issue",
        observedAt: "2026-11-02T10:00:00.000Z",
        summary: data.title,
        facts: {},
        data
      }
    },
    destination: { id: "issue-summary" }
  });
}

function context(config, { store = new MemoryPluginStateStore(), output, attempt = 1, logs = [] } = {}) {
  const ctx = createDestinationContext({
    config,
    stateStore: store,
    plugin: "@brainstem/agentos-runner",
    destination: "default",
    id: "issue-summary",
    idempotencyKey: output.payload.idempotencyKey,
    attempt,
    logger: {
      debug(message, data) { logs.push({ level: "debug", message, data }); },
      info(message, data) { logs.push({ level: "info", message, data }); },
      warn(message, data) { logs.push({ level: "warn", message, data }); },
      error(message, data) { logs.push({ level: "error", message, data }); }
    }
  });

  return { ctx, store, logs };
}

function reportTool(sent, overrides = {}) {
  return {
    description: "Send a report to the operator",
    input: {
      title: { type: "string", maxLength: 80 },
      markdown: "string",
      severity: { type: "string", enum: ["low", "high"], optional: true }
    },
    async run(args, toolCtx) {
      sent.push({ args, toolCtx });
      return { sent: true, n: sent.length };
    },
    ...overrides
  };
}

test("agentos-runner config requires exactly one of prompt or command", () => {
  assert.throws(() => normalizeConfig({}), /exactly one of 'prompt'/);
  assert.throws(() => normalizeConfig({ prompt: "a", command: "b" }), /exactly one of 'prompt'/);
  assert.equal(normalizeConfig({ prompt: "Summarize" }).mode, "agent");
  assert.equal(normalizeConfig({ command: "true" }).mode, "command");
});

test("agentos-runner config validates tools, mounts and limits", () => {
  const run = () => {};

  assert.throws(() => normalizeConfig({ command: "x", tools: { "Bad Name": { description: "d", run } } }), /tools\.Bad Name name/);
  assert.throws(() => normalizeConfig({ command: "x", tools: { send: { description: "d" } } }), /tools\.send\.run/);
  assert.throws(() => normalizeConfig({ command: "x", tools: { send: { run } } }), /tools\.send\.description/);
  assert.throws(() => normalizeConfig({ command: "x", tools: { send: { description: "d", run, input: { a: "date" } } } }), /input\.a\.type/);
  assert.throws(() => normalizeConfig({ command: "x", tools: { send: { description: "d", run, input: { a: { type: "string", enum: [1] } } } } }), /input\.a\.enum/);
  assert.throws(() => normalizeConfig({ command: "x", allowHosts: ["https://api.example.com"] }), /allowHosts/);
  assert.throws(() => normalizeConfig({ command: "x", mounts: [{ path: "logs", hostPath: "/var/log" }] }), /mounts\[0\]\.path/);
  assert.throws(() => normalizeConfig({ command: "x", timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => normalizeConfig({ command: "x", runOnce: "always" }), /runOnce/);
  assert.throws(() => normalizeConfig({ command: "x", minRouteConfidence: 2 }), /minRouteConfidence/);
  assert.throws(() => normalizeConfig({ command: "x", outboxPath: "/result.json" }), /outboxPath/);
  assert.throws(() => normalizeConfig({ command: "x", mounts: [{ path: "/outbox", hostPath: "/tmp" }] }), /outbox directory/);

  const config = normalizeConfig({
    command: "x",
    mounts: [{ path: "/mnt/logs", hostPath: "relative/logs" }],
    tools: { sendReport: { description: "Send", run, input: { title: "string", note: "string?" } } }
  });

  assert.equal(config.mounts[0].readOnly, true, "mounts are read-only unless asked otherwise");
  assert.ok(config.mounts[0].hostPath.startsWith("/"), "host paths are resolved");
  assert.deepEqual(
    [config.tools.sendReport.input.title.optional, config.tools.sendReport.input.note.optional],
    [false, true]
  );
  assert.equal(config.tools.sendReport.maxCalls, 10);
  assert.equal(config.runOnce, "revision");
});

test("defineAgentOsTask validates where the task is declared", () => {
  assert.throws(() => defineAgentOsTask({ prompt: "" }), /prompt must be a non-empty/);

  const task = { command: "true" };
  assert.equal(defineAgentOsTask(task), task);
});

test("templates resolve envelope paths and quote command values", () => {
  const event = outputEnvelope({ data: { title: "it's broken; rm -rf / #", labels: ["bug"] } }).payload;

  assert.equal(
    renderTemplate("{{observation.data.title}} / {{decision.route}} / {{observation.data.labels}} / {{missing.path}}", event),
    "it's broken; rm -rf / # / coding / [\"bug\"] / "
  );

  assert.equal(
    renderCommand("echo {{observation.data.title}}", event),
    "echo 'it'\\''s broken; rm -rf / #'"
  );

  assert.equal(renderTemplate(e => `id=${e.observation.payload.id}`, event), "id=github:repo#1");
  assert.throws(() => renderTemplate(() => "", event), /non-empty string/);
});

test("agent prompts add the inbox, outbox and tool instructions", () => {
  const config = normalizeConfig({
    prompt: "Summarize issue {{observation.data.title}}.",
    tools: { sendReport: { ...reportTool([]), required: true, maxCalls: 1 } }
  });

  const prompt = buildAgentPrompt(config, outputEnvelope().payload);

  assert.match(prompt, /^Summarize issue Crash on start\./);
  assert.match(prompt, /\/inbox\/envelope\.json/);
  assert.match(prompt, /\/outbox\/result\.json/);
  assert.match(prompt, /agentos-tools <tool>/);
  assert.match(prompt, /send-report: Send a report to the operator \(required: call it before you finish, at most 1 call\)/);
  assert.equal(toolCommandName("send_report"), "send_report");
});

test("agentos-runner runs a command task end to end", async () => {
  const sent = [];
  const results = [];
  const adapter = fakeAdapter(async vm => {
    const envelope = JSON.parse(vm.files.get("/inbox/envelope.json"));
    await vm.callTool("sendReport", { title: envelope.payload.observation.payload.summary, markdown: "body" });
    vm.write("/outbox/result.json", JSON.stringify({ summary: "ok" }));
    return { exitCode: 0, stdout: "done" };
  });
  const output = outputEnvelope();
  const { ctx, logs } = context({
    adapter,
    command: "summarize {{observation.data.title}}",
    allowHosts: ["api.example.com"],
    mounts: [{ path: "/mnt/logs", hostPath: "/var/log/app" }],
    env: { MODE: "test" },
    tools: { sendReport: reportTool(sent, { required: true }) },
    onResult: (run, onResultCtx) => results.push({ run, onResultCtx })
  }, { output });

  await handle(ctx, output);

  const [vm] = adapter.vms;
  assert.deepEqual(vm.options.allowHosts, ["api.example.com"]);
  assert.deepEqual(vm.options.mounts[0], { path: "/mnt/logs", hostPath: "/var/log/app", readOnly: true });
  assert.equal(vm.options.mounts[1].path, "/outbox");
  assert.equal(vm.options.mounts[1].readOnly, false, "the outbox is a writable host directory");
  assert.equal(existsSync(vm.options.mounts[1].hostPath), false, "the outbox directory is removed after the run");
  assert.deepEqual(Object.keys(vm.options.tools), ["sendReport"]);
  assert.equal(vm.commands[0].command, "summarize 'Crash on start'");
  assert.deepEqual(vm.commands[0].execOptions.env, { MODE: "test" });
  assert.equal(vm.disposed, true);

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].args, { title: "Crash on start", markdown: "body" });
  assert.equal(sent[0].toolCtx.idempotencyKey, `${output.payload.idempotencyKey}:sendReport:1`);

  assert.equal(results.length, 1);
  assert.deepEqual(results[0].run.result, { summary: "ok" });
  assert.equal(results[0].run.exitCode, 0);
  assert.equal(results[0].run.toolCalls[0].ok, true);
  assert.equal(results[0].onResultCtx, ctx);

  assert.ok(logs.some(log => log.message === "agentos command output" && log.data.stdout === "done"));
  assert.ok(logs.some(log => log.message === "agentos runner completed"));
});

test("agentos-runner fails the delivery on a non-zero exit and still disposes the VM", async () => {
  const adapter = fakeAdapter(async () => ({ exitCode: 2, stderr: "grep: no such file" }));
  const output = outputEnvelope();
  const { ctx } = context({ adapter, command: "grep x /nope" }, { output });

  await assert.rejects(() => handle(ctx, output), /exited with code 2: grep: no such file/);
  assert.equal(adapter.vms[0].disposed, true);

  const lenient = fakeAdapter(async () => ({ exitCode: 1 }));
  await handle(context({ adapter: lenient, command: "false", failOnExitCode: false }, { output }).ctx, output);
});

test("agentos-runner handles each observation revision once by default", async () => {
  const adapter = fakeAdapter();
  const store = new MemoryPluginStateStore();
  const config = { adapter, command: "true" };

  const first = outputEnvelope({ emission: "e1" });
  await handle(context(config, { store, output: first }).ctx, first);

  // A reminder re-emits the same revision with a new emission id.
  const reminder = outputEnvelope({ emission: "e2" });
  const { ctx, logs } = context(config, { store, output: reminder });
  await handle(ctx, reminder);

  assert.equal(adapter.vms.length, 1, "the re-emission does not start a second run");
  assert.ok(logs.some(log => log.message === "agentos runner skipped" && /already handled/.test(log.data.reason)));

  const changed = outputEnvelope({ revision: 1, emission: "e3" });
  await handle(context(config, { store, output: changed }).ctx, changed);
  assert.equal(adapter.vms.length, 2, "a new revision runs again");

  const everyEmission = { ...config, runOnce: "emission" };
  await handle(context(everyEmission, { store, output: reminder }).ctx, reminder);
  assert.equal(adapter.vms.length, 3, "runOnce: 'emission' runs for every emission");
});

test("agentos-runner skips decisions below minRouteConfidence", async () => {
  const adapter = fakeAdapter();
  const output = outputEnvelope({ routeConfidence: 0.4 });
  const { ctx, logs } = context({ adapter, command: "true", minRouteConfidence: 0.6 }, { output });

  await handle(ctx, output);

  assert.equal(adapter.vms.length, 0);
  assert.ok(logs.some(log => log.message === "agentos runner skipped" && /0\.4 is below 0\.6/.test(log.data.reason)));
});

test("agentos-runner tools reject bad arguments and enforce maxCalls", async () => {
  const sent = [];
  const errors = [];
  const adapter = fakeAdapter(async vm => {
    for (const args of [
      { title: "x".repeat(81), markdown: "m" },
      { title: "t" },
      { title: "t", markdown: "m", extra: true },
      { title: "t", markdown: "m", severity: "urgent" },
      { title: "t", markdown: 3 },
      { title: "ok", markdown: "m", severity: "high" },
      { title: "again", markdown: "m" }
    ]) {
      await vm.callTool("sendReport", args).catch(error => errors.push(error.message));
    }

    return { exitCode: 0 };
  });
  const output = outputEnvelope();
  const { ctx } = context({
    adapter,
    command: "true",
    tools: { sendReport: reportTool(sent, { maxCalls: 6 }) }
  }, { output });

  await handle(ctx, output);

  assert.deepEqual(errors, [
    "tool 'sendReport' argument 'title' exceeds 80 characters",
    "tool 'sendReport' is missing argument 'markdown'",
    "tool 'sendReport' has no argument 'extra'",
    "tool 'sendReport' argument 'severity' must be one of low, high",
    "tool 'sendReport' argument 'markdown' must be string",
    "tool 'sendReport' reached its limit of 6 calls"
  ]);
  assert.deepEqual(sent.map(call => call.args.title), ["ok"]);
});

test("agentos-runner fails when a required tool was never called", async () => {
  const output = outputEnvelope();
  const tools = { sendReport: reportTool([], { required: true }) };

  await assert.rejects(
    () => handle(context({ adapter: fakeAdapter(), command: "true", tools }, { output }).ctx, output),
    /required tool not called: sendReport/
  );

  const missing = [];
  await handle(
    context({
      adapter: fakeAdapter(),
      command: "true",
      tools,
      onMissingRequired: info => missing.push(info.missing)
    }, { output }).ctx,
    output
  );

  assert.deepEqual(missing, [["sendReport"]], "onMissingRequired replaces the failure");
});

test("a retried delivery replays tool calls instead of repeating them", async () => {
  const sent = [];
  let attempt = 0;
  const adapter = fakeAdapter(async vm => {
    attempt += 1;
    const reply = await vm.callTool("sendReport", { title: "Report", markdown: "m" });
    vm.write("/outbox/result.json", JSON.stringify(reply));
    // The first run fails after its tool call already happened.
    return { exitCode: attempt === 1 ? 1 : 0 };
  });
  const store = new MemoryPluginStateStore();
  const output = outputEnvelope();
  const config = { adapter, command: "report", tools: { sendReport: reportTool(sent) } };
  const results = [];

  await assert.rejects(() => handle(context(config, { store, output }).ctx, output), /exited with code 1/);

  const { ctx, logs } = context(
    { ...config, onResult: run => results.push(run) },
    { store, output, attempt: 2 }
  );
  await handle(ctx, output);

  assert.equal(sent.length, 1, "the tool ran once across both attempts");
  assert.deepEqual(results[0].result, { sent: true, n: 1 }, "the replay returns the recorded result");
  assert.equal(results[0].toolCalls[0].replayed, true);
  assert.ok(logs.some(log => log.message === "agentos tool call replayed"));
  assert.equal(
    await ctx.state.get(`tool:${output.payload.idempotencyKey}:sendReport:1`),
    undefined,
    "recorded calls are cleared after success"
  );
});

test("agentos-runner gives up on a VM that never boots", async () => {
  let resolveLate;
  const late = { disposed: false, async dispose() { late.disposed = true; } };
  const adapter = {
    createVm: () => new Promise(resolve => { resolveLate = resolve; })
  };
  const output = outputEnvelope();
  const { ctx } = context({ adapter, command: "true", bootTimeoutMs: 20 }, { output });

  await assert.rejects(() => handle(ctx, output), /did not boot within 20ms/);

  resolveLate(late);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(late.disposed, true, "a VM that boots after the deadline is disposed");
});

test("agentos-runner passes the built prompt to the agent session", async () => {
  const adapter = fakeAdapter(async () => ({}));
  const output = outputEnvelope();
  const { ctx } = context({
    adapter,
    prompt: "Summarize {{observation.data.title}}",
    agent: "pi",
    env: { MODEL_KEY: "k" }
  }, { output });

  await handle(ctx, output);

  const { session } = adapter.vms[0];
  assert.equal(session.agent, "pi");
  assert.match(session.prompt, /^Summarize Crash on start/);
  assert.deepEqual(session.env, { MODEL_KEY: "k" });
});
