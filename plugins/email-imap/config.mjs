export function normalizeConfig(config) {
  const host = required(config.host, "host");
  const user = required(config.user, "user");
  const password = resolvePassword(config);

  if (!password) {
    throw new Error(
      "Email IMAP input requires password, passwordEnv, or password.env"
    );
  }

  const maxMessages = config.maxMessages ?? 25;
  const maxBytes = config.maxBytes ?? 8192;

  validatePositiveInteger(maxMessages, "maxMessages");
  validatePositiveInteger(maxBytes, "maxBytes");

  return {
    host,
    port: config.port ?? 993,
    secure: config.secure ?? true,
    mailbox: config.mailbox ?? "INBOX",
    user,
    password,
    startFromNow: config.startFromNow ?? true,
    maxMessages,
    maxBytes,
    timeoutMs: config.timeoutMs ?? 10_000
  };
}

function resolvePassword(config) {
  if (typeof config.password === "string") {
    return config.password;
  }

  if (
    config.password &&
    typeof config.password === "object" &&
    typeof config.password.env === "string"
  ) {
    return process.env[config.password.env];
  }

  if (config.passwordEnv) {
    return process.env[config.passwordEnv];
  }

  return process.env.EMAIL_PASSWORD;
}

function required(value, name) {
  if (
    typeof value !== "string" ||
    value.length === 0
  ) {
    throw new Error(
      `Email IMAP input requires config.${name}`
    );
  }

  return value;
}

function validatePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `Email IMAP input config.${name} must be an integer >= 1`
    );
  }
}
