export function normalizeConfig(config) {
  const homeserver =
    required(config.homeserver, "homeserver")
      .replace(/\/$/, "");

  validateUrl(homeserver, "homeserver");

  const roomId =
    required(config.roomId, "roomId");

  if (!roomId.startsWith("!")) {
    throw new Error(
      "Matrix destination config.roomId should be a Matrix room id starting with '!'"
    );
  }

  const token =
    resolveToken(config);

  if (!token) {
    throw new Error(
      "Matrix destination requires accessToken, tokenEnv, or token.env"
    );
  }

  return {
    homeserver,
    roomId,
    token,
    retry: normalizeRetry(config.retry ?? {}),
    message: normalizeMessage(config.message ?? {}),
    threading: config.threading !== false
  };
}

function normalizeRetry(config) {
  const retry = {
    attempts: config.attempts ?? 3,
    minDelayMs: config.minDelayMs ?? 1_000,
    maxDelayMs: config.maxDelayMs ?? 30_000,
    factor: config.factor ?? 2
  };

  if (retry.attempts < 1) {
    throw new Error(
      "Matrix retry.attempts must be at least 1"
    );
  }

  if (
    retry.minDelayMs < 0 ||
    retry.maxDelayMs < retry.minDelayMs ||
    retry.factor < 1
  ) {
    throw new Error(
      "Matrix retry config must use non-negative delays and factor >= 1"
    );
  }

  return retry;
}

function normalizeMessage(config) {
  const format =
    config.format ?? "text";

  if (!["text", "html"].includes(format)) {
    throw new Error(
      "Matrix message.format must be 'text' or 'html'"
    );
  }

  return {
    format,
    compact: config.compact ?? false
  };
}

function resolveToken(config) {
  if (typeof config.accessToken === "string") {
    return config.accessToken;
  }

  if (typeof config.token === "string") {
    return config.token;
  }

  if (
    config.token &&
    typeof config.token === "object" &&
    typeof config.token.env === "string"
  ) {
    return process.env[config.token.env];
  }

  if (config.tokenEnv) {
    return process.env[config.tokenEnv];
  }

  return process.env.MATRIX_ACCESS_TOKEN;
}

function required(value, name) {
  if (
    typeof value !== "string" ||
    value.length === 0
  ) {
    throw new Error(
      `Matrix destination requires config.${name}`
    );
  }

  return value;
}

function validateUrl(value, name) {
  try {
    new URL(value);
  }
  catch {
    throw new Error(
      `Matrix destination config.${name} must be a valid URL`
    );
  }
}
