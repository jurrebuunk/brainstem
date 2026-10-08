const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50
};

export function createRuntimeLogger(config = {}) {
  if (config === false) {
    return createSilentLogger();
  }

  const level = normalizeLevel(
    config.level ?? process.env.BRAINSTEM_LOG_LEVEL ?? "info"
  );

  const format = normalizeFormat(
    config.format ?? process.env.BRAINSTEM_LOG_FORMAT ?? "pretty"
  );

  return new RuntimeLogger({
    level,
    format,
    stream: config.stream ?? process.stderr,
    http: normalizeHttpSink(config.http ?? config.sink)
  });
}

export function createSilentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

class RuntimeLogger {
  constructor({ level, format, stream, http }) {
    this.level = level;
    this.format = format;
    this.stream = stream;
    this.http = http;
  }

  debug(message, fields) {
    this.#write("debug", message, fields);
  }

  info(message, fields) {
    this.#write("info", message, fields);
  }

  warn(message, fields) {
    this.#write("warn", message, fields);
  }

  error(message, fields) {
    this.#write("error", message, fields);
  }

  #write(level, message, fields) {
    if (LEVELS[level] < LEVELS[this.level]) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: String(message),
      ...normalizeFields(fields)
    };

    const line = this.format === "json"
      ? JSON.stringify(entry)
      : formatPretty(entry);

    this.stream.write(`${line}\n`);
    this.#sendHttp(entry);
  }

  #sendHttp(entry) {
    if (!this.http) {
      return;
    }

    fetch(this.http.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.http.headers
      },
      body: JSON.stringify({
        version: "1",
        kind: "brainstem.log",
        payload: entry
      })
    }).catch(() => {});
  }
}

function formatPretty(entry) {
  const { timestamp, level, message, ...fields } = entry;
  const suffix = Object.keys(fields).length > 0
    ? ` ${JSON.stringify(fields)}`
    : "";

  return `${timestamp} [brainstem] ${level.toUpperCase()} ${message}${suffix}`;
}

function normalizeFields(fields) {
  if (!fields) {
    return {};
  }

  if (fields instanceof Error) {
    return {
      error: serializeError(fields)
    };
  }

  if (typeof fields !== "object") {
    return {
      value: fields
    };
  }

  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      serializeValue(value)
    ])
  );
}

function serializeValue(value) {
  if (value instanceof Error) {
    return serializeError(value);
  }

  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        serializeValue(item)
      ])
    );
  }

  return value;
}

function serializeError(error) {
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    status: error.status,
    stack: error.stack
  };
}

function normalizeHttpSink(config) {
  if (!config) {
    return null;
  }

  if (typeof config === "string") {
    return {
      url: config,
      headers: {}
    };
  }

  if (
    typeof config !== "object" ||
    typeof config.url !== "string" ||
    config.url.length === 0
  ) {
    throw new Error(
      "Runtime logging HTTP sink requires a url"
    );
  }

  return {
    url: config.url,
    headers: config.headers ?? {}
  };
}

function normalizeLevel(level) {
  if (!Object.hasOwn(LEVELS, level)) {
    throw new Error(
      `Unsupported log level '${level}'. Expected debug, info, warn, error, or silent.`
    );
  }

  return level;
}

function normalizeFormat(format) {
  if (!["pretty", "json"].includes(format)) {
    throw new Error(
      `Unsupported log format '${format}'. Expected pretty or json.`
    );
  }

  return format;
}
