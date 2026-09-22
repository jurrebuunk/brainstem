import { defineInputPlugin } from "../../src/sdk/index.mjs";

import { runCheck } from "./check.mjs";
import { normalizeChecks } from "./config.mjs";
import { toObservation } from "./observation.mjs";

export default defineInputPlugin({
  apiVersion: "brainstem.input/v1",
  name: "@brainstem/http-health",

  inputs: {
    check: {
      mode: "poll",
      defaultIntervalMs: 30_000,

      async *poll(ctx) {
        const checks = normalizeChecks(ctx.config);

        for (const check of checks) {
          const result =
            await runCheck(check, ctx.signal);

          if (
            result.healthy ||
            check.emitHealthy !== false
          ) {
            yield toObservation(ctx, check, result);
          }
        }
      }
    }
  }
});
