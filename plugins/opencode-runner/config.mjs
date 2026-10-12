export function normalizeConfig(config) {
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

function normalizeModel(value) {
  if (!value) return null;
  if (typeof value === "object") return value;

  const [providerID, ...rest] = String(value).split("/");
  const modelID = rest.join("/");

  return modelID
    ? { providerID, modelID }
    : { modelID: providerID };
}

function resolvePassword(config) {
  if (typeof config.password === "string") return config.password;
  if (config.passwordEnv) return process.env[config.passwordEnv];
  return process.env.OPENCODE_SERVER_PASSWORD;
}
