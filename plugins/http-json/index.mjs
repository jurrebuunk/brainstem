import { defineDestinationPlugin } from "../../src/sdk/index.mjs";

export default defineDestinationPlugin({
  apiVersion: "brainstem.destination/v2",
  name: "@brainstem/http-json",

  destinations: {
    default: {
      /*
       * POSTs the brainstem.output envelope as-is. The
       * Idempotency-Key header is the same on every retry of
       * one delivery, so the receiver can drop duplicates.
       * With tracing on, `traceparent` continues the trace.
       */
      async handle(ctx, output) {
        const config = normalizeConfig(ctx.config);

        const response = await fetch(config.url, {
          method: config.method,
          signal: ctx.signal,
          headers: {
            "content-type": "application/json",
            ...(ctx.idempotencyKey ? { "idempotency-key": ctx.idempotencyKey } : {}),
            ...(ctx.traceparent ? { traceparent: ctx.traceparent } : {}),
            ...config.headers
          },
          body: JSON.stringify(output)
        });

        if (!response.ok) {
          const body = await response.text()
            .catch(() => "");

          throw new Error(
            `HTTP JSON destination failed: ${response.status} ${response.statusText}${body ? ` - ${truncate(body)}` : ""}`
          );
        }

        ctx.logger.debug?.(
          "http-json destination sent envelope",
          {
            url: config.url,
            observationId: output.payload.observation.payload.id,
            decision: output.payload.decision.payload.decision,
            idempotencyKey: ctx.idempotencyKey
          }
        );
      }
    }
  }
});

function normalizeConfig(config) {
  const url = required(config.url, "url");

  try {
    new URL(url);
  }
  catch {
    throw new Error(
      "HTTP JSON destination config.url must be a valid URL"
    );
  }

  return {
    url,
    method: config.method ?? "POST",
    headers: config.headers ?? {}
  };
}

function required(value, name) {
  if (
    typeof value !== "string" ||
    value.length === 0
  ) {
    throw new Error(
      `HTTP JSON destination requires config.${name}`
    );
  }

  return value;
}

function truncate(value, max = 500) {
  return value.length > max
    ? `${value.slice(0, max)}…`
    : value;
}
