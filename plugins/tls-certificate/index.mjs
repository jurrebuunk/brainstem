import { defineInputPlugin } from "../../src/sdk/index.mjs";

import { checkCertificate } from "./check.mjs";
import { normalizeTargets } from "./config.mjs";
import { toObservation } from "./observation.mjs";

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

        for (const target of targets) {
          const result =
            await checkCertificate(
              target,
              ctx.signal
            );

          if (
            result.state !== "valid" ||
            target.emitHealthy !== false
          ) {
            yield toObservation(
              ctx,
              target,
              result
            );
          }
        }
      }
    }
  }
});
