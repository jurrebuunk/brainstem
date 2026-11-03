import { defineDestinationPlugin } from "@brainstem-dev/sdk";

import { sendRoomMessage } from "./client.mjs";
import { normalizeConfig } from "./config.mjs";
import { matrixMessageContent } from "./message.mjs";
import { planNotification } from "./notify.mjs";

export default defineDestinationPlugin({
  apiVersion: "brainstem.destination/v2",
  name: "@brainstem/matrix",

  destinations: {
    room: {
      async handle(ctx, output) {
        const matrix =
          normalizeConfig(ctx.config);

        // { decision, observation, pollId, input, destination }
        const event =
          output.payload;

        const notification =
          await planNotification(ctx, event);

        const observationId =
          event.observation.payload.id;

        if (!notification.send) {
          ctx.logger.debug?.(
            "matrix notification suppressed",
            {
              observationId
            }
          );

          return;
        }

        let result;

        try {
          result =
            await sendRoomMessage({
              ...matrix,
              // Same txnId on every retry: Matrix drops the duplicate.
              txnId: ctx.idempotencyKey,
              content: matrixMessageContent(
                ctx,
                {
                  ...event,
                  notification
                }
              ),
              signal: ctx.signal
            });
        }
        catch (error) {
          await notification.release()
            .catch(releaseError => {
              ctx.logger.warn?.(
                "matrix notification claim release failed",
                {
                  observationId,
                  error: releaseError
                }
              );
            });

          throw error;
        }

        await notification.commit({
          eventId: result.eventId
        });

        ctx.logger.info?.(
          "matrix notification sent",
          {
            observationId,
            kind: notification.kind,
            eventId: result.eventId
          }
        );
      }
    }
  }
});
