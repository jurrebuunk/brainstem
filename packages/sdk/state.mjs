/*
 * Plugin state: the ctx.state API and an in-memory store (tests,
 * runtimes without a database). The runtime's database-backed store
 * implements the same interface:
 *
 *   get(namespace, key)          -> value | undefined
 *   set(namespace, key, value)   -> value
 *   delete(namespace, key)       -> boolean (whether a value existed)
 *   update(namespace, key, fn)   -> value after the update
 *
 * update() is an atomic read-modify-write: fn(current) receives the
 * current value (undefined when absent) and returns the next value.
 * Returning undefined leaves the stored value unchanged. fn may be
 * called more than once when a concurrent writer wins a race, so it
 * should only compute from its argument.
 */

export class MemoryPluginStateStore {
  #values = new Map();
  #queues = new Map();

  async get(namespace, key) {
    return this.#locked(namespace, key, () => this.#read(namespace, key));
  }

  async set(namespace, key, value) {
    const json = encodeValue(value);

    return this.#locked(namespace, key, () => {
      this.#values.set(storageKey(namespace, key), json);
      return JSON.parse(json);
    });
  }

  async delete(namespace, key) {
    return this.#locked(namespace, key, () =>
      this.#values.delete(storageKey(namespace, key))
    );
  }

  async update(namespace, key, fn) {
    requireFunction(fn);

    return this.#locked(namespace, key, async () => {
      const current = this.#read(namespace, key);
      const next = await fn(current);

      if (next === undefined) {
        return current;
      }

      const json = encodeValue(next);
      this.#values.set(storageKey(namespace, key), json);
      return JSON.parse(json);
    });
  }

  async close() {}

  #read(namespace, key) {
    const json = this.#values.get(storageKey(namespace, key));

    return json === undefined ? undefined : JSON.parse(json);
  }

  async #locked(namespace, key, operation) {
    const id = storageKey(namespace, key);
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);

    this.#queues.set(id, next);

    try {
      return await next;
    }
    finally {
      if (this.#queues.get(id) === next) {
        this.#queues.delete(id);
      }
    }
  }
}

export function encodeValue(value) {
  const json =
    value === undefined
      ? undefined
      : JSON.stringify(value);

  if (json === undefined) {
    throw new TypeError(
      "Plugin state values must be JSON-serializable (use delete() to remove a value)"
    );
  }

  return json;
}

export function requireFunction(fn) {
  if (typeof fn !== "function") {
    throw new TypeError(
      "Plugin state update() requires a function"
    );
  }
}

export function storageKey(namespace, key) {
  return `${namespace}\u0000${key}`;
}

/*
 * Build the namespace a plugin context's state lives in, e.g.
 * "destination:@brainstem/matrix:room" or, when the config entry
 * has an id, "destination:@brainstem/matrix:room:ops-room".
 */
export function pluginStateNamespace({ kind, plugin, name, id } = {}) {
  const parts = [kind, plugin, name];

  if (id !== undefined && id !== null && id !== "") {
    parts.push(String(id));
  }

  return parts.join(":");
}

/*
 * Bind a store to one namespace: the ctx.state plugins see.
 */
export function createPluginState(store, namespace) {
  if (!store) {
    throw new TypeError("createPluginState requires a store");
  }

  return {
    namespace,

    get(key) {
      return store.get(namespace, requireKey(key));
    },

    set(key, value) {
      return store.set(namespace, requireKey(key), value);
    },

    update(key, fn) {
      return store.update(namespace, requireKey(key), fn);
    },

    delete(key) {
      return store.delete(namespace, requireKey(key));
    }
  };
}

function requireKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError(
      "Plugin state keys must be non-empty strings"
    );
  }

  return key;
}
