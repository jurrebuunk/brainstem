import { defineInputPlugin } from "../../src/sdk/index.mjs";

import { checkCertificate } from "./check.mjs";
import { normalizeTargets } from "./config.mjs";
import { toObservation } from "./observation.mjs";
import { shouldEmitCertificateObservation } from "./state.mjs";

export default defineInputPlugin({
  apiVersion: "brainstem.input/v1",
  name: "@brainstem/tls-certificate",

  inputs: {
    check: {
      mode: "poll",
      defaultIntervalMs: 6 * 60 * 60 * 1000,

      async *poll(ctx) {
        const targets =
          normalizeTargets(ctx.config);

        const checkpoint =
          await ctx.checkpoint?.get() ?? {};

        const state = {
          targets: {
            ...(checkpoint.targets ?? {})
          }
        };

        for (const target of targets) {
          const result =
            await checkCertificate(
              target,
              ctx.signal
            );

          const emission =
            shouldEmitCertificateObservation({
              target,
              result,
              previous: state.targets[target.id]
            });

          state.targets[target.id] =
            emission.next;

          ctx.logger?.debug?.(
            "tls certificate check result",
            {
              id: target.id,
              name: target.name,
              state: result.state,
              daysRemaining: result.daysRemaining,
              emitted: emission.emit
            }
          );

          if (emission.emit) {
            yield toObservation(
              ctx,
              target,
              result
            );
          }
        }

        ctx.checkpoint?.defer(state);
      }
    }
  }
});
