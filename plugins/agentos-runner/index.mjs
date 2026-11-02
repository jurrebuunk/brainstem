import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { defineDestinationPlugin } from "../../src/sdk/index.mjs";
import { normalizeConfig } from "./config.mjs";
import { loadAgentOsAdapter } from "./adapter.mjs";
import { buildAgentPrompt, renderCommand } from "./prompt.mjs";
import { createToolRuntime } from "./tools.mjs";

export { defineAgentOsTask } from "./config.mjs";

/*
 * One generic agentOS runner. Each destination entry that uses
 * it is one task: Brainstem's own filters decide which decisions
 * reach it, and the entry's config decides what runs (a prompt
 * for an agent, or a command), what the VM may touch, and which
 * host tools it gets.
 */
const RUN_KEY_PREFIX = "run:";

export default defineDestinationPlugin({
  apiVersion: "brainstem.destination/v2",
  name: "@brainstem/agentos-runner",

  destinations: {
    default: {
      async handle(ctx, output) {
        const config = normalizeConfig(ctx.config);
        const event = output.payload;
        const observation = event.observation.payload;
        const decision = event.decision.payload;
        const startedAt = Date.now();

        const skip = await skipReason(config, ctx, event);

        if (skip) {
          ctx.logger.info?.(
            "agentos runner skipped",
            {
              observationId: observation.id,
              decision: decision.decision,
              reason: skip
            }
          );
          return;
        }

        ctx.logger.info?.(
          "agentos runner started",
          {
            observationId: observation.id,
            decision: decision.decision,
            route: decision.route,
            mode: config.mode,
            tools: Object.keys(config.tools),
            attempt: ctx.attempt
          }
        );

        const tools = createToolRuntime({
          tools: config.tools,
          ctx,
          event,
          logMaxChars: config.outputLogMaxChars
        });

        const signal = AbortSignal.any(
          [ctx.signal, AbortSignal.timeout(config.timeoutMs)].filter(Boolean)
        );

        const adapter = config.adapter ?? await loadAgentOsAdapter();
        const outboxDir = await mkdtemp(join(tmpdir(), "brainstem-agentos-"));
        let vm;

        try {
          vm = await bootVm(adapter, config, tools, signal, outboxDir);
          await vm.writeFile(config.inboxPath, JSON.stringify(output, null, 2));

          const run = config.mode === "command"
            ? await runCommand(vm, config, event, signal, ctx)
            : await runAgent(vm, config, event, signal, ctx);

          const result = parseResult(
            await readFile(join(outboxDir, posix.basename(config.outboxPath)), "utf8")
              .catch(error => error.code === "ENOENT" ? null : Promise.reject(error))
          );

          await checkRequiredTools(config, tools, ctx, event);

          await config.onResult?.(
            {
              result,
              ...run,
              toolCalls: tools.calls,
              event
            },
            ctx
          );

          await markRun(config, ctx, event);
          await tools.clear();

          ctx.logger.info?.(
            "agentos runner completed",
            {
              observationId: observation.id,
              decision: decision.decision,
              durationMs: Date.now() - startedAt,
              exitCode: run.exitCode ?? null,
              result: result === null ? null : truncate(JSON.stringify(result), config.outputLogMaxChars),
              toolCalls: tools.calls
            }
          );
        }
        finally {
          await vm?.dispose().catch(error =>
            ctx.logger.warn?.("agentos vm dispose failed", { error: error.message })
          );
          await rm(outboxDir, { recursive: true, force: true });
        }
      }
    }
  }
});

async function skipReason(config, ctx, event) {
  const decision = event.decision.payload;

  if (config.minRouteConfidence !== null) {
    const confidence = decision.confidence?.route ?? null;

    if (confidence === null || confidence < config.minRouteConfidence) {
      return `route confidence ${confidence ?? "unknown"} is below ${config.minRouteConfidence}`;
    }
  }

  if (config.runOnce === "revision") {
    const previous = await ctx.state.get(runKey(event));

    if (previous && previous.idempotencyKey !== ctx.idempotencyKey) {
      return `revision ${decision.revision ?? 0} was already handled`;
    }
  }

  return null;
}

/*
 * A broken agentOS install (for example a sidecar binary the OS
 * cannot start) makes VM creation hang instead of failing, so
 * boot gets its own deadline.
 *
 * The outbox is a fresh host directory mounted writable: files
 * agentOS creates itself belong to the VM's default user, which
 * the guest (running as Brainstem's own uid) may not be.
 */
async function bootVm(adapter, config, tools, signal, outboxDir) {
  let timer;

  const boot = adapter.createVm({
    mounts: [
      ...config.mounts,
      { path: posix.dirname(config.outboxPath), hostPath: outboxDir, readOnly: false }
    ],
    allowHosts: config.allowHosts,
    env: config.env,
    software: config.software,
    toolCollection: config.toolCollection,
    tools: Object.fromEntries(
      Object.values(config.tools).map(tool => [
        tool.name,
        { ...tool, execute: input => tools.call(tool.name, input) }
      ])
    )
  });

  try {
    return await Promise.race([
      boot,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`agentos-runner: VM did not boot within ${config.bootTimeoutMs}ms`)),
          config.bootTimeoutMs
        );
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
    ]);
  }
  catch (error) {
    // If the VM shows up after we gave up, don't leak it.
    boot.then(vm => vm.dispose()).catch(() => {});
    throw error;
  }
  finally {
    clearTimeout(timer);
  }
}

async function runCommand(vm, config, event, signal, ctx) {
  const command = renderCommand(config.command, event);
  const result = await vm.exec(command, {
    timeoutMs: config.timeoutMs,
    signal,
    env: config.env
  });

  ctx.logger.info?.(
    "agentos command output",
    {
      exitCode: result.exitCode,
      stdout: truncate(result.stdout, config.outputLogMaxChars),
      stderr: truncate(result.stderr, config.outputLogMaxChars),
      truncated:
        result.stdoutTruncated ||
        result.stderrTruncated ||
        result.stdout.length > config.outputLogMaxChars ||
        result.stderr.length > config.outputLogMaxChars
    }
  );

  if (config.failOnExitCode && result.exitCode !== 0) {
    throw new Error(
      `agentos-runner: command exited with code ${result.exitCode}${result.stderr ? `: ${truncate(result.stderr.trim(), 500)}` : ""}`
    );
  }

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

async function runAgent(vm, config, event, signal, ctx) {
  const prompt = buildAgentPrompt(config, event);

  return await vm.runSession({
    agent: config.agent,
    prompt,
    env: config.env,
    timeoutMs: config.timeoutMs,
    signal,
    onEvent: data => ctx.logger.debug?.("agentos agent event", { data })
  }) ?? {};
}

async function checkRequiredTools(config, tools, ctx, event) {
  const missing = tools.missingRequired();

  if (missing.length === 0) return;

  ctx.logger.warn?.(
    "agentos required tools not called",
    { missing }
  );

  if (config.onMissingRequired) {
    await config.onMissingRequired({ missing, event }, ctx);
    return;
  }

  // Fail the delivery so Brainstem retries it; recorded tool
  // calls are replayed, not repeated.
  throw new Error(
    `agentos-runner: required tool${missing.length === 1 ? "" : "s"} not called: ${missing.join(", ")}`
  );
}

async function markRun(config, ctx, event) {
  if (config.runOnce !== "revision") return;

  await ctx.state.set(runKey(event), {
    idempotencyKey: ctx.idempotencyKey,
    completedAt: new Date().toISOString()
  });
}

function runKey(event) {
  const observation = event.observation.payload;
  const decision = event.decision.payload;

  return `${RUN_KEY_PREFIX}${observation.id}:r${decision.revision ?? 0}`;
}

function parseResult(text) {
  if (text === null || !text.trim()) return null;

  try {
    return JSON.parse(text);
  }
  catch {
    return { raw: text };
  }
}

function truncate(value, max) {
  if (typeof value !== "string") return value;

  return value.length > max
    ? `${value.slice(0, max)}…`
    : value;
}
