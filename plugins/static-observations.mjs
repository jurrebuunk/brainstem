import { defineInputPlugin } from "../sdk.mjs";

export default defineInputPlugin({
  apiVersion: "brainstem.input/v1",
  name: "@brainstem/static-observations",

  inputs: {
    default: {
      mode: "poll",
      defaultIntervalMs: 60_000,

      async *poll(ctx) {
        for (const observation of ctx.config.observations ?? []) {
          yield ctx.observation(observation);
        }
      }
    }
  }
});
