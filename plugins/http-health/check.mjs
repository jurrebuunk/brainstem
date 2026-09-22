export async function runCheck(check, parentSignal) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      check.timeoutMs
    );

  const abort = () =>
    controller.abort();

  parentSignal?.addEventListener(
    "abort",
    abort,
    { once: true }
  );

  try {
    const response =
      await fetch(check.url, {
        method: check.method,
        signal: controller.signal
      });

    const healthy =
      statusMatches(
        response.status,
        check.expectedStatuses
      );

    return {
      healthy,
      status: response.status,
      statusText: response.statusText,
      error: null
    };
  }
  catch (error) {
    return {
      healthy: false,
      status: null,
      statusText: null,
      error:
        error.name === "AbortError"
          ? "timeout_or_aborted"
          : error.message
    };
  }
  finally {
    clearTimeout(timeout);

    parentSignal?.removeEventListener(
      "abort",
      abort
    );
  }
}

function statusMatches(status, expectedStatuses) {
  return expectedStatuses.some(expected => {
    if (typeof expected === "number") {
      return status === expected;
    }

    if (
      Array.isArray(expected) &&
      expected.length === 2
    ) {
      return (
        status >= expected[0] &&
        status <= expected[1]
      );
    }

    throw new Error(
      "expectedStatuses entries must be numbers or [min, max] ranges"
    );
  });
}
