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

          const completion = config.waitForCompletion || config.captureOutput
            ? await waitForSessionIdle(config, session.id, ctx)
                .catch(error => handleCompletionWaitError(config, ctx, error))
            : { skipped: true };

          const messages = await getMessages(config, session.id, ctx)
            .catch(error => ({ error: error.message }));

          logAssistantOutput(ctx, config, session.id, messages);

          ctx.logger.info?.(
            "opencode api runner completed",
            {
              observationId: event.observation.payload.id,
              decision: event.decision.payload.decision,
              sessionId: session.id,
              durationMs: Date.now() - startedAt,
              response: summarizeResponse(result),
              completion,
              messages: summarizeMessages(messages)
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
    waitForCompletion: config.waitForCompletion ?? false,
    captureOutput: config.captureOutput ?? config.logOutput ?? true,
    outputTimeoutMs: config.outputTimeoutMs ?? config.timeoutMs ?? 2 * 60 * 1000,
    outputLogMaxChars: config.outputLogMaxChars ?? 4000,
    statusPollIntervalMs: config.statusPollIntervalMs ?? 1000,
    initialStatusDelayMs: config.initialStatusDelayMs ?? 1000,
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

  const response = await apiFetch(
    config,
    `/session/${encodeURIComponent(sessionId)}/prompt_async`,
    {
      method: "POST",
      body,
      signal: ctx.signal
    }
  );

  await parseJsonResponse(response, "send opencode prompt");

  return {
    accepted: true,
    mode: "prompt_async"
  };
}

async function waitForSessionIdle(config, sessionId, ctx) {
  const signal = timeoutSignal(
    ctx.signal,
    config.outputTimeoutMs
  );

  try {
    await sleep(config.initialStatusDelayMs, signal);

    while (true) {
      const response = await apiFetch(
        config,
        "/session/status",
        {
          method: "GET",
          signal
        }
      );

      const status = await parseJsonResponse(response, "check opencode session status");

      if (!sessionIsBusy(status, sessionId)) {
        return {
          status: "idle",
          raw: status
        };
      }

      await sleep(config.statusPollIntervalMs, signal);
    }
  }
  finally {
    signal.clear?.();
  }
}

async function getMessages(config, sessionId, ctx) {
  const response = await apiFetch(
    config,
    `/session/${encodeURIComponent(sessionId)}/message`,
    {
      method: "GET",
      signal: ctx.signal
    }
  );

  return await parseJsonResponse(response, "fetch opencode messages");
}

function streamEvents(config, ctx, sessionId) {
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  const messageRoles = new Map();
  const partText = new Map();
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
          typeof data === "object"
        ) {
          const dataSessionId = getEventSessionId(data);
          if (dataSessionId && dataSessionId !== sessionId) {
            continue;
          }

          logAssistantOutputEvent(ctx, config, sessionId, data, messageRoles, partText);
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

function handleCompletionWaitError(config, ctx, error) {
  if (isAbortError(error) && !ctx.signal?.aborted && !config.waitForCompletion) {
    return {
      status: "timeout",
      timeoutMs: config.outputTimeoutMs,
      message: "stopped waiting for agent output; the OpenCode session may still continue"
    };
  }

  throw error;
}

function logAssistantOutputEvent(ctx, config, sessionId, data, messageRoles, partText) {
  const info = data.properties?.info ?? data.info;
  if (info?.id && info.role) {
    messageRoles.set(info.id, info.role);
  }

  const part = data.properties?.part ?? data.part;
  if (!part || part.type !== "text" || typeof part.text !== "string") {
    return;
  }

  const messageId = part.messageID ?? part.messageId;
  if (!messageId || messageRoles.get(messageId) !== "assistant") {
    return;
  }

  const partId = part.id ?? messageId;
  const previous = partText.get(partId) ?? "";
  const current = part.text;
  const delta = current.startsWith(previous)
    ? current.slice(previous.length)
    : current;

  partText.set(partId, current);

  if (!delta.trim()) {
    return;
  }

  ctx.logger.info?.(
    "opencode assistant output delta",
    {
      sessionId,
      messageId,
      partId,
      text: truncate(delta, config.outputLogMaxChars),
      truncated: delta.length > config.outputLogMaxChars
    }
  );
}

function logAssistantOutput(ctx, config, sessionId, messages) {
  const output = extractAssistantOutput(messages);

  if (!output?.text) {
    ctx.logger.info?.(
      "opencode assistant output unavailable",
      {
        sessionId,
        reason: Array.isArray(messages)
          ? "no assistant text parts found"
          : messages?.error ?? "messages unavailable"
      }
    );
    return;
  }

  ctx.logger.info?.(
    "opencode assistant output",
    {
      sessionId,
      messageId: output.messageId,
      text: truncate(output.text, config.outputLogMaxChars),
      truncated: output.text.length > config.outputLogMaxChars
    }
  );
}

function extractAssistantOutput(messages) {
  if (!Array.isArray(messages)) return null;

  const assistantMessages = messages.filter(message => message.info?.role === "assistant");
  const message = assistantMessages.at(-1);
  if (!message) return null;

  const text = message.parts
    ?.filter(part => part.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n")
    .trim();

  return text
    ? {
        messageId: message.info?.id ?? null,
        text
      }
    : null;
}

function getEventSessionId(data) {
  return data.sessionID ?? data.sessionId ?? data.properties?.sessionID ?? data.properties?.sessionId ?? null;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function sessionIsBusy(status, sessionId) {
  if (!status) return false;

  if (Array.isArray(status)) {
    return status.some(item => sessionIsBusy(item, sessionId));
  }

  if (typeof status !== "object") return false;

  if (Object.keys(status).length === 0) return false;

  if (status[sessionId]) {
    return statusValueIsBusy(status[sessionId]);
  }

  const statusSessionId =
    status.sessionID ??
    status.sessionId ??
    status.properties?.sessionID ??
    status.properties?.sessionId;

  if (statusSessionId && statusSessionId !== sessionId) {
    return false;
  }

  if (statusSessionId === sessionId) {
    return statusValueIsBusy(
      status.status ??
      status.properties?.status ??
      status
    );
  }

  return Object.values(status).some(value => sessionIsBusy(value, sessionId));
}

function statusValueIsBusy(value) {
  if (!value) return false;
  if (typeof value === "string") {
    return ["busy", "queued", "running"].includes(value);
  }

  if (typeof value !== "object") return false;

  const type = value.type ?? value.status;
  if (typeof type === "string") {
    return ["busy", "queued", "running"].includes(type);
  }

  return Object.values(value).some(statusValueIsBusy);
}

function sleep(ms, signal) {
  if (!ms) return Promise.resolve();

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const timeout = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal?.addEventListener("abort", abort, { once: true });
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
    sessionID: data.sessionID ?? data.sessionId ?? data.properties?.sessionID ?? data.properties?.sessionId ?? null,
    messageID: data.messageID ?? data.messageId ?? data.properties?.messageID ?? data.properties?.messageId ?? null,
    role: data.role ?? data.message?.role ?? data.properties?.info?.role ?? null,
    text: summarizeText(
      data.text ??
      data.message?.text ??
      data.content ??
      data.properties?.part?.text
    )
  };
}

function summarizeResponse(value) {
  if (!value || typeof value !== "object") return value;

  return {
    accepted: value.accepted ?? undefined,
    mode: value.mode ?? undefined,
    messageID: value.info?.id ?? value.id ?? null,
    role: value.info?.role ?? value.role ?? null,
    sessionID: value.info?.sessionID ?? value.sessionID ?? null,
    parts: Array.isArray(value.parts) ? value.parts.length : undefined
  };
}

function summarizeMessages(value) {
  if (!Array.isArray(value)) return value;

  const last = value.at(-1);

  return {
    count: value.length,
    last: last
      ? {
          messageID: last.info?.id ?? null,
          role: last.info?.role ?? null,
          parts: Array.isArray(last.parts) ? last.parts.length : undefined,
          text: summarizeText(
            last.parts
              ?.filter(part => part.type === "text")
              .map(part => part.text)
              .join("\n") ?? ""
          )
        }
      : null
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
