import { spawn } from "node:child_process";
import { defineDestinationPlugin } from "../../src/sdk/index.mjs";

export default defineDestinationPlugin({
  apiVersion: "brainstem.destination/v1",
  name: "@brainstem/opencode-runner",

  destinations: {
    default: {
      async handle(ctx, event) {
        const config = normalizeConfig(ctx.config);
        const prompt = buildPrompt(config, event);
        const args = buildArgs(config, prompt);
        const startedAt = Date.now();

        ctx.logger.info?.(
          "opencode runner started",
          {
            observationId: event.observation.payload.id,
            decision: event.decision.payload.decision,
            route: event.decision.payload.route,
            executable: config.executable,
            args: redactArgs(args)
          }
        );

        const result = await runCommand({
          executable: config.executable,
          args,
          cwd: config.cwd,
          env: config.env,
          timeoutMs: config.timeoutMs,
          signal: ctx.signal,
          logger: ctx.logger
        });

        const durationMs = Date.now() - startedAt;

        if (result.code !== 0) {
          const error = new Error(
            `opencode exited with code ${result.code}`
          );
          error.code = result.code;
          error.stderr = result.stderrTail.join("\n");

          ctx.logger.error?.(
            "opencode runner failed",
            {
              observationId: event.observation.payload.id,
              decision: event.decision.payload.decision,
              code: result.code,
              signal: result.signal,
              durationMs,
              stderr: result.stderrTail
            }
          );

          throw error;
        }

        ctx.logger.info?.(
          "opencode runner completed",
          {
            observationId: event.observation.payload.id,
            decision: event.decision.payload.decision,
            durationMs,
            events: result.eventCount,
            stdoutLines: result.stdoutLines,
            stderrLines: result.stderrLines
          }
        );
      }
    }
  }
});

function normalizeConfig(config) {
  return {
    executable: config.executable ?? "opencode",
    baseArgs: array(config.baseArgs),
    attach: config.attach ?? null,
    model: config.model ?? null,
    agent: config.agent ?? null,
    dir: config.dir ?? null,
    title: config.title ?? null,
    username: config.username ?? null,
    password: resolvePassword(config),
    systemPrompt: config.systemPrompt ?? null,
    promptTemplate: config.promptTemplate,
    extraArgs: array(config.extraArgs),
    cwd: config.cwd ?? process.cwd(),
    env: {
      ...process.env,
      ...(config.env ?? {})
    },
    timeoutMs: config.timeoutMs ?? null,
    dangerouslySkipPermissions:
      config.dangerouslySkipPermissions === true
  };
}

function buildArgs(config, prompt) {
  const args = [
    ...config.baseArgs,
    "run",
    prompt,
    "--format",
    "json"
  ];

  if (config.attach) {
    args.push("--attach", config.attach);
  }

  if (config.model) {
    args.push("--model", config.model);
  }

  if (config.agent) {
    args.push("--agent", config.agent);
  }

  if (config.dir) {
    args.push("--dir", config.dir);
  }

  if (config.title) {
    args.push("--title", config.title);
  }

  if (config.username) {
    args.push("--username", config.username);
  }

  if (config.password) {
    args.push("--password", config.password);
  }

  if (config.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  args.push(...config.extraArgs);

  return args;
}

function buildPrompt(config, event) {
  if (typeof config.promptTemplate === "function") {
    return config.promptTemplate(event);
  }

  const observation = event.observation.payload;
  const decision = event.decision.payload;

  const sections = [];

  if (config.systemPrompt) {
    sections.push(
      "System/context instructions for the agent:\n" +
      config.systemPrompt
    );
  }

  sections.push(
    "You are being invoked by Brainstem because an observation was classified as actionable.\n" +
    "Investigate the observation and perform the appropriate coding or operational work.\n" +
    "Be careful, explain what you do, and stop when the task is complete."
  );

  sections.push(
    "Brainstem decision:\n" +
    JSON.stringify(decision, null, 2)
  );

  sections.push(
    "Observation:\n" +
    JSON.stringify(observation, null, 2)
  );

  return sections.join("\n\n");
}

function runCommand({
  executable,
  args,
  cwd,
  env,
  timeoutMs,
  signal,
  logger
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      args,
      {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let eventCount = 0;
    let stdoutLines = 0;
    let stderrLines = 0;
    const stderrTail = [];

    const timeout = timeoutMs
      ? setTimeout(() => {
          logger.warn?.(
            "opencode runner timed out",
            { timeoutMs }
          );
          child.kill("SIGTERM");
        }, timeoutMs)
      : null;

    timeout?.unref?.();

    const abort = () => {
      logger.warn?.(
        "opencode runner aborted"
      );
      child.kill("SIGTERM");
    };

    signal?.addEventListener(
      "abort",
      abort,
      { once: true }
    );

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", chunk => {
      stdoutBuffer = consumeLines(
        stdoutBuffer + chunk,
        line => {
          stdoutLines += 1;
          const parsed = parseJsonLine(line);

          if (parsed) {
            eventCount += 1;
            logger.debug?.(
              "opencode event",
              summarizeOpencodeEvent(parsed)
            );
          }
          else if (line.trim()) {
            logger.debug?.(
              "opencode stdout",
              { line }
            );
          }
        }
      );
    });

    child.stderr.on("data", chunk => {
      stderrBuffer = consumeLines(
        stderrBuffer + chunk,
        line => {
          stderrLines += 1;
          pushTail(stderrTail, line);
          logger.debug?.(
            "opencode stderr",
            { line }
          );
        }
      );
    });

    child.on("error", error => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });

    child.on("close", (code, closeSignal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);

      if (stdoutBuffer.trim()) {
        stdoutLines += 1;
        const parsed = parseJsonLine(stdoutBuffer);
        if (parsed) {
          eventCount += 1;
          logger.debug?.(
            "opencode event",
            summarizeOpencodeEvent(parsed)
          );
        }
      }

      if (stderrBuffer.trim()) {
        stderrLines += 1;
        pushTail(stderrTail, stderrBuffer.trim());
      }

      resolve({
        code,
        signal: closeSignal,
        eventCount,
        stdoutLines,
        stderrLines,
        stderrTail
      });
    });
  });
}

function consumeLines(text, onLine) {
  const lines = text.split("\n");
  const rest = lines.pop() ?? "";

  for (const line of lines) {
    onLine(line.replace(/\r$/, ""));
  }

  return rest;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  }
  catch {
    return null;
  }
}

function summarizeOpencodeEvent(event) {
  return {
    type: event.type ?? event.kind ?? null,
    sessionID: event.sessionID ?? event.sessionId ?? null,
    messageID: event.messageID ?? event.messageId ?? null,
    role: event.role ?? event.message?.role ?? null,
    text: summarizeText(
      event.text ??
      event.message?.text ??
      event.content
    ),
    raw: event
  };
}

function summarizeText(value) {
  if (typeof value !== "string") {
    return null;
  }

  return value.length > 500
    ? `${value.slice(0, 500)}…`
    : value;
}

function pushTail(lines, line, max = 20) {
  lines.push(line);

  while (lines.length > max) {
    lines.shift();
  }
}

function array(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value)
    ? value
    : [value];
}

function resolvePassword(config) {
  if (typeof config.password === "string") {
    return config.password;
  }

  if (config.passwordEnv) {
    return process.env[config.passwordEnv];
  }

  return process.env.OPENCODE_SERVER_PASSWORD;
}

function redactArgs(args) {
  const redacted = [];

  for (let index = 0; index < args.length; index += 1) {
    redacted.push(args[index]);

    if (args[index] === "--password") {
      index += 1;
      redacted.push("<redacted>");
    }
  }

  return redacted;
}
