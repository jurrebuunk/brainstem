import { defineInputPlugin } from "../../src/sdk/index.mjs";

import { normalizeConfig } from "./config.mjs";
import { fetchNewMessages } from "./imap.mjs";
import { toObservation } from "./observation.mjs";

export default defineInputPlugin({
  apiVersion: "brainstem.input/v1",
  name: "@brainstem/email-imap",

  inputs: {
    messages: {
      mode: "poll",
      defaultIntervalMs: 60_000,

      async *poll(ctx) {
        const config = normalizeConfig(ctx.config);
        const checkpoint = await ctx.checkpoint.get();

        const result = await fetchNewMessages(
          config,
          checkpoint ?? {}
        );

        ctx.logger?.debug?.(
          "email-imap poll result",
          {
            user: config.user,
            messages: result.messages.length,
            checkpointUid: result.checkpoint.lastUid
          }
        );

        for (const message of result.messages) {
          yield toObservation(ctx, config, message);
        }

        ctx.checkpoint.defer(result.checkpoint);
      }
    }
  }
});
