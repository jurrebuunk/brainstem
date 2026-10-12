export function createTelemetrySink(config) {
  if (!config) return null;

  const url = typeof config === "string" ? config : config.url;
  if (!url) return null;

  const headers = typeof config === "object" ? config.headers ?? {} : {};

  return {
    send(event) {
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers
        },
        body: JSON.stringify(event)
      }).catch(() => {});
    }
  };
}

export function telemetryValue(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: value.code,
      status: value.status,
      stack: value.stack
    };
  }

  if (Array.isArray(value)) return value.map(telemetryValue);

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, telemetryValue(item)])
    );
  }

  return value;
}

export function telemetryEvent(kind, payload = {}) {
  return {
    version: "1",
    kind,
    payload: {
      timestamp: new Date().toISOString(),
      ...payload
    }
  };
}
