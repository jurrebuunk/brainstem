export function normalizeConfig(config) {
  const repo = config.repo;

  if (!repo) {
    throw new Error(
      "GitHub issues input requires config.repo, e.g. 'owner/name'"
    );
  }

  return {
    repo,
    state: config.state ?? "open",
    perPage: config.perPage ?? 100,
    labels: config.labels,
    token: resolveToken(config)
  };
}

function resolveToken(config) {
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

  return process.env.GITHUB_TOKEN;
}
