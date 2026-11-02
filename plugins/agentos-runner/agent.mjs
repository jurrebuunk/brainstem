/*
 * The agent loop for `prompt` tasks.
 *
 * It runs on the host and talks to an OpenAI-compatible chat
 * completions endpoint, so the API key never enters the VM and
 * the VM needs no network access. The model works through two
 * kinds of tools:
 *
 *   run_command  a shell command inside the VM
 *   <tool>       the entry's host tools (tools.mjs)
 *
 * Model APIs with low limits are the norm here, so every run is
 * bounded: turns, output tokens, commands, the size of each tool
 * result fed back, the size of the whole conversation, and one
 * request at a time per process with a minimum interval.
 */
export const RUN_COMMAND_TOOL = "run_command";

export class AgentBudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentBudgetError";
  }
}

export async function runAgentLoop({
  model,
  limits,
  system,
  prompt,
  tools,
  toolRuntime,
  vm,
  signal,
  logger
}) {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: truncate(prompt, limits.maxPromptChars) }
  ];
  const toolSchemas = [runCommandSchema(limits), ...Object.values(tools).map(hostToolSchema)];
  const seenCalls = new Set();
  const usage = { requests: 0, promptTokens: 0, completionTokens: 0 };
  let commands = 0;
  let nudged = false;

  for (let turn = 1; turn <= limits.maxTurns; turn += 1) {
    const size = contextChars(messages);

    if (size > limits.maxContextChars) {
      throw new AgentBudgetError(
        `conversation reached ${size} characters (limit ${limits.maxContextChars})`
      );
    }

    const reply = await requestCompletion(model, limits, messages, toolSchemas, signal);
    usage.requests += 1;
    usage.promptTokens += reply.usage?.prompt_tokens ?? 0;
    usage.completionTokens += reply.usage?.completion_tokens ?? 0;

    const message = reply.choices?.[0]?.message;

    if (!message) {
      throw new Error("agentos-runner: model returned no message");
    }

    const calls = message.tool_calls ?? [];

    messages.push({
      role: "assistant",
      content: message.content ?? null,
      ...(calls.length > 0 ? { tool_calls: calls } : {})
    });

    logger.info?.(
      "agentos agent turn",
      {
        turn,
        toolCalls: calls.map(call => call.function?.name),
        text: message.content ? truncate(message.content, 500) : null,
        usage: reply.usage ?? null
      }
    );

    if (calls.length === 0) {
      const missing = toolRuntime.missingRequired();

      // One reminder to call a required tool, if a turn is left.
      if (missing.length > 0 && !nudged && turn < limits.maxTurns) {
        nudged = true;
        messages.push({
          role: "user",
          content: `Before finishing you must call: ${missing.join(", ")}.`
        });
        continue;
      }

      return {
        text: message.content ?? "",
        turns: turn,
        commands,
        usage
      };
    }

    for (const call of calls) {
      const name = call.function?.name;
      const content = await (async () => {
        const args = parseArguments(call.function?.arguments);

        if (args === null) {
          return errorResult("arguments must be a JSON object");
        }

        // An identical call already has its answer in the
        // conversation; repeating it is how loops start.
        const signature = `${name}:${JSON.stringify(args)}`;

        if (seenCalls.has(signature)) {
          return errorResult("duplicate call: reuse the earlier result instead of calling again");
        }

        seenCalls.add(signature);

        if (name === RUN_COMMAND_TOOL) {
          if (commands >= limits.maxCommands) {
            return errorResult(`command limit of ${limits.maxCommands} reached; finish with what you have`);
          }

          if (typeof args.command !== "string" || !args.command.trim()) {
            return errorResult("command must be a non-empty string");
          }

          commands += 1;

          const result = await vm.exec(args.command, {
            timeoutMs: limits.commandTimeoutMs,
            signal
          });

          logger.info?.(
            "agentos agent command",
            {
              command: truncate(args.command, 500),
              exitCode: result.exitCode,
              outputChars: result.stdout.length + result.stderr.length
            }
          );

          return JSON.stringify({
            exitCode: result.exitCode,
            stdout: truncate(result.stdout, limits.maxToolOutputChars),
            stderr: truncate(result.stderr, Math.floor(limits.maxToolOutputChars / 4))
          });
        }

        if (!tools[name]) {
          return errorResult(`unknown tool '${name}'`);
        }

        try {
          const result = await toolRuntime.call(name, args);
          return truncate(JSON.stringify({ ok: true, result }), limits.maxToolOutputChars);
        }
        catch (error) {
          return errorResult(error.message);
        }
      })();

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content
      });
    }
  }

  throw new AgentBudgetError(`no final answer within ${limits.maxTurns} turns`);
}

/*
 * One request at a time per process, spaced by
 * minRequestIntervalMs, so parallel deliveries can't burst
 * through a low rate limit.
 */
let gate = Promise.resolve();
let lastRequestAt = 0;

async function requestCompletion(model, limits, messages, tools, signal) {
  const turn = gate.then(async () => {
    const wait = lastRequestAt + limits.minRequestIntervalMs - Date.now();
    if (wait > 0) await sleep(wait, signal);
    lastRequestAt = Date.now();
    return await sendCompletion(model, limits, messages, tools, signal);
  });

  gate = turn.catch(() => {});

  return await turn;
}

async function sendCompletion(model, limits, messages, tools, signal) {
  const response = await fetch(`${model.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${model.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: model.name,
      messages,
      tools,
      tool_choice: "auto",
      max_completion_tokens: limits.maxOutputTokens
    })
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `agentos-runner: model request failed: ${response.status} ${response.statusText}${text ? ` - ${truncate(text, 300)}` : ""}`
    );
  }

  try {
    return JSON.parse(text);
  }
  catch {
    throw new Error(`agentos-runner: model returned invalid JSON: ${truncate(text, 300)}`);
  }
}

function runCommandSchema(limits) {
  return {
    type: "function",
    function: {
      name: RUN_COMMAND_TOOL,
      description:
        `Run a shell command in the sandbox and get its exit code and output (output is cut at ${limits.maxToolOutputChars} characters; at most ${limits.maxCommands} commands). Prefer targeted commands such as grep, head or tail over printing whole files.`,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run" }
        },
        required: ["command"],
        additionalProperties: false
      }
    }
  };
}

function hostToolSchema(tool) {
  const properties = {};
  const required = [];

  for (const [name, field] of Object.entries(tool.input)) {
    properties[name] = {
      type: field.type,
      ...(field.description ? { description: field.description } : {}),
      ...(field.maxLength ? { maxLength: field.maxLength } : {}),
      ...(field.enum ? { enum: field.enum } : {})
    };

    if (!field.optional) required.push(name);
  }

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false
      }
    }
  };
}

function parseArguments(value) {
  try {
    const args = typeof value === "string" ? JSON.parse(value || "{}") : value ?? {};
    return args && typeof args === "object" && !Array.isArray(args) ? args : null;
  }
  catch {
    return null;
  }
}

function errorResult(message) {
  return JSON.stringify({ ok: false, error: message });
}

function contextChars(messages) {
  return messages.reduce(
    (total, message) =>
      total +
      (message.content?.length ?? 0) +
      (message.tool_calls ? JSON.stringify(message.tool_calls).length : 0),
    0
  );
}

function truncate(value, max) {
  return value.length > max
    ? `${value.slice(0, max)}… [truncated ${value.length - max} chars]`
    : value;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
