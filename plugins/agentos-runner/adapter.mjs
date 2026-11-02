import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/*
 * The only module that talks to agentOS.
 *
 * agentOS is in preview and its API still moves, so the rest of
 * the plugin depends on this small interface instead:
 *
 *   createVm({ mounts, allowHosts, env, software, tools,
 *              toolCollection }) → vm
 *   vm.writeFile(path, text)
 *   vm.readFile(path) → text | null
 *   vm.exec(command, { timeoutMs, signal }) → { exitCode, stdout, stderr, ... }
 *   vm.runSession({ agent, prompt, timeoutMs, signal, onEvent })
 *   vm.dispose()
 *
 * `@rivet-dev/agentos-core` is an optional dependency: it is only
 * loaded when an agentos-runner entry actually runs.
 */
export const AGENTOS_PACKAGE = "@rivet-dev/agentos-core";

let loaded;

export async function loadAgentOsAdapter() {
  loaded ??= importAgentOs().catch(error => {
    loaded = undefined;
    throw error;
  });

  return createAgentOsAdapter(await loaded);
}

async function importAgentOs() {
  let agentos;

  try {
    agentos = await import(AGENTOS_PACKAGE);
  }
  catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        `agentos-runner needs the optional dependency ${AGENTOS_PACKAGE}. Install it with: npm install ${AGENTOS_PACKAGE}`,
        { cause: error }
      );
    }

    throw error;
  }

  // Host function schemas must come from the same zod instance
  // agentOS validates with, so resolve it through agentOS.
  const requireFromAgentOs = createRequire(
    import.meta.resolve(AGENTOS_PACKAGE)
  );
  const { z } = await import(
    pathToFileURL(requireFromAgentOs.resolve("zod")).href
  );

  return { agentos, z };
}

export function createAgentOsAdapter({ agentos, z }) {
  return {
    async createVm(options) {
      const vm = await agentos.AgentOs.create(vmOptions(agentos, z, options));

      return wrapVm(vm);
    }
  };
}

function vmOptions(agentos, z, {
  mounts = [],
  allowHosts = [],
  software = [],
  tools = {},
  toolCollection = "tools"
}) {
  const options = {
    mounts: mounts.map(mount =>
      agentos.hostDirMount(mount.path, mount.hostPath, { readOnly: mount.readOnly })
    ),
    permissions: {
      network: {
        // Nothing leaves the VM except the hosts the task allows.
        default: "deny",
        rules: allowHosts.length === 0
          ? []
          : [{
              mode: "allow",
              operations: ["*"],
              patterns: allowHosts.flatMap(host => [`dns://${host}`, `tcp://${host}:*`])
            }]
      }
    }
  };

  if (software.length > 0) {
    options.software = software;
  }

  const hostFunctions = Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      {
        inputSchema: inputSchema(z, tool),
        timeout: tool.timeoutMs,
        execute: input => tool.execute(input)
      }
    ])
  );

  if (Object.keys(hostFunctions).length > 0) {
    options.hostFunctions = { [toolCollection]: hostFunctions };
  }

  return options;
}

/*
 * Brainstem validates arguments itself (tools.mjs); the schema
 * mainly gives agentOS the CLI flags and the description the
 * agent sees.
 */
function inputSchema(z, tool) {
  const shape = {};

  for (const [name, field] of Object.entries(tool.input)) {
    // Non-string enums are enforced by validateArgs only.
    let schema = field.type === "string" && field.enum
      ? z.enum(field.enum)
      : {
          string: () => z.string(),
          number: () => z.number(),
          integer: () => z.number().int(),
          boolean: () => z.boolean()
        }[field.type]();

    if (field.maxLength && !field.enum) schema = schema.max(field.maxLength);
    if (field.description) schema = schema.describe(field.description);
    if (field.optional) schema = schema.optional();

    shape[name] = schema;
  }

  return z.object(shape).describe(tool.description);
}

function wrapVm(vm) {
  return {
    async writeFile(path, text) {
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (dir) await vm.mkdir(dir, { recursive: true });
      await vm.writeFile(path, text);
    },

    async readFile(path) {
      if (!(await vm.exists(path))) return null;
      return new TextDecoder().decode(await vm.readFile(path));
    },

    async exec(command, { timeoutMs, signal, env } = {}) {
      const result = await vm.process.exec(command, {
        timeoutMs,
        signal,
        env,
        output: { capture: "all" }
      });

      return {
        exitCode: result.exitCode ?? null,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        stdoutTruncated: result.stdoutTruncated === true,
        stderrTruncated: result.stderrTruncated === true,
        outcome: result.outcome ?? null
      };
    },

    /*
     * Agent sessions are step 2 of the agentos-runner plan. They
     * are not part of @rivet-dev/agentos-core 0.4.x; the session
     * API lives in the @rivet-dev/agentos runtime SDK.
     */
    async runSession() {
      throw new Error(
        "agentos-runner: agent sessions ('prompt' tasks) are not implemented yet; use a 'command' task for now"
      );
    },

    async dispose() {
      await vm.dispose();
    }
  };
}
