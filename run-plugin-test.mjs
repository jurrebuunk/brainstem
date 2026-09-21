import config from "./brainstem.config.mjs";
import { BrainstemRuntime } from "./runtime.mjs";

const controller = new AbortController();

const runtime = new BrainstemRuntime({
  config,
  plugins: [
    {
      module: "./plugins/static-observations.mjs",
      config: {
        intervalMs: 1000,
        observations: [
          {
            id: "test:1",
            source: {
              type: "test",
              name: "demo"
            },
            type: "status",
            state: "open",
            title: "Production API is failing",
            message:
              "The API has returned HTTP 500 for the last 5 checks."
          }
        ]
      }
    }
  ],

  onDecision({ decision }) {
    console.dir(decision, {
      depth: null,
      colors: true
    });

    controller.abort();
  }
});

await runtime.start({
  signal: controller.signal
});

await runtime.wait();
await runtime.close();
