import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import config from "../../brainstem.config.example.mjs";

export const minimalPolicyConfig = {
  policy: config.policy,
  laya: config.laya
};

export const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

export async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), `brainstem-${prefix}-`));
}

export function runtimeConfig(checkpointPath, { retry = {}, runtime = {} } = {}) {
  return {
    policy: config.policy,
    laya: config.laya,
    runtime: {
      records: { type: "memory" },
      checkpoints: { type: "json", path: checkpointPath },
      retry: {
        attempts: 1,
        minDelayMs: 0,
        maxDelayMs: 0,
        factor: 1,
        ...retry
      },
      ...runtime
    }
  };
}

export function fakeBrainstem({ decision = "queue", route = "coding" } = {}) {
  return {
    async start() {},
    async close() {},
    async process(observation) {
      return {
        version: "1",
        kind: "decision",
        payload: {
          observation_id: observation.payload.id,
          revision: 1,
          decision,
          route
        }
      };
    }
  };
}

export async function readLines(path) {
  if (!existsSync(path)) return [];
  const content = await readFile(path, "utf8");
  return content.split("\n").filter(Boolean);
}

/*
 * Input plugin that emits one new observation per poll,
 * numbered from its checkpoint.
 */
export function countingInputSource({ prefix = "counter" } = {}) {
  return `
export default {
  apiVersion: "brainstem.input/v1",
  name: "counting-input",
  inputs: {
    default: {
      mode: "poll",
      async *poll(ctx) {
        const checkpoint = await ctx.checkpoint.get();
        const count = checkpoint?.count ?? 0;

        yield ctx.observation({
          id: \`${prefix}:\${count}\`,
          source: { type: "counter", name: "test" },
          type: "item",
          state: "new",
          title: \`Item \${count}\`,
          message: \`Count \${count}\`
        });

        ctx.checkpoint.defer({ count: count + 1 });
      }
    }
  }
};
`;
}

/*
 * Destination plugin that appends "<name> <observation id>"
 * to a shared file, one line per delivery.
 */
export function recordingDestinationSource(outputPath) {
  return `
import { appendFile } from "node:fs/promises";

export default {
  apiVersion: "brainstem.destination/v1",
  name: "recording-destination",
  destinations: {
    default: {
      async handle(ctx, event) {
        await appendFile(
          ${JSON.stringify(outputPath)},
          \`\${ctx.config.name ?? "default"} \${event.observation.payload.id}\\n\`
        );
      }
    }
  }
};
`;
}

export function failingDestinationSource() {
  return `
export default {
  apiVersion: "brainstem.destination/v1",
  name: "failing-destination",
  destinations: {
    default: {
      async handle() {
        throw new Error("destination exploded");
      }
    }
  }
};
`;
}

export async function writePlugin(dir, name, source) {
  const path = join(dir, name);
  await writeFile(path, source);
  return path;
}

export async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error(`condition not met within ${timeoutMs}ms`);
}
