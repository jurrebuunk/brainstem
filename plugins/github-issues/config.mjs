export function normalizeConfig(config) {
  const repo = config.repo;

  if (!repo) {
    throw new Error(
      "GitHub issues input requires config.repo, e.g. 'owner/name'"
    );
  }

  const perPage = config.perPage ?? 100;
  const maxPages = config.maxPages ?? 10;

  validatePositiveInteger(perPage, "perPage");
  validatePositiveInteger(maxPages, "maxPages");

  return {
    repo,
    state: config.state ?? "all",
    perPage: Math.min(perPage, 100),
    maxPages,
    labels: config.labels,
    sort: config.sort ?? "updated",
    direction: config.direction ?? "desc",
    startFromNow: config.startFromNow ?? true,
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

function validatePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `GitHub issues input config.${name} must be an integer >= 1`
    );
  }
}
