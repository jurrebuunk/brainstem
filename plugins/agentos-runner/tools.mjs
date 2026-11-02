/*
 * Host-side tools for one delivery.
 *
 * Only the tools configured on the entry are exposed. Every call
 * is validated, counted against `maxCalls`, and recorded in
 * ctx.state under the delivery's idempotency key plus the tool
 * name and call number. A retried delivery that makes the same
 * call again gets the recorded result back instead of repeating
 * the side effect (a second Matrix message, a second webhook).
 */
const CALL_KEY_PREFIX = "tool:";

export class ToolCallError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolCallError";
  }
}

export function createToolRuntime({ tools, ctx, event, logMaxChars = 500 }) {
  const counts = new Map();
  const succeeded = new Set();
  const callKeys = [];
  const calls = [];

  async function call(name, args) {
    const tool = tools[name];

    if (!tool) {
      throw new ToolCallError(`unknown tool '${name}'`);
    }

    const number = (counts.get(name) ?? 0) + 1;
    counts.set(name, number);

    // Failed and rejected calls count too, so a confused agent
    // cannot retry a tool in a loop.
    if (number > tool.maxCalls) {
      const error = new ToolCallError(
        `tool '${name}' reached its limit of ${tool.maxCalls} call${tool.maxCalls === 1 ? "" : "s"}`
      );
      record({ tool: name, call: number, ok: false, error: error.message });
      throw error;
    }

    let input;

    try {
      input = validateArgs(tool, args);
    }
    catch (error) {
      record({ tool: name, call: number, ok: false, error: error.message });
      throw error;
    }

    const callId = ctx.idempotencyKey
      ? `${ctx.idempotencyKey}:${name}:${number}`
      : null;
    const stateKey = callId ? CALL_KEY_PREFIX + callId : null;

    if (stateKey) {
      callKeys.push(stateKey);

      const previous = await ctx.state.get(stateKey);

      if (previous?.status === "done") {
        succeeded.add(name);
        record({ tool: name, call: number, ok: true, replayed: true });

        ctx.logger.info?.(
          "agentos tool call replayed",
          { tool: name, call: number, attempt: ctx.attempt }
        );

        return previous.result;
      }
    }

    try {
      const result = toJson(
        await withTimeout(
          () => tool.run(input, {
            idempotencyKey: callId,
            call: number,
            attempt: ctx.attempt,
            logger: ctx.logger,
            signal: ctx.signal,
            event
          }),
          tool.timeoutMs,
          `tool '${name}' timed out after ${tool.timeoutMs}ms`
        )
      );

      if (stateKey) {
        await ctx.state.set(stateKey, { status: "done", result });
      }

      succeeded.add(name);
      record({ tool: name, call: number, ok: true, replayed: false });

      ctx.logger.info?.(
        "agentos tool call",
        {
          tool: name,
          call: number,
          args: truncate(JSON.stringify(input), logMaxChars)
        }
      );

      return result;
    }
    catch (error) {
      record({ tool: name, call: number, ok: false, error: error.message });

      ctx.logger.warn?.(
        "agentos tool call failed",
        { tool: name, call: number, error: error.message }
      );

      throw error;
    }
  }

  function record(entry) {
    calls.push(entry);
  }

  return {
    call,
    calls,

    /*
     * Tools marked `required` that never completed a call
     * (a replayed call counts as completed).
     */
    missingRequired() {
      return Object.values(tools)
        .filter(tool => tool.required && !succeeded.has(tool.name))
        .map(tool => tool.name);
    },

    /*
     * Forget the recorded calls once the delivery has succeeded;
     * no retry can need them any more.
     */
    async clear() {
      for (const key of callKeys) {
        await ctx.state.delete(key);
      }
    }
  };
}

export function validateArgs(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new ToolCallError(`tool '${tool.name}' expects an object of arguments`);
  }

  const input = {};

  for (const key of Object.keys(args)) {
    if (!tool.input[key]) {
      throw new ToolCallError(`tool '${tool.name}' has no argument '${key}'`);
    }
  }

  for (const [key, field] of Object.entries(tool.input)) {
    const value = args[key];

    if (value === undefined || value === null) {
      if (!field.optional) {
        throw new ToolCallError(`tool '${tool.name}' is missing argument '${key}'`);
      }

      continue;
    }

    if (!matchesType(value, field.type)) {
      throw new ToolCallError(`tool '${tool.name}' argument '${key}' must be ${field.type}`);
    }

    if (field.maxLength && value.length > field.maxLength) {
      throw new ToolCallError(
        `tool '${tool.name}' argument '${key}' exceeds ${field.maxLength} characters`
      );
    }

    if (field.enum && !field.enum.includes(value)) {
      throw new ToolCallError(
        `tool '${tool.name}' argument '${key}' must be one of ${field.enum.join(", ")}`
      );
    }

    input[key] = value;
  }

  return input;
}

function matchesType(value, type) {
  switch (type) {
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    default: return false;
  }
}

/*
 * Results are stored in ctx.state and handed to the VM, so they
 * must survive JSON.
 */
function toJson(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

async function withTimeout(fn, ms, message) {
  let timer;

  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ToolCallError(message)), ms);
      })
    ]);
  }
  finally {
    clearTimeout(timer);
  }
}

function truncate(value, max) {
  return value.length > max
    ? `${value.slice(0, max)}…`
    : value;
}
