/*
 * Child process for plugin state concurrency tests: performs
 * `count` atomic increments of one key against a shared database.
 *
 *   node plugin-state-worker.mjs <database url> <count>
 */
import { openDatabase } from "../../src/db/database.mjs";
import { DatabasePluginStateStore } from "../../src/runtime/plugin-state.mjs";

const [url, count] = process.argv.slice(2);
const handle = await openDatabase({ url });

try {
  const store = new DatabasePluginStateStore(handle);

  for (let index = 0; index < Number(count); index += 1) {
    await store.update("counter", "value", async current => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return (current ?? 0) + 1;
    });
  }
}
finally {
  await handle.close();
}
