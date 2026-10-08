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
            yield observation;
          }
        }

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
