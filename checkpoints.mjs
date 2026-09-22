import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class MemoryCheckpointStore {
  constructor(initial = {}) {
    this.data = structuredClone(initial);
  }

  async get(key) {
    return clone(
      this.data[key]
    );
  }

  async set(key, value) {
    assertJsonValue(value);

    if (value === null) {
      delete this.data[key];
      return;
    }

    this.data[key] = clone(value);
  }

  async close() {}
}

export class JsonFileCheckpointStore extends MemoryCheckpointStore {
  constructor(path) {
    super();

    this.path = path;
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  async get(key) {
    await this.#load();

    return super.get(key);
  }

  async set(key, value) {
    await this.#load();
    await super.set(key, value);
    await this.#write();
  }

  async close() {
    await this.writeQueue;
  }

  async #load() {
    if (this.loaded) {
      return;
    }

    try {
      const text =
        await readFile(this.path, "utf8");

      this.data = JSON.parse(text);
    }
    catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      this.data = {};
    }

    this.loaded = true;
  }

  async #write() {
    this.writeQueue =
      this.writeQueue.then(async () => {
        await mkdir(dirname(this.path), {
          recursive: true
        });

        const temporaryPath =
          `${this.path}.tmp`;

        await writeFile(
          temporaryPath,
          JSON.stringify(this.data, null, 2) + "\n"
        );

        await rename(
          temporaryPath,
          this.path
        );
      });

    await this.writeQueue;
  }
}

export function createDeferredCheckpoint({
  store,
  key
}) {
  let pending = false;
  let pendingValue;

  return {
    api: {
      get() {
        return store.get(key);
      },

      defer(value) {
        assertJsonValue(value);

        pending = true;
        pendingValue = clone(value);
      }
    },

    async commit() {
      if (!pending) {
        return;
      }

      await store.set(
        key,
        pendingValue
      );
    }
  };
}

export function assertJsonValue(value, path = "checkpoint") {
  if (value === undefined) {
    throw new TypeError(
      `${path} cannot be undefined`
    );
  }

  if (value === null) {
    return;
  }

  const type = typeof value;

  if (
    type === "string" ||
    type === "boolean"
  ) {
    return;
  }

  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `${path} must be a finite number`
      );
    }

    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertJsonValue(
        item,
        `${path}[${index}]`
      )
    );

    return;
  }

  if (type === "object") {
    const prototype =
      Object.getPrototypeOf(value);

    if (
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new TypeError(
        `${path} must be plain JSON data`
      );
    }

    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(
        item,
        `${path}.${key}`
      );
    }

    return;
  }

  throw new TypeError(
    `${path} must be JSON-serializable`
  );
}

function clone(value) {
  return value === undefined
    ? undefined
    : structuredClone(value);
}
