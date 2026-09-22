export async function sendRoomMessage({
  homeserver,
  roomId,
  token,
  content,
  retry,
  signal
}) {
  return await withRetry(
    retry,
    signal,
    () => sendOnce({
      homeserver,
      roomId,
      token,
      content,
      signal
    })
  );
}

async function sendOnce({
  homeserver,
  roomId,
  token,
  content,
  signal
}) {
  const txnId =
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const url =
    `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`;

  const response =
    await fetch(url, {
      method: "PUT",
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(content)
    });

  if (!response.ok) {
    const body =
      await response.text()
        .catch(() => "");

    throw matrixError(response, body);
  }

  const json = typeof response.json === "function"
    ? await response.json()
        .catch(() => ({}))
    : {};

  return {
    eventId: json.event_id ?? null
  };
}

async function withRetry(retry, signal, fn) {
  let delayMs = retry.minDelayMs;
  let lastError;

  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    try {
      return await fn();
    }
    catch (error) {
      lastError = error;

      if (
        signal?.aborted ||
        attempt >= retry.attempts ||
        !isRetryable(error)
      ) {
        throw error;
      }

      const waitMs =
        error.retryAfterMs ?? delayMs;

      await sleep(waitMs, signal);

      delayMs = Math.min(
        retry.maxDelayMs,
        delayMs * retry.factor
      );
    }
  }

  throw lastError;
}

function matrixError(response, body) {
  let parsed = null;

  try {
    parsed = body ? JSON.parse(body) : null;
  }
  catch {}

  const message =
    parsed?.error ?? body;

  const error = new Error(
    `Matrix send failed: ${response.status} ${response.statusText}${message ? ` - ${message}` : ""}`
  );

  error.status = response.status;

  if (response.status === 429) {
    error.retryAfterMs =
      parsed?.retry_after_ms ??
      retryAfterHeaderMs(response.headers?.get?.("retry-after"));
  }

  return error;
}

function isRetryable(error) {
  return (
    error.status === 429 ||
    error.status >= 500 ||
    error.status === undefined
  );
}

function retryAfterHeaderMs(value) {
  if (!value) {
    return null;
  }

  const seconds = Number(value);

  return Number.isFinite(seconds)
    ? seconds * 1000
    : null;
}

function sleep(ms, signal) {
  if (!ms || ms <= 0 || signal?.aborted) {
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
