import { Worker } from "node:worker_threads";

/*
 * Laya in a pool of worker threads (roadmap 4.8).
 *
 * Each worker loads its own ONNX session from the same model files
 * (a session cannot be shared between threads), so memory grows
 * with the pool size while the model download/mount is shared.
 * Evaluations then run in parallel, up to the pool size, and never
 * block the event loop that serves claims, leases and the API.
 *
 *   const laya = await LayaPool.load(options, { size: 2 });
 *   await laya.systemOne(state, questions);
 *   await laya.close();
 *
 * It has the same systemOne()/close() surface as a Laya instance.
 * A worker that crashes fails its in-flight call and is replaced.
 *
 * `module` is the module exporting `Laya` (tests pass a fake).
 */
export const DEFAULT_LAYA_MODULE = "@receptron/laya";

const WORKER_URL = new URL("./laya-worker.mjs", import.meta.url);

export class LayaPool {
  static async load(options = {}, { size = 1, module = DEFAULT_LAYA_MODULE } = {}) {
    const pool = new LayaPool({ options: await resolveModelDir(options, module), size, module });
    await pool.#start();
    return pool;
  }

  constructor({ options, size, module }) {
    this.options = options;
    this.size = Math.max(1, Math.floor(Number(size) || 1));
    this.module = module;
    this.workers = [];
    this.nextId = 1;
    this.closed = false;
  }

  async #start() {
    try {
      this.workers = await Promise.all(
        Array.from({ length: this.size }, () => this.#spawn())
      );
    }
    catch (error) {
      await this.close();
      throw error;
    }
  }

  #spawn() {
    const worker = new Worker(WORKER_URL, {
      workerData: { module: this.module, options: this.options }
    });
    const slot = { worker, pending: new Map(), ready: false };

    return new Promise((resolve, reject) => {
      worker.on("message", message => {
        if (message?.type === "ready") {
          slot.ready = true;
          resolve(slot);
          return;
        }

        if (message?.type === "failed") {
          reject(toError(message.error, "Laya failed to load in a worker"));
          return;
        }

        const call = slot.pending.get(message?.id);
        if (!call) return;

        slot.pending.delete(message.id);

        if (message.error) call.reject(toError(message.error));
        else call.resolve(message.result);
      });

      worker.on("error", error => {
        if (!slot.ready) reject(error);
        this.#failed(slot, error);
      });

      worker.on("exit", code => {
        if (!slot.ready) {
          reject(new Error(`Laya worker exited during load (code ${code})`));
          return;
        }

        this.#failed(slot, new Error(`Laya worker exited (code ${code})`));
      });
    });
  }

  // Fail the crashed worker's calls and put a fresh one in its place.
  #failed(slot, error) {
    for (const call of slot.pending.values()) call.reject(error);
    slot.pending.clear();

    const index = this.workers.indexOf(slot);
    if (index === -1 || this.closed) return;

    const replacement = this.#spawn();
    this.workers[index] = { worker: null, pending: new Map(), ready: false, replacing: replacement };

    replacement.then(
      fresh => {
        if (this.closed) {
          fresh.worker.terminate();
          return;
        }
        this.workers[this.workers.findIndex(item => item.replacing === replacement)] = fresh;
      },
      () => {
        // The next call reports the problem; keep the slot for a retry.
      }
    );
  }

  get pending() {
    return this.workers.reduce((sum, slot) => sum + slot.pending.size, 0);
  }

  async systemOne(state, questions) {
    if (this.closed) throw new Error("Laya pool is closed");

    let slot = this.workers
      .filter(item => item.ready)
      .sort((a, b) => a.pending.size - b.pending.size)[0];

    if (!slot) {
      const replacing = this.workers.find(item => item.replacing)?.replacing;
      if (!replacing) throw new Error("No Laya worker is available");
      slot = await replacing;
    }

    const id = this.nextId++;

    return await new Promise((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
      slot.worker.postMessage({ id, state, questions });
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;

    await Promise.all(this.workers.map(async slot => {
      if (!slot.worker) return;

      const exited = new Promise(resolve => slot.worker.once("exit", resolve));
      slot.worker.postMessage({ type: "close" });

      const timer = setTimeout(() => slot.worker.terminate(), 5_000);
      await exited;
      clearTimeout(timer);
    }));

    this.workers = [];
  }
}

/*
 * Download (or find in the cache) the model once, here, and give
 * the workers its directory: workers downloading in parallel would
 * race on the same cache files.
 */
async function resolveModelDir(options, module) {
  if (options.modelDir) return options;

  const { ensureBundle } = await import(module);
  if (typeof ensureBundle !== "function") return options;

  const { modelDir: _ignored, ...download } = options;
  return { ...options, modelDir: await ensureBundle(download) };
}

function toError(serialized, prefix = null) {
  const error = new Error(
    prefix ? `${prefix}: ${serialized?.message}` : serialized?.message ?? "Laya worker error"
  );
  if (serialized?.stack) error.workerStack = serialized.stack;
  return error;
}
