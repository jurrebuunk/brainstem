import { createHash } from "node:crypto";

import { validate } from "./json-schema.mjs";

/*
 * Config as data (roadmap 4.6, ADR-0005).
 *
 * The pipeline config (inputs, destinations, policy, laya and the
 * runtime tuning) is stored as JSON in `config_versions` and
 * validated by CONFIG_SCHEMA before it is saved. Nothing a user
 * submits is executed.
 *
 * Bootstrap settings stay with the process (file or environment),
 * because they are needed before the database can be read or are
 * per-process: runtime.database, api, logging, telemetry, coreId,
 * role and queues. A stored version may contain them, but the
 * process's own values win (see mergeBootstrap).
 */
export const CONFIG_SCHEMA_VERSION = 1;

export const BOOTSTRAP_RUNTIME_KEYS = ["database", "api", "logging", "telemetry", "coreId", "role", "queues"];

const DECISIONS = ["ignore", "queue", "dispatch", "escalate"];

const stringList = (items = { type: "string", minLength: 1 }) => ({
  anyOf: [{ const: "all" }, { type: "array", items }],
  errorMessage: "must be \"all\" or a list"
});

const retry = {
  type: "object",
  properties: {
    attempts: { type: "integer", minimum: 1 },
    minDelayMs: { type: "number", minimum: 0 },
    maxDelayMs: { type: "number", minimum: 0 },
    factor: { type: "number", minimum: 1 },
    jitter: { type: "boolean" }
  },
  additionalProperties: false
};

const threshold = { type: "number", minimum: 0 };

export const CONFIG_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/jurrebuunk/brainstem/schemas/config-v1.json",
  title: "Brainstem config",
  type: "object",
  required: ["policy", "laya"],
  properties: {
    $schema: { type: "string" },
    comment: { type: "string" },
    inputs: { type: "array", items: { $ref: "#/$defs/input" } },
    destinations: { type: "array", items: { $ref: "#/$defs/destination" } },
    policy: { $ref: "#/$defs/policy" },
    laya: { $ref: "#/$defs/laya" },
    runtime: { $ref: "#/$defs/runtime" }
  },
  additionalProperties: false,

  $defs: {
    id: { type: "string", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:-]+$" },

    // Plugin options are plugin-specific, but must be plain JSON.
    pluginConfig: { type: "object" },

    input: {
      type: "object",
      required: ["module"],
      properties: {
        id: { $ref: "#/$defs/id" },
        module: { type: "string", minLength: 1 },
        input: { type: "string", minLength: 1 },
        intervalMs: { type: "integer", minimum: 1 },
        baseDir: { type: "string" },
        retry,
        config: { $ref: "#/$defs/pluginConfig" }
      },
      additionalProperties: false
    },

    destination: {
      type: "object",
      required: ["module"],
      properties: {
        id: { $ref: "#/$defs/id" },
        module: { type: "string", minLength: 1 },
        destination: { type: "string", minLength: 1 },
        baseDir: { type: "string" },
        decisions: stringList({ enum: DECISIONS }),
        routes: stringList(),
        sources: stringList(),
        types: stringList(),
        retry,
        config: { $ref: "#/$defs/pluginConfig" }
      },
      additionalProperties: false
    },

    policy: {
      type: "object",
      required: ["dispatch", "queue", "actionableQueue"],
      properties: {
        dispatch: {
          type: "object",
          required: ["attention", "actionable"],
          properties: { attention: threshold, actionable: threshold },
          additionalProperties: false
        },
        queue: {
          type: "object",
          required: ["actionable", "severity"],
          properties: { actionable: threshold, severity: threshold },
          additionalProperties: false
        },
        actionableQueue: {
          type: "object",
          required: ["actionable"],
          properties: { actionable: threshold },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },

    question: {
      type: "object",
      required: ["type", "instructions"],
      properties: {
        type: { enum: ["noul", "score", "choice"] },
        instructions: { type: "string", minLength: 1 },
        criteria: { type: ["array", "object"] }
      }
    },

    laya: {
      type: "object",
      required: ["questions"],
      properties: {
        questions: {
          type: "object",
          required: ["attention", "actionable", "severity", "route"],
          additionalProperties: { $ref: "#/$defs/question" }
        },
        download: { type: "object" }
      },
      additionalProperties: false
    },

    queueStage: {
      type: "object",
      properties: {
        concurrency: { type: "integer", minimum: 1 },
        retry
      },
      additionalProperties: false
    },

    runtime: {
      type: "object",
      properties: {
        // Bootstrap: the process's own values win (see mergeBootstrap).
        database: { type: "object" },
        api: { type: "object" },
        logging: { type: "object" },
        telemetry: { type: ["object", "string"] },
        coreId: { type: "string" },
        role: { enum: ["all", "core", "api"] },
        queues: {
          anyOf: [
            { const: "all" },
            { type: "array", items: { enum: ["poll", "decide", "deliver"] }, minItems: 1 }
          ]
        },

        queue: {
          type: "object",
          properties: {
            transport: { enum: ["database", "postgres", "memory"] },
            pollIntervalMs: { type: "number", minimum: 10 },
            leaseMs: { type: "number", minimum: 1000 },
            decide: { $ref: "#/$defs/queueStage" },
            deliver: { $ref: "#/$defs/queueStage" }
          },
          additionalProperties: false
        },
        inputs: {
          type: "object",
          properties: {
            scheduling: { enum: ["lease", "timer"] },
            leaseMs: { type: "number", minimum: 1000 },
            concurrency: { type: "integer", minimum: 1 },
            checkIntervalMs: { type: "number", minimum: 10 }
          },
          additionalProperties: false
        },
        handoff: {
          type: "object",
          properties: {
            maxDepth: { type: "integer", minimum: 0 },
            maxPerDelivery: { type: "integer", minimum: 0 }
          },
          additionalProperties: false
        },
        shutdown: {
          type: "object",
          properties: { timeoutMs: { type: "number", minimum: 0 } },
          additionalProperties: false
        },
        cores: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            heartbeatMs: { type: "number", minimum: 100 }
          },
          additionalProperties: false
        },
        laya: {
          type: "object",
          properties: {
            workers: { type: "integer", minimum: 0 },
            modelDir: { type: "string" },
            cacheDir: { type: "string" },
            repo: { type: "string" },
            revision: { type: "string" },
            subfolder: { type: "string" },
            tokenEnv: { type: "string" }
          }
        },
        records: { type: ["object", "boolean"] },
        checkpoints: { type: ["object", "boolean"] },
        deliveries: {
          type: "object",
          properties: { pruneAfterDays: { type: "number" } },
          additionalProperties: false
        },
        retry,
        startupRetry: retry,
        destinations: { type: "object" }
      },
      additionalProperties: false
    }
  }
};

/*
 * Validate a config spec. Returns a list of "path: message" strings
 * (empty when valid).
 */
export function validateConfigSpec(spec) {
  const plain = plainDataErrors(spec);
  if (plain.length > 0) return plain;

  return validate(CONFIG_SCHEMA, spec).map(error => `${error.path}: ${error.message}`);
}

export class ConfigValidationError extends Error {
  constructor(errors) {
    super(`Invalid config:\n  ${errors.slice(0, 20).join("\n  ")}${errors.length > 20 ? `\n  … ${errors.length - 20} more` : ""}`);
    this.name = "ConfigValidationError";
    this.statusCode = 400;
    this.errors = errors;
  }
}

export function assertValidConfigSpec(spec) {
  const errors = validateConfigSpec(spec);
  if (errors.length > 0) throw new ConfigValidationError(errors);
  return spec;
}

/*
 * Stored config must be plain JSON: functions (such as agentOS
 * `tools.*.run`), class instances, undefined, NaN and Infinity
 * cannot be stored, so they are reported with their path.
 */
export function plainDataErrors(value, path = "") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return [];

  if (typeof value === "number") {
    return Number.isFinite(value) ? [] : [`${path || "/"}: must be a finite number`];
  }

  if (typeof value === "function") {
    return [`${path || "/"}: is a function; config stored in the database must be plain data (keep this config as a file: configSource "file")`];
  }

  if (value === undefined) return [`${path || "/"}: is undefined`];

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => plainDataErrors(item, `${path}/${index}`));
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return [`${path || "/"}: must be plain JSON data`];
    }

    return Object.entries(value).flatMap(([key, item]) => plainDataErrors(item, `${path}/${key}`));
  }

  return [`${path || "/"}: is not JSON (${typeof value})`];
}

/*
 * The runtime config a process runs: the stored spec, with the
 * process's bootstrap settings (BOOTSTRAP_RUNTIME_KEYS) kept from
 * its own file or environment.
 */
export function mergeBootstrap(bootstrap = {}, spec = {}) {
  const runtime = { ...(spec.runtime ?? {}) };

  for (const key of BOOTSTRAP_RUNTIME_KEYS) {
    if (bootstrap.runtime && Object.hasOwn(bootstrap.runtime, key)) {
      runtime[key] = bootstrap.runtime[key];
    }
  }

  return { ...spec, runtime };
}

/*
 * Stable hash of a spec (key order does not matter).
 */
export function specHash(spec) {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex").slice(0, 16);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
