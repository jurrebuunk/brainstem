import { defineInputPlugin } from "../../src/sdk/index.mjs";

import { runCheck } from "./check.mjs";
import { normalizeChecks } from "./config.mjs";
import { toObservation } from "./observation.mjs";
import { applyThresholds } from "./state.mjs";

export default defineInputPlugin({
  apiVersion: "brainstem.input/v1",
  name: "@brainstem/http-health",

  inputs: {
    check: {
      mode: "poll",
      defaultIntervalMs: 30_000,

      async *poll(ctx) {
        const checks = normalizeChecks(ctx.config);

        const checkpoint =
          await ctx.checkpoint?.get() ?? {};

        const state = {
          checks: {
            ...(checkpoint.checks ?? {})
          }
        };

        for (const check of checks) {
          const result =
            await runCheck(check, ctx.signal);

          const threshold =
            applyThresholds(
              check,
              result,
              state.checks[check.id]
            );

          state.checks[check.id] =
            threshold.next;

          if (threshold.emit) {
            yield toObservation(
              ctx,
              check,
              result
            );
          }
        }

        ctx.checkpoint?.defer(state);
      }
    }
  }
});
