export function applyThresholds(check, result, previous = {}) {
  const consecutiveSuccesses = result.healthy
    ? (previous.consecutiveSuccesses ?? 0) + 1
    : 0;

  const consecutiveFailures = result.healthy
    ? 0
    : (previous.consecutiveFailures ?? 0) + 1;

  const reportedState =
    previous.reportedState ?? null;

  const next = {
    reportedState,
    consecutiveSuccesses,
    consecutiveFailures,
    lastCheckedAt: new Date().toISOString()
  };

  if (result.healthy) {
    if (reportedState === "unhealthy") {
      if (consecutiveSuccesses >= check.recoveryThreshold) {
        next.reportedState = "healthy";

        return {
          emit: true,
          stateChanged: true,
          next
        };
      }

      return {
        emit: false,
        stateChanged: false,
        next
      };
    }

    next.reportedState = "healthy";

    return {
      emit: check.emitHealthy !== false,
      stateChanged: reportedState !== "healthy",
      next
    };
  }

  if (reportedState === "unhealthy") {
    next.reportedState = "unhealthy";

    return {
      emit: true,
      stateChanged: false,
      next
    };
  }

  if (consecutiveFailures >= check.failureThreshold) {
    next.reportedState = "unhealthy";

    return {
      emit: true,
      stateChanged: true,
      next
    };
  }

  return {
    emit: false,
    stateChanged: false,
    next
  };
}
