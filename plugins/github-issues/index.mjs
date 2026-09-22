import { defineInputPlugin } from "../../src/sdk/index.mjs";

import { fetchIssues } from "./api.mjs";
import { normalizeConfig } from "./config.mjs";
import { toObservation } from "./observation.mjs";

export default defineInputPlugin({
  apiVersion: "brainstem.input/v1",
  name: "@brainstem/github",

  inputs: {
    issues: {
      mode: "poll",
      defaultIntervalMs: 60_000,

      async *poll(ctx) {
        const config =
          normalizeConfig(ctx.config);

        const issues =
          await fetchIssues(
            config,
            ctx.signal
          );

        for (const issue of issues) {
          if (issue.pull_request) {
            continue;
          }

          yield toObservation(
            ctx,
            config.repo,
            issue
          );
        }
      }
    }
  }
});
