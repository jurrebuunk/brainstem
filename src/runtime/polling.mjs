export async function* toAsyncIterable(value) {
  const resolved = await value;

  if (!resolved) return;

  if (typeof resolved[Symbol.asyncIterator] === "function") {
    yield* resolved;
    return;
  }

  if (typeof resolved[Symbol.iterator] === "function") {
    for (const item of resolved) {
      yield item;
    }
    return;
  }

  throw new TypeError(
    "poll(ctx) must return an iterable, async iterable, or array of observations"
  );
}

export function checkpointKeyForEntry(entry, plugin, inputName, index) {
  return entry.id ?? `${plugin.name}.${inputName}.${index}`;
}
