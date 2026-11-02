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

const MODEL = {
  baseUrl: "http://model.test/v1",
  name: "gpt-5.6-luna",
  apiKey: "test-key"
};

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
  assert.throws(() => normalizeConfig({ prompt: "a" }), /model is required/);
  assert.throws(() => normalizeConfig({ prompt: "a", model: { ...MODEL, baseUrl: "model.test" } }), /model\.baseUrl/);
  assert.throws(() => normalizeConfig({ prompt: "a", model: { baseUrl: MODEL.baseUrl, name: "m" } }), /apiKeyEnv/);
  assert.throws(() => normalizeConfig({ prompt: "a", model: MODEL, limits: { maxTokens: 5 } }), /limits\.maxTokens is not a known limit/);
  assert.equal(normalizeConfig({ prompt: "a", model: MODEL, limits: { maxTurns: 3 } }).limits.maxTurns, 3);
  assert.throws(() => normalizeConfig({ prompt: "a", command: "b" }), /exactly one of 'prompt'/);
  assert.equal(normalizeConfig({ prompt: "Summarize", model: MODEL }).mode, "agent");
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

test("agent prompts carry budgets and a compact observation summary", () => {
  const config = normalizeConfig({
    prompt: "Summarize issue {{observation.data.title}}.",
    model: MODEL,
    tools: { sendReport: { ...reportTool([]), required: true, maxCalls: 1 } }
  });

  const { system, prompt } = buildAgentPrompt(
    config,
    outputEnvelope({ data: { title: "Crash on start", body: "x".repeat(50_000) } }).payload
  );

  assert.match(system, /at most 4 commands and 6 turns/);
  assert.match(system, /\/inbox\/envelope\.json/);
  assert.match(system, /You must call sendReport/);
  assert.match(prompt, /^Summarize issue Crash on start\./);
  assert.match(prompt, /- id: github:repo#1/);
  assert.ok(prompt.length < 1000, "observation data is not inlined");
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

/*
 * A stand-in for the chat completions endpoint: replies are
 * served in order, request bodies are recorded.
 */
async function withModel(replies, fn) {
  const requests = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), headers: options.headers, body });
    const reply = typeof replies === "function" ? replies(requests.length, body) : replies[requests.length - 1];

    if (!reply) throw new Error(`unexpected model request ${requests.length}`);

    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: null, ...reply } }],
      usage: { prompt_tokens: 100, completion_tokens: 10 }
    }), { status: 200 });
  };

  try {
    await fn(requests);
  }
  finally {
    globalThis.fetch = original;
  }

  return requests;
}

const toolCall = (id, name, args) => ({
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
});

function agentConfig(adapter, { limits, ...overrides } = {}) {
  return {
    adapter,
    prompt: "Find errors in /mnt/logs and report them.",
    model: MODEL,
    ...overrides,
    limits: { minRequestIntervalMs: 0, ...limits }
  };
}

test("agent runs commands in the VM and calls host tools", async () => {
  const sent = [];
  const results = [];
  const adapter = fakeAdapter(async (vm, command) => ({ exitCode: 0, stdout: `ran: ${command}` }));
  const output = outputEnvelope();
  const { ctx, logs } = context(agentConfig(adapter, {
    tools: { sendReport: reportTool(sent, { required: true }) },
    onResult: run => results.push(run)
  }), { output });

  const requests = await withModel([
    toolCall("c1", "run_command", { command: "grep -c ERROR /mnt/logs/app.log" }),
    toolCall("c2", "sendReport", { title: "2 errors", markdown: "db timeouts" }),
    { content: "Reported 2 errors." }
  ], () => handle(ctx, output));

  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, "http://model.test/v1/chat/completions");
  assert.equal(requests[0].headers.authorization, "Bearer test-key");
  assert.equal(requests[0].body.model, "gpt-5.6-luna");
  assert.equal(requests[0].body.max_completion_tokens, 600);
  assert.deepEqual(requests[0].body.tools.map(tool => tool.function.name), ["run_command", "sendReport"]);

  // The command's output went back to the model as the tool result.
  const toolMessage = requests[1].body.messages.at(-1);
  assert.equal(toolMessage.role, "tool");
  assert.equal(toolMessage.tool_call_id, "c1");
  assert.match(toolMessage.content, /ran: grep -c ERROR/);

  assert.deepEqual(sent.map(call => call.args), [{ title: "2 errors", markdown: "db timeouts" }]);
  assert.equal(results[0].text, "Reported 2 errors.");
  assert.deepEqual(results[0].usage, { requests: 3, promptTokens: 300, completionTokens: 30 });
  assert.ok(logs.some(log => log.message === "agentos agent output"));
});

test("agent budgets: command limit, duplicate calls and truncated output", async () => {
  const adapter = fakeAdapter(async () => ({ exitCode: 0, stdout: "y".repeat(5000) }));
  const output = outputEnvelope();
  const { ctx } = context(agentConfig(adapter, { limits: { maxCommands: 2, maxToolOutputChars: 100 } }), { output });

  const requests = await withModel([
    toolCall("c1", "run_command", { command: "cat big.log" }),
    toolCall("c2", "run_command", { command: "cat big.log" }),
    toolCall("c3", "run_command", { command: "tail big.log" }),
    toolCall("c4", "run_command", { command: "head big.log" }),
    { content: "done" }
  ], () => handle(ctx, output));

  const toolResults = requests.slice(1).map(request => JSON.parse(request.body.messages.at(-1).content));

  assert.ok(toolResults[0].stdout.length < 200, "output is cut to maxToolOutputChars");
  assert.match(toolResults[0].stdout, /truncated 4900 chars/);
  assert.match(toolResults[1].error, /duplicate call/);
  assert.equal(toolResults[2].exitCode, 0);
  assert.match(toolResults[3].error, /command limit of 2 reached/);
  assert.equal(adapter.vms[0].commands.length, 2, "only two commands reached the VM");
});

test("agent stops at maxTurns", async () => {
  const output = outputEnvelope();
  const { ctx } = context(agentConfig(fakeAdapter(), { limits: { maxTurns: 3 } }), { output });
  let n = 0;

  const requests = await withModel(
    () => toolCall(`c${++n}`, "run_command", { command: `echo ${n}` }),
    () => assert.rejects(() => handle(ctx, output), /no final answer within 3 turns/)
  );

  assert.equal(requests.length, 3);
});

test("agent stops before the conversation outgrows maxContextChars", async () => {
  const adapter = fakeAdapter(async () => ({ exitCode: 0, stdout: "z".repeat(3000) }));
  const output = outputEnvelope();
  const { ctx } = context(agentConfig(adapter, { limits: { maxContextChars: 2500, maxToolOutputChars: 2000 } }), { output });

  const requests = await withModel([
    toolCall("c1", "run_command", { command: "cat a" })
  ], () => assert.rejects(() => handle(ctx, output), /conversation reached \d+ characters \(limit 2500\)/));

  assert.equal(requests.length, 1, "the oversized second request is never sent");
});

test("agent reminds the model once about a required tool", async () => {
  const sent = [];
  const output = outputEnvelope();
  const { ctx } = context(agentConfig(fakeAdapter(), {
    tools: { sendReport: reportTool(sent, { required: true }) }
  }), { output });

  const requests = await withModel([
    { content: "All good." },
    toolCall("c1", "sendReport", { title: "t", markdown: "m" }),
    { content: "Sent." }
  ], () => handle(ctx, output));

  assert.match(requests[1].body.messages.at(-1).content, /you must call: sendReport/);
  assert.equal(sent.length, 1);
});

test("a retried delivery does not talk to the model again", async () => {
  const store = new MemoryPluginStateStore();
  const output = outputEnvelope();
  const config = agentConfig(fakeAdapter());

  await withModel(
    () => { throw new Error("rate limited"); },
    () => assert.rejects(() => handle(context(config, { store, output }).ctx, output), /rate limited/)
  );

  const requests = await withModel([], async () => {
    const error = await handle(context(config, { store, output, attempt: 2 }).ctx, output).catch(e => e);
    assert.match(error.message, /already used 1 model attempt/);
    assert.equal(error.permanent, true, "the delivery is dead-lettered instead of retried");
  });

  assert.equal(requests.length, 0);
});

test("agent fails permanently without an API key and sends nothing", async () => {
  const output = outputEnvelope();
  const { ctx } = context(agentConfig(fakeAdapter(), {
    model: { baseUrl: MODEL.baseUrl, name: MODEL.name, apiKeyEnv: "BRAINSTEM_TEST_NO_SUCH_KEY" }
  }), { output });

  const requests = await withModel([], async () => {
    const error = await handle(ctx, output).catch(e => e);
    assert.match(error.message, /set BRAINSTEM_TEST_NO_SUCH_KEY/);
    assert.equal(error.permanent, true);
  });

  assert.equal(requests.length, 0);
});

test("agent prompts are cut to maxPromptChars", async () => {
  const output = outputEnvelope({ data: { title: "t".repeat(10_000) } });
  const { ctx } = context(agentConfig(fakeAdapter(), {
    prompt: "Summarize {{observation.data.title}}",
    limits: { maxPromptChars: 500 }
  }), { output });

  const requests = await withModel([{ content: "ok" }], () => handle(ctx, output));

  assert.ok(requests[0].body.messages[1].content.length < 600);
});
