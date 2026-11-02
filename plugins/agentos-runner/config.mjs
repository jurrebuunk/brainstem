import { isAbsolute, resolve } from "node:path";

const RUN_ONCE_MODES = ["revision", "emission"];
const FIELD_TYPES = ["string", "number", "integer", "boolean"];
const TOOL_NAME = /^[a-z][a-zA-Z0-9]*(?:[-_][a-zA-Z0-9]+)*$/;

export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
export const DEFAULT_BOOT_TIMEOUT_MS = 30 * 1000;
export const DEFAULT_TOOL_MAX_CALLS = 10;
export const DEFAULT_TOOL_TIMEOUT_MS = 30 * 1000;

/*
 * Validates and normalizes one agentos-runner entry's config.
 * Throws a TypeError naming the offending field, so a bad task
 * fails loudly instead of silently doing the wrong thing.
 */
export function normalizeConfig(config = {}) {
  if (!isPlainObject(config)) {
    fail("config", "must be an object");
  }

  const hasPrompt = config.prompt !== undefined;
  const hasCommand = config.command !== undefined;

  if (hasPrompt === hasCommand) {
    fail("config", "set exactly one of 'prompt' (agent task) or 'command' (scripted task)");
  }

  if (hasPrompt) assertTemplate(config.prompt, "prompt");
  if (hasCommand) assertTemplate(config.command, "command");

  const runOnce = config.runOnce ?? "revision";

  if (!RUN_ONCE_MODES.includes(runOnce)) {
    fail("runOnce", `must be one of ${RUN_ONCE_MODES.join(", ")}`);
  }

  return {
    mode: hasPrompt ? "agent" : "command",
    agent: optionalString(config.agent, "agent") ?? "pi",
    prompt: config.prompt ?? null,
    command: config.command ?? null,
    allowHosts: normalizeHosts(config.allowHosts),
    mounts: normalizeMounts(config.mounts),
    env: normalizeEnv(config.env),
    software: normalizeSoftware(config.software),
    tools: normalizeTools(config.tools),
    toolCollection: optionalString(config.toolCollection, "toolCollection") ?? "tools",
    inboxPath: optionalString(config.inboxPath, "inboxPath") ?? "/inbox/envelope.json",
    outboxPath: optionalString(config.outboxPath, "outboxPath") ?? "/outbox/result.json",
    timeoutMs: positiveInteger(config.timeoutMs, "timeoutMs") ?? DEFAULT_TIMEOUT_MS,
    bootTimeoutMs: positiveInteger(config.bootTimeoutMs, "bootTimeoutMs") ?? DEFAULT_BOOT_TIMEOUT_MS,
    failOnExitCode: optionalBoolean(config.failOnExitCode, "failOnExitCode") ?? true,
    runOnce,
    minRouteConfidence: normalizeConfidence(config.minRouteConfidence),
    onMissingRequired: optionalFunction(config.onMissingRequired, "onMissingRequired"),
    onResult: optionalFunction(config.onResult, "onResult"),
    outputLogMaxChars: positiveInteger(config.outputLogMaxChars, "outputLogMaxChars") ?? 4000,
    adapter: normalizeAdapter(config.adapter)
  };
}

/*
 * Config-time helper: validate a task where it is declared, so a
 * typo fails when brainstem.config.mjs loads instead of on the
 * first matching delivery. Returns the config unchanged.
 */
export function defineAgentOsTask(config) {
  normalizeConfig(config);

  return config;
}

function normalizeTools(tools) {
  if (tools === undefined) return {};

  if (!isPlainObject(tools)) {
    fail("tools", "must be an object keyed by tool name");
  }

  const normalized = {};

  for (const [name, tool] of Object.entries(tools)) {
    const path = `tools.${name}`;

    if (!TOOL_NAME.test(name)) {
      fail(path, "name must start with a lowercase letter and use letters, digits, '-' or '_'");
    }

    if (!isPlainObject(tool)) {
      fail(path, "must be an object");
    }

    if (typeof tool.run !== "function") {
      fail(`${path}.run`, "must be a function (args, ctx) => result");
    }

    if (typeof tool.description !== "string" || !tool.description.trim()) {
      fail(`${path}.description`, "is required; the agent reads it to decide when to call the tool");
    }

    normalized[name] = {
      name,
      description: tool.description.trim(),
      input: normalizeInput(tool.input, `${path}.input`),
      maxCalls: positiveInteger(tool.maxCalls, `${path}.maxCalls`) ?? DEFAULT_TOOL_MAX_CALLS,
      required: optionalBoolean(tool.required, `${path}.required`) ?? false,
      timeoutMs: positiveInteger(tool.timeoutMs, `${path}.timeoutMs`) ?? DEFAULT_TOOL_TIMEOUT_MS,
      run: tool.run
    };
  }

  return normalized;
}

/*
 * Input fields are either a type name ("string", "number?",
 * ...; a trailing '?' marks the field optional) or an object
 * { type, optional, description, maxLength, enum }.
 */
function normalizeInput(input, path) {
  if (input === undefined) return {};

  if (!isPlainObject(input)) {
    fail(path, "must be an object keyed by field name");
  }

  const fields = {};

  for (const [name, spec] of Object.entries(input)) {
    const fieldPath = `${path}.${name}`;
    const field = typeof spec === "string"
      ? {
          type: spec.replace(/\?$/, ""),
          optional: spec.endsWith("?")
        }
      : isPlainObject(spec)
        ? { ...spec }
        : fail(fieldPath, "must be a type name or an object");

    if (!FIELD_TYPES.includes(field.type)) {
      fail(`${fieldPath}.type`, `must be one of ${FIELD_TYPES.join(", ")}`);
    }

    if (field.enum !== undefined) {
      if (
        !Array.isArray(field.enum) ||
        field.enum.length === 0 ||
        field.enum.some(value => typeof value !== (field.type === "integer" ? "number" : field.type))
      ) {
        fail(`${fieldPath}.enum`, `must be a non-empty array of ${field.type} values`);
      }
    }

    fields[name] = {
      type: field.type,
      optional: optionalBoolean(field.optional, `${fieldPath}.optional`) ?? false,
      description: optionalString(field.description, `${fieldPath}.description`),
      maxLength: field.type === "string"
        ? positiveInteger(field.maxLength, `${fieldPath}.maxLength`)
        : null,
      enum: field.enum ?? null
    };
  }

  return fields;
}

function normalizeHosts(hosts) {
  if (hosts === undefined) return [];

  if (
    !Array.isArray(hosts) ||
    hosts.some(host => typeof host !== "string" || !host.trim() || /[\s/:]/.test(host))
  ) {
    fail("allowHosts", "must be an array of host names such as 'api.example.com'");
  }

  return [...new Set(hosts.map(host => host.trim()))];
}

function normalizeMounts(mounts) {
  if (mounts === undefined) return [];

  if (!Array.isArray(mounts)) {
    fail("mounts", "must be an array");
  }

  return mounts.map((mount, index) => {
    const path = `mounts[${index}]`;

    if (!isPlainObject(mount)) fail(path, "must be an object");

    if (typeof mount.path !== "string" || !mount.path.startsWith("/")) {
      fail(`${path}.path`, "must be an absolute path inside the VM");
    }

    if (typeof mount.hostPath !== "string" || !mount.hostPath) {
      fail(`${path}.hostPath`, "must be a host directory");
    }

    return {
      path: mount.path,
      hostPath: isAbsolute(mount.hostPath)
        ? mount.hostPath
        : resolve(mount.hostPath),
      // Read-only unless the task explicitly asks for write access.
      readOnly: optionalBoolean(mount.readOnly, `${path}.readOnly`) ?? true
    };
  });
}

function normalizeEnv(env) {
  if (env === undefined) return {};

  if (
    !isPlainObject(env) ||
    Object.values(env).some(value => typeof value !== "string")
  ) {
    fail("env", "must be an object of string values");
  }

  return { ...env };
}

function normalizeSoftware(software) {
  if (software === undefined) return [];

  if (!Array.isArray(software)) {
    fail("software", "must be an array of agentOS software entries, e.g. { registry: \"ripgrep\" }");
  }

  return [...software];
}

function normalizeConfidence(value) {
  if (value === undefined || value === null) return null;

  if (typeof value !== "number" || value < 0 || value > 1) {
    fail("minRouteConfidence", "must be a number between 0 and 1");
  }

  return value;
}

function normalizeAdapter(adapter) {
  if (adapter === undefined) return null;

  if (!adapter || typeof adapter.createVm !== "function") {
    fail("adapter", "must define createVm(options)");
  }

  return adapter;
}

function assertTemplate(value, path) {
  if (typeof value === "function") return;

  if (typeof value !== "string" || !value.trim()) {
    fail(path, "must be a non-empty string template or a function (event) => string");
  }
}

function optionalString(value, path) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(path, "must be a string");
  return value;
}

function optionalBoolean(value, path) {
  if (value === undefined) return null;
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function optionalFunction(value, path) {
  if (value === undefined) return null;
  if (typeof value !== "function") fail(path, "must be a function");
  return value;
}

function positiveInteger(value, path) {
  if (value === undefined || value === null) return null;

  if (!Number.isInteger(value) || value <= 0) {
    fail(path, "must be a positive integer");
  }

  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(path, message) {
  throw new TypeError(`agentos-runner: ${path} ${message}`);
}
