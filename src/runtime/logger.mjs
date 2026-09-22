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
    stream: config.stream ?? process.stderr
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
  constructor({ level, format, stream }) {
    this.level = level;
    this.format = format;
    this.stream = stream;
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
