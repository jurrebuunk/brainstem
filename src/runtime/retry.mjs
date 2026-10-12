export const DEFAULT_RETRY = {
  attempts: 3,
  minDelayMs: 1_000,
  maxDelayMs: 30_000,
  factor: 2
};

export function normalizeRetry(retry) {
  retry.attempts = Math.max(1, Number(retry.attempts ?? 1));
  retry.minDelayMs = Math.max(0, Number(retry.minDelayMs ?? 0));
  retry.maxDelayMs = Math.max(
    retry.minDelayMs,
    Number(retry.maxDelayMs ?? retry.minDelayMs)
  );
  retry.factor = Math.max(1, Number(retry.factor ?? 1));
  return retry;
}

export function sleep(ms, signal) {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    const timeout = setTimeout(resolve, ms);

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}
