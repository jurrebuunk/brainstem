export function normalizeConfig(config) {
  const homeserver =
    required(config.homeserver, "homeserver")
      .replace(/\/$/, "");

  const roomId =
    required(config.roomId, "roomId");

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
    token
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
