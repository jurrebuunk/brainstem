/*
 * Stand-in for @receptron/laya in tests (no model download).
 *
 * systemOne answers after `delayMs` (options.delayMs, default 50)
 * with the worker's thread id. A state titled "crash" exits the
 * thread; "fail" throws.
 */
import { threadId } from "node:worker_threads";

export class Laya {
  static async load(options = {}) {
    if (options.failLoad) throw new Error("fake load failure");
    return new Laya(options);
  }

  constructor(options) {
    this.options = options;
  }

  async systemOne(state, questions) {
    if (state?.title === "crash") process.exit(3);
    if (state?.title === "fail") throw new Error("fake evaluation failure");

    await new Promise(resolve => setTimeout(resolve, this.options.delayMs ?? 50));

    const answers = {};
    for (const [name, question] of Object.entries(questions)) {
      answers[name] = question.type === "choice"
        ? { type: "choice", choice: Object.keys(question.criteria ?? { other: "" })[0], probabilities: {} }
        : question.type === "score"
          ? { type: "score", score: 0.5 }
          : { type: "noul", noul: 0.9 };
    }

    return { answers, threadId, modelDir: this.options.modelDir ?? null };
  }

  async close() {}
}
