import { defineDestinationPlugin } from "../../src/sdk/index.mjs";

import { sendRoomMessage } from "./client.mjs";
import { normalizeConfig } from "./config.mjs";
import { matrixMessageContent } from "./message.mjs";
import { planNotification } from "./notify.mjs";

export default defineDestinationPlugin({
  apiVersion: "brainstem.destination/v1",
  name: "@brainstem/matrix",

  destinations: {
    room: {
      async handle(ctx, event) {
        const matrix =
          normalizeConfig(ctx.config);

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
