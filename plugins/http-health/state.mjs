export function applyThresholds(
  check,
  result,
  previous = {},
  now = Date.now()
) {
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
    lastEmittedAt: previous.lastEmittedAt ?? null,
    lastCheckedAt: new Date(now).toISOString()
  };

  if (result.healthy) {
    if (reportedState === "unhealthy") {
      if (consecutiveSuccesses >= check.recoveryThreshold) {
        next.reportedState = "healthy";
        next.lastEmittedAt = next.lastCheckedAt;

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

    const firstHealthy =
      reportedState !== "healthy";

    if (
      firstHealthy &&
      check.emitHealthy !== false
    ) {
      next.lastEmittedAt = next.lastCheckedAt;

      return {
        emit: true,
        stateChanged: true,
        next
      };
    }

    return {
      emit: false,
      stateChanged: firstHealthy,
      next
    };
  }

  if (reportedState === "unhealthy") {
    next.reportedState = "unhealthy";

    if (repeatDue(check, previous, now)) {
      next.lastEmittedAt = next.lastCheckedAt;

      return {
        emit: true,
        stateChanged: false,
        next
      };
    }

    return {
      emit: false,
      stateChanged: false,
      next
    };
  }

  if (consecutiveFailures >= check.failureThreshold) {
    next.reportedState = "unhealthy";
    next.lastEmittedAt = next.lastCheckedAt;

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

function repeatDue(check, previous, now) {
  if (check.repeatAfterMs === null) {
    return false;
  }

  if (!previous.lastEmittedAt) {
    return true;
  }

  return (
    now - Date.parse(previous.lastEmittedAt) >=
    check.repeatAfterMs
  );
}
