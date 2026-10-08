import { defineDestinationPlugin } from "../../src/sdk/index.mjs";

export default defineDestinationPlugin({
  apiVersion: "brainstem.destination/v1",
  name: "@brainstem/opencode-runner",

  destinations: {
    default: {
      async handle(ctx, event) {
        const config = normalizeConfig(ctx.config);
        const prompt = buildPrompt(config, event);
        const startedAt = Date.now();

        ctx.logger.info?.(
          "opencode api runner started",
          {
            observationId: event.observation.payload.id,
            decision: event.decision.payload.decision,
            route: event.decision.payload.route,
            serverUrl: config.serverUrl
          }
        );

        const session = await createSession(config, event, ctx);

        ctx.logger.info?.(
          "opencode session created",
          {
            sessionId: session.id,
            title: session.title,
            url: `${config.serverUrl}/session/${session.id}`
          }
        );

        const eventStream = streamEvents(config, ctx, session.id);

        try {
          const result = await sendPrompt(
            config,
            session.id,
            prompt,
            ctx
          );

          ctx.logger.info?.(
            "opencode api runner completed",
            {
              observationId: event.observation.payload.id,
              decision: event.decision.payload.decision,
              sessionId: session.id,
              durationMs: Date.now() - startedAt,
              response: summarizeResponse(result)
            }
          );
        }
        finally {
          eventStream.abort();
          await eventStream.done.catch(() => {});
        }
      }
    }
  }
});

function normalizeConfig(config) {
  const serverUrl = (
    config.serverUrl ??
    config.url ??
    config.attach ??
    "http://127.0.0.1:4096"
  ).replace(/\/$/, "");

  return {
    serverUrl,
    directory: config.dir ?? config.directory ?? process.cwd(),
    workspace: config.workspace ?? null,
    title: config.title ?? "Brainstem task",
    agent: config.agent ?? null,
    model: normalizeModel(config.model),
    permission: config.permission ?? null,
    systemPrompt: config.systemPrompt ?? null,
    promptTemplate: config.promptTemplate,
    username: config.username ?? process.env.OPENCODE_SERVER_USERNAME ?? "opencode",
    password: resolvePassword(config),
    headers: config.headers ?? {},
    timeoutMs: config.timeoutMs ?? null,
    eventLogLimit: config.eventLogLimit ?? 200
  };
}

async function createSession(config, event, ctx) {
  const body = {
    title: config.titleForEvent?.(event) ?? config.title
  };

  if (config.agent) body.agent = config.agent;
  if (config.model) body.model = config.model;
  if (config.permission) body.permission = config.permission;

  const response = await apiFetch(
    config,
    "/session",
    {
      method: "POST",
      body,
      signal: ctx.signal
    }
  );

  return await parseJsonResponse(response, "create opencode session");
}

async function sendPrompt(config, sessionId, prompt, ctx) {
  const body = {
    parts: [
      {
        type: "text",
        text: prompt
      }
    ]
  };

  if (config.systemPrompt) body.system = config.systemPrompt;
  if (config.agent) body.agent = config.agent;
  if (config.model) body.model = config.model;

  const signal = timeoutSignal(
    ctx.signal,
    config.timeoutMs
  );

  try {
    const response = await apiFetch(
      config,
      `/session/${encodeURIComponent(sessionId)}/message`,
      {
        method: "POST",
        body,
        signal
      }
    );

    return await parseJsonResponse(response, "send opencode prompt");
  }
  finally {
    signal.clear?.();
  }
}

function streamEvents(config, ctx, sessionId) {
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  let count = 0;

  ctx.signal?.addEventListener(
    "abort",
    relayAbort,
    { once: true }
  );

  const done = (async () => {
    try {
      const response = await apiFetch(
        config,
        "/event",
        {
          method: "GET",
          signal: controller.signal
        }
      );

      if (!response.ok) {
        return;
      }

      for await (const event of sseEvents(response.body)) {
        if (count >= config.eventLogLimit) {
          continue;
        }

        count += 1;

        const data = typeof event.data === "string"
          ? parseJson(event.data) ?? event.data
          : event.data;

        if (
          data &&
          typeof data === "object" &&
          data.sessionID &&
          data.sessionID !== sessionId
        ) {
          continue;
        }

        ctx.logger.debug?.(
          "opencode api event",
          {
            event: event.event ?? null,
            data: summarizeEventData(data),
            raw: data
          }
        );
      }
    }
    catch (error) {
      if (!controller.signal.aborted) {
        ctx.logger.debug?.(
          "opencode event stream ended",
          { error }
        );
      }
    }
    finally {
      ctx.signal?.removeEventListener(
        "abort",
        relayAbort
      );
    }
  })();

  return {
    abort() {
      controller.abort();
    },
    done
  };
}

async function apiFetch(config, path, {
  method,
  body,
  signal
}) {
  const url = new URL(path, `${config.serverUrl}/`);

  if (config.directory) {
    url.searchParams.set("directory", config.directory);
  }

  if (config.workspace) {
    url.searchParams.set("workspace", config.workspace);
  }

  const headers = {
    ...config.headers
  };

  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  if (config.password) {
    headers.authorization =
      `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  }

  return await fetch(url, {
    method,
    signal,
    headers,
    body:
      body === undefined
        ? undefined
        : JSON.stringify(body)
  });
}

async function parseJsonResponse(response, action) {
  const text = await response.text();
  const json = text ? parseJson(text) : null;

  if (!response.ok) {
    throw new Error(
      `Failed to ${action}: ${response.status} ${response.statusText}${text ? ` - ${truncate(text)}` : ""}`
    );
  }

  return json;
}

async function* sseEvents(body) {
  if (!body) return;

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    const messages = buffer.split(/\n\n/);
    buffer = messages.pop() ?? "";

    for (const message of messages) {
      const event = parseSseMessage(message);
      if (event) yield event;
    }
  }

  if (buffer.trim()) {
    const event = parseSseMessage(buffer);
    if (event) yield event;
  }
}

function parseSseMessage(message) {
  const result = {
    event: null,
    data: ""
  };

  for (const line of message.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      result.event = line.slice(6).trim();
    }
    else if (line.startsWith("data:")) {
      result.data += `${line.slice(5).trimStart()}\n`;
    }
  }

  result.data = result.data.replace(/\n$/, "");

  return result.data || result.event
    ? result
    : null;
}

function buildPrompt(config, event) {
  if (typeof config.promptTemplate === "function") {
    return config.promptTemplate(event);
  }

  const observation = event.observation.payload;
  const decision = event.decision.payload;

  return [
    "You are being invoked by Brainstem because an observation was classified as actionable.",
    "Investigate the observation and perform the appropriate coding or operational work.",
    "Be careful, explain what you do, and stop when the task is complete.",
    "",
    "Brainstem decision:",
    JSON.stringify(decision, null, 2),
    "",
    "Observation:",
    JSON.stringify(observation, null, 2)
  ].join("\n");
}

function normalizeModel(value) {
  if (!value) return null;
  if (typeof value === "object") return value;

  const [providerID, ...rest] = String(value).split("/");
  const modelID = rest.join("/");

  return modelID
    ? { providerID, modelID }
    : { modelID: providerID };
}

function timeoutSignal(parentSignal, timeoutMs) {
  if (!timeoutMs) return parentSignal;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  const abort = () => controller.abort();
  parentSignal?.addEventListener("abort", abort, { once: true });

  return Object.assign(controller.signal, {
    clear() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
    }
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  }
  catch {
    return null;
  }
}

function summarizeEventData(data) {
  if (!data || typeof data !== "object") return data;

  return {
    type: data.type ?? data.kind ?? null,
    sessionID: data.sessionID ?? data.sessionId ?? null,
    messageID: data.messageID ?? data.messageId ?? null,
    role: data.role ?? data.message?.role ?? null,
    text: summarizeText(data.text ?? data.message?.text ?? data.content)
  };
}

function summarizeResponse(value) {
  if (!value || typeof value !== "object") return value;

  return {
    messageID: value.info?.id ?? value.id ?? null,
    role: value.info?.role ?? value.role ?? null,
    sessionID: value.info?.sessionID ?? value.sessionID ?? null,
    parts: Array.isArray(value.parts) ? value.parts.length : undefined
  };
}

function summarizeText(value) {
  if (typeof value !== "string") return null;
  return truncate(value, 500);
}

function truncate(value, max = 500) {
  return value.length > max
    ? `${value.slice(0, max)}…`
    : value;
}

function resolvePassword(config) {
  if (typeof config.password === "string") return config.password;
  if (config.passwordEnv) return process.env[config.passwordEnv];
  return process.env.OPENCODE_SERVER_PASSWORD;
}
