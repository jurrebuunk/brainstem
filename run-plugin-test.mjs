import config from "./brainstem.config.mjs";
import { BrainstemRuntime } from "./runtime.mjs";

const runtime = new BrainstemRuntime({
  config,
  plugins: [
    {
      module: "./plugins/static-observations/index.mjs",
      config: {
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
  destinations: [
    {
      module: "./plugins/log-decisions/index.mjs",
      destination: "default",
      decisions: "all",
      config: {
        prefix: "brainstem-test"
      }
    }
  ]
});

await runtime.runOnce();
