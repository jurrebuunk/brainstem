export function normalizeTargets(config) {
  if (Array.isArray(config.targets)) {
    return config.targets.map((target, index) =>
      normalizeTarget(target, index, config)
    );
  }

  if (config.host) {
    return [
      normalizeTarget(config, 0, config)
    ];
  }

  throw new Error(
    "TLS certificate input requires config.host or config.targets"
  );
}

function normalizeTarget(target, index, defaults) {
  const host = target.host;

  if (!host) {
    throw new Error(
      `TLS certificate target ${index} requires host`
    );
  }

  const port =
    target.port ??
    defaults.port ??
    443;

  const warnDays =
    target.warnDays ??
    defaults.warnDays ??
    14;

  const criticalDays =
    target.criticalDays ??
    defaults.criticalDays ??
    3;

  validatePositiveInteger(port, `TLS certificate target ${index} port`);
  validateNonNegativeNumber(warnDays, `TLS certificate target ${index} warnDays`);
  validateNonNegativeNumber(criticalDays, `TLS certificate target ${index} criticalDays`);

  if (criticalDays > warnDays) {
    throw new Error(
      `TLS certificate target ${index} criticalDays must be <= warnDays`
    );
  }

  return {
    id:
      target.id ??
      `tls:${host}:${port}`,

    name:
      target.name ?? host,

    host,
    port,

    servername:
      target.servername ??
      defaults.servername ??
      host,

    timeoutMs:
      target.timeoutMs ??
      defaults.timeoutMs ??
      10_000,

    warnDays,
    criticalDays,

    checkAuthorization:
      target.checkAuthorization ??
      defaults.checkAuthorization ??
      true,

    emitHealthy:
      target.emitHealthy ??
      defaults.emitHealthy ??
      true,

    minimumDecisionOnWarning:
      target.minimumDecisionOnWarning ??
      defaults.minimumDecisionOnWarning ??
      "queue",

    minimumDecisionOnCritical:
      target.minimumDecisionOnCritical ??
      defaults.minimumDecisionOnCritical ??
      "dispatch"
  };
}

function validatePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${name} must be an integer >= 1`
    );
  }
}

function validateNonNegativeNumber(value, name) {
  if (typeof value !== "number" || value < 0) {
    throw new Error(
      `${name} must be a non-negative number`
    );
  }
}
