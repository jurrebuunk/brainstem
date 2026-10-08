import { defineInputPlugin } from "../../src/sdk/index.mjs";

import { fetchIssues } from "./api.mjs";
import { normalizeConfig } from "./config.mjs";
import { toObservation } from "./observation.mjs";
import {
  nextIssueCheckpoint,
  shouldEmitIssueObservation
} from "./state.mjs";

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

        const checkpoint =
          await ctx.checkpoint?.get() ?? {};

        const issues =
          await fetchIssues(
            config,
            ctx.signal
          );

        const observations = [];
        let emitted = 0;

        for (const issue of issues) {
          if (issue.pull_request) {
            continue;
          }

          const observation =
            toObservation(
              ctx,
              config.repo,
              issue
            );

          observations.push(
            observation
          );

          const result =
            shouldEmitIssueObservation({
              config,
              checkpoint,
              observation
            });

          if (result.emit) {
            emitted += 1;
            yield observation;
          }
        }

        ctx.logger?.debug?.(
          "github issues poll result",
          {
            repo: config.repo,
            fetched: issues.length,
            observations: observations.length,
            emitted
          }
        );

        ctx.checkpoint?.defer(
          nextIssueCheckpoint({
            checkpoint,
            observations
          })
        );
      }
    }
  }
});
