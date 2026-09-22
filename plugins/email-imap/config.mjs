export function normalizeConfig(config) {
  const host = required(config.host, "host");
  const user = required(config.user, "user");
  const password = resolvePassword(config);

  if (!password) {
    throw new Error(
      "Email IMAP input requires password, passwordEnv, or password.env"
    );
  }

  return {
    host,
    port: config.port ?? 993,
    secure: config.secure ?? true,
    mailbox: config.mailbox ?? "INBOX",
    user,
    password,
    startFromNow: config.startFromNow ?? true,
    maxMessages: config.maxMessages ?? 25,
    maxBytes: config.maxBytes ?? 8192
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
