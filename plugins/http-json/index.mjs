import { defineDestinationPlugin } from "../../src/sdk/index.mjs";

export default defineDestinationPlugin({
  apiVersion: "brainstem.destination/v1",
  name: "@brainstem/http-json",

  destinations: {
    default: {
      async handle(ctx, event) {
        const config = normalizeConfig(ctx.config);
        const envelope = outputEnvelope(event);

        const response = await fetch(config.url, {
          method: config.method,
          signal: ctx.signal,
          headers: {
            "content-type": "application/json",
            ...config.headers
          },
          body: JSON.stringify(envelope)
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
            observationId: event.observation.payload.id,
            decision: event.decision.payload.decision
          }
        );
      }
    }
  }
});

function outputEnvelope(event) {
  return {
    version: "1",
    kind: "brainstem.output",
    payload: {
      timestamp: new Date().toISOString(),
      decision: event.decision,
      observation: event.observation,
      input: {
        plugin: event.input.plugin.name,
        name: event.input.name,
        id: event.input.entry.id ?? null,
        module: event.input.entry.module ?? null
      },
      destination: {
        plugin: event.destination.plugin.name,
        name: event.destination.name,
        module: event.destination.entry.module ?? null
      }
    }
  };
}

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
