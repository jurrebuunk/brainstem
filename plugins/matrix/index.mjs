import { defineDestinationPlugin } from "../../src/sdk/index.mjs";

import { sendRoomMessage } from "./client.mjs";
import { normalizeConfig } from "./config.mjs";
import { formatMessage } from "./message.mjs";
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
          planNotification(ctx, event);

        if (!notification.send) {
          return;
        }

        await sendRoomMessage({
          ...matrix,
          body: formatMessage(
            ctx,
            {
              ...event,
              notification
            }
          ),
          signal: ctx.signal
        });

        notification.commit();
      }
    }
  }
});
