import { parentPort, workerData } from "node:worker_threads";

/*
 * One Laya session in a worker thread (see laya-pool.mjs).
 *
 *   workerData: { module, options }
 *   in:  { id, state, questions }   |  { type: "close" }
 *   out: { type: "ready" } | { type: "failed", error }
 *        { id, result } | { id, error }
 */
const { module, options } = workerData;

let laya = null;

try {
  const { Laya } = await import(module);
  laya = await Laya.load(options);
  parentPort.postMessage({ type: "ready" });
}
catch (error) {
  parentPort.postMessage({ type: "failed", error: serializeError(error) });
  process.exit(1);
}

parentPort.on("message", async message => {
  if (message?.type === "close") {
    await laya?.close().catch(() => {});
    laya = null;
    parentPort.close();
    return;
  }

  try {
    const result = await laya.systemOne(message.state, message.questions);
    parentPort.postMessage({ id: message.id, result });
  }
  catch (error) {
    parentPort.postMessage({ id: message.id, error: serializeError(error) });
  }
});

function serializeError(error) {
  return {
    message: error?.message ?? String(error),
    stack: error?.stack ?? null
  };
}
