import config from "./brainstem.config.mjs";
import { BrainstemRuntime } from "./runtime.mjs";

const args =
  new Set(process.argv.slice(2));

const once =
  args.has("--once");

const printAll =
  args.has("--all");

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node brainstem.mjs [--once] [--all]\n\nOptions:\n  --once   Poll each configured input once, then exit.\n  --all    Print ignored decisions too.\n`);
  process.exit(0);
}

const inputs =
  config.inputs ?? [];

if (inputs.length === 0) {
  console.error(
    "No input plugins configured. Add entries to config.inputs or run `node run-plugin-test.mjs`."
  );

  process.exitCode = 1;
}
else {
  const controller =
    new AbortController();

  let stopping = false;

  function stop(signalName) {
    if (stopping) {
      return;
    }

    stopping = true;

    console.log(
      `\nReceived ${signalName}; shutting down Brainstem...`
    );

    controller.abort();
  }

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  const runtime =
    new BrainstemRuntime({
      config,
      plugins: inputs,

      onDecision({
        decision,
        observation,
        plugin,
        input
      }) {
        if (
          !printAll &&
          decision.payload.decision ===
          "ignore"
        ) {
          return;
        }

        console.log(
          `\n[${plugin.name}.${input}] ${observation.payload.id} -> ${decision.payload.decision}`
        );

        console.dir(decision, {
          depth: null,
          colors: true
        });
      }
    });

  try {
    if (once) {
      console.log(
        `Polling ${inputs.length} input plugin(s) once...`
      );

      await runtime.runOnce({
        signal: controller.signal
      });
    }
    else {
      console.log(
        `Starting Brainstem with ${inputs.length} input plugin(s)...`
      );

      await runtime.start({
        signal: controller.signal
      });

      await runtime.wait();
    }
  }
  finally {
    await runtime.close();
  }
}
