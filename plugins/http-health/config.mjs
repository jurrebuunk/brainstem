export function normalizeChecks(config) {
  if (Array.isArray(config.checks)) {
    return config.checks.map((check, index) =>
      normalizeCheck(check, index, config)
    );
  }

  if (config.url) {
    return [
      normalizeCheck(config, 0, config)
    ];
  }

  throw new Error(
    "HTTP health input requires config.url or config.checks"
  );
}

function normalizeCheck(check, index, defaults) {
  const url = check.url;

  if (!url) {
    throw new Error(
      `HTTP health check ${index} requires url`
    );
  }

  const failureThreshold =
    check.failureThreshold ??
    defaults.failureThreshold ??
    1;

  const recoveryThreshold =
    check.recoveryThreshold ??
    defaults.recoveryThreshold ??
    1;

  validateThreshold(
    failureThreshold,
    `HTTP health check ${index} failureThreshold`
  );

  validateThreshold(
    recoveryThreshold,
    `HTTP health check ${index} recoveryThreshold`
  );

  validateRepeatAfterMs(
    check.repeatAfterMs ?? defaults.repeatAfterMs ?? null,
    `HTTP health check ${index} repeatAfterMs`
  );

  return {
    id:
      check.id ??
      `http-health:${check.name ?? url}`,

    name:
      check.name ?? url,

    url,

    method:
      check.method ??
      defaults.method ??
      "GET",

    timeoutMs:
      check.timeoutMs ??
      defaults.timeoutMs ??
      10_000,

    expectedStatuses:
      check.expectedStatuses ??
      defaults.expectedStatuses ??
      [[200, 399]],

    emitHealthy:
      check.emitHealthy ??
      defaults.emitHealthy ??
      true,

    repeatAfterMs:
      check.repeatAfterMs ??
      defaults.repeatAfterMs ??
      null,

    failureThreshold,
    recoveryThreshold,

    minimumDecisionOnFailure:
      check.minimumDecisionOnFailure ??
      defaults.minimumDecisionOnFailure
  };
}

function validateThreshold(value, name) {
  if (
    !Number.isInteger(value) ||
    value < 1
  ) {
    throw new Error(
      `${name} must be an integer >= 1`
    );
  }
}

function validateRepeatAfterMs(value, name) {
  if (
    value !== null &&
    (
      typeof value !== "number" ||
      value < 0
    )
  ) {
    throw new Error(
      `${name} must be a non-negative number or null`
    );
  }
}
