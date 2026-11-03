import { defineDestinationPlugin } from "@brainstem-dev/sdk";

export default defineDestinationPlugin({
  apiVersion: "brainstem.destination/v2",
  name: "@brainstem/log-decisions",

  destinations: {
    default: {
      async handle(ctx, output) {
        const event =
          output.payload;

        const decision =
          event.decision.payload.decision;

        const observationId =
          event.observation.payload.id;

        const prefix =
          ctx.config.prefix ?? "brainstem";

        console.log(
          `\n[${prefix}] ${observationId} -> ${decision}`
        );

        console.dir(event.decision, {
          depth: null,
          colors: ctx.config.colors ?? true
        });
      }
    }
  }
});
