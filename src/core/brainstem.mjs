import { createHash } from "node:crypto";
import { DEFAULT_LAYA_MODULE, LayaPool } from "./laya-pool.mjs";
import { createObservation } from "@brainstem-dev/sdk";

import {
  MemoryRecordStore,
  RecordConflictError
} from "./record-stores.mjs";

const VERSION = "1";

/*
 * How often a conflicting record write is
 * re-read and retried before the conflict is
 * raised.
 */
const MAX_WRITE_ATTEMPTS = 3;

const DECISIONS = [
  "ignore",
  "queue",
  "dispatch",
  "escalate"
];


export class Brainstem {
  constructor(config, {
    store,
    cacheKey,
    layaModule = DEFAULT_LAYA_MODULE
  } = {}) {
    this.config =
      structuredClone(config);

    this.cacheKey =
      cacheKey ?? cacheKeyOf(
        this.config
      );

    this.laya = null;

    this.records =
      store ?? new MemoryRecordStore();

    /*
     * Per-observation locks.
     *
     * Updates for the same ID are always
     * processed in arrival order.
     */
    this.locks =
      new Map();

    this.layaModule = layaModule;

    /*
     * Semantic evaluations in flight.
     *
     * With Laya in this thread one changed
     * observation uses it at a time; with a
     * worker pool (runtime.laya.workers) up to
     * one per worker. Cached observations never
     * wait here.
     */
    this.evaluations = new Set();
    this.evaluationWaiters = [];
    this.evaluationConcurrency = 1;
  }

  /*
   * Laya workers (runtime.laya.workers or
   * BRAINSTEM_LAYA_WORKERS). 0 runs Laya in
   * this thread.
   */
  get layaWorkers() {
    const value =
      this.config.runtime?.laya?.workers ??
      process.env.BRAINSTEM_LAYA_WORKERS ??
      0;

    return Math.max(0, Math.floor(Number(value) || 0));
  }


  async start() {
    /*
     * Open the record store first so an
     * unreachable database fails fast (the
     * runtime's startup retry covers it).
     */
    await this.records.open?.();

    if (!this.laya) {
      await this.#loadLaya();
    }
  }


  async #loadLaya() {
    const options =
      layaLoadOptionsFromConfig(
        this.config
      );
    const workers =
      this.layaWorkers;

    if (workers > 0) {
      this.laya =
        await LayaPool.load(options, {
          size: workers,
          module: this.layaModule
        });
    }
    else {
      const { Laya } =
        await import(this.layaModule);

      this.laya =
        await Laya.load(options);
    }

    this.layaOptionsKey =
      JSON.stringify({ options, workers });
    this.evaluationConcurrency =
      Math.max(1, workers);
  }


  /*
   * Apply a new config (hot reload). Policy and
   * questions take effect for the next
   * evaluation; the model is reloaded only when
   * its load options or worker count changed.
   * Call it while no observation is in flight.
   */
  async reconfigure(config) {
    this.config =
      structuredClone(config);

    this.cacheKey =
      cacheKeyOf(this.config);

    if (!this.laya) return;

    const key =
      JSON.stringify({
        options: layaLoadOptionsFromConfig(this.config),
        workers: this.layaWorkers
      });

    if (key === this.layaOptionsKey) return;

    await Promise.allSettled([...this.evaluations]);
    await this.laya.close();
    this.laya = null;
    await this.#loadLaya();
  }


  async close() {
    /*
     * Wait for currently active observation
     * chains.
     */
    await Promise.all(
      this.locks.values()
    );

    /*
     * Wait for running evaluations.
     */
    await Promise.allSettled(
      [...this.evaluations]
    );

    await this.laya?.close();
    await this.records?.close?.();

    this.laya = null;
  }


  process(observation) {
    /*
     * Clone immediately.
     *
     * The caller can safely modify their
     * original object after process().
     */
    const input =
      structuredClone(
        observation
      );

    const id =
      input.payload.id;


    /*
     * Serialize updates for the same ID.
     */
    const previous =
      this.locks.get(id) ??
      Promise.resolve();

    const current =
      previous
        .catch(() => {})
        .then(() =>
          this.#process(
            input
          )
        );


    this.locks.set(
      id,
      current
    );


    /*
     * Remove completed lock without deleting
     * a newer chain for the same ID.
     */
    const cleanup = () => {
      if (
        this.locks.get(id) ===
        current
      ) {
        this.locks.delete(id);
      }
    };

    current.then(
      cleanup,
      cleanup
    );


    return current;
  }


  async #process(observation) {
    if (!this.laya) {
      throw new Error(
        "Brainstem has not been started"
      );
    }


    const payload =
      observation.payload;

    const fingerprint =
      fingerprintOf(
        payload
      );

    const existing =
      await this.records.get(
        payload.id
      );

    const now =
      new Date().toISOString();


    /*
     * Nothing meaningful changed and the
     * current decision cache is still valid.
     *
     * Store the newest observation so the
     * latest observation timestamp/state is
     * available, but reuse the old decision.
     */
    if (
      existing?.fingerprint ===
        fingerprint &&
      existing.cache_key ===
        this.cacheKey
    ) {
      await this.records.touch(
        payload.id,
        {
          observation:
            structuredClone(
              observation
            ),
          lastSeenAt: now
        }
      );

      return structuredClone(
        existing.decision
      );
    }


    /*
     * Changed observations enter the global
     * semantic evaluation queue.
     *
     * The entire evaluation owns Laya until
     * it has:
     *
     * - gathered required signals
     * - made the decision
     * - determined the route if required
     */
    const evaluation =
      await this.#queueEvaluation(
        payload
      );


    return await this.#storeDecision({
      observation,
      fingerprint,
      existing,
      evaluation,
      now
    });
  }


  /*
   * Build and store the decision record.
   *
   * The write is an upsert guarded by an
   * optimistic revision check: it only lands
   * when the stored revision is still the one
   * this evaluation started from.
   *
   * Inside one process the per-ID lock means
   * the check always passes. It is groundwork
   * for multi-core compare-and-swap: when
   * another core wrote the record meanwhile,
   * re-read it and
   *
   * - adopt its decision when it already
   *   covers this exact state, or
   * - recompute the revision on top of it and
   *   retry (without re-evaluating Laya).
   *
   * After MAX_WRITE_ATTEMPTS the conflict is
   * raised to the caller.
   */
  async #storeDecision({
    observation,
    fingerprint,
    existing,
    evaluation,
    now
  }) {
    const payload =
      observation.payload;

    let previous =
      existing;

    for (let attempt = 1; ; attempt += 1) {
      const revision = previous
        ? (
            previous.fingerprint ===
            fingerprint
              ? previous.revision
              : previous.revision + 1
          )
        : 1;

      const decision =
        decisionOf({
          payload,
          revision,
          fingerprint,
          evaluation
        });

      try {
        /*
         * Store private copies.
         */
        await this.records.put(
          {
            id: payload.id,
            revision,
            fingerprint,
            cache_key: this.cacheKey,

            observation:
              structuredClone(
                observation
              ),

            decision:
              structuredClone(
                decision
              ),

            first_seen_at:
              previous?.first_seen_at ?? now,

            last_seen_at:
              now,

            updated_at:
              now
          },
          {
            expectedRevision:
              previous?.revision ?? null
          }
        );

        return structuredClone(
          decision
        );
      }
      catch (error) {
        if (
          !(error instanceof RecordConflictError) ||
          attempt >= MAX_WRITE_ATTEMPTS
        ) {
          throw error;
        }

        previous =
          await this.records.get(
            payload.id
          );

        if (
          previous?.fingerprint ===
            fingerprint &&
          previous.cache_key ===
            this.cacheKey
        ) {
          return structuredClone(
            previous.decision
          );
        }
      }
    }
  }


  /*
   * Evaluation limiter.
   *
   * Each slot is one complete changed
   * observation, not one question, so all
   * questions of an observation stay together.
   */
  async #queueEvaluation(
    observation
  ) {
    while (
      this.evaluations.size >=
      this.evaluationConcurrency
    ) {
      await new Promise(resolve =>
        this.evaluationWaiters.push(resolve)
      );
    }

    const run =
      this.#evaluate(
        observation
      );

    this.evaluations.add(run);

    try {
      return await run;
    }
    finally {
      this.evaluations.delete(run);
      this.evaluationWaiters.shift()?.();
    }
  }


  /*
   * Complete semantic evaluation.
   *
   * Holds one evaluation slot (see
   * #queueEvaluation) until it returns.
   */
  async #evaluate(
    observation
  ) {
    const policy =
      this.config.policy;


    /*
     * These two signals are always required.
     */
    const attentionAnswer =
      await this.#ask(
        observation,
        "attention"
      );

    const actionableAnswer =
      await this.#ask(
        observation,
        "actionable"
      );


    const judgement = {
      attention:
        attentionAnswer.noul,

      actionable:
        actionableAnswer.noul,

      severity:
        null,

      route:
        null,

      routeConfidence:
        null
    };


    /*
     * Determine whether severity can still
     * affect the decision.
     *
     * Case 1:
     * Dispatch is already guaranteed.
     *
     * Severity is unnecessary.
     */
    const dispatch =
      judgement.attention >=
        policy.dispatch.attention &&
      judgement.actionable >=
        policy.dispatch.actionable;


    /*
     * Case 2:
     * actionableQueue already guarantees
     * queue.
     *
     * Severity is also unnecessary.
     */
    const queueGuaranteed =
      judgement.actionable >=
        policy.actionableQueue.actionable;


    /*
     * Case 3:
     * Queue could still be reached through
     * the severity-based rule.
     */
    const severityCanMatter =
      !dispatch &&
      !queueGuaranteed &&
      judgement.actionable >=
        policy.queue.actionable;


    if (
      severityCanMatter
    ) {
      const severityAnswer =
        await this.#ask(
          observation,
          "severity"
        );

      judgement.severity =
        severityAnswer.score;
    }


    /*
     * Make the decision now that all signals
     * capable of affecting it are available.
     */
    const result =
      this.#decide(
        observation,
        judgement
      );


    /*
     * Route is only useful when the
     * observation will actually go somewhere.
     *
     * This includes decisions raised by
     * minimum_decision.
     */
    if (
      result.decision !==
      "ignore"
    ) {
      const routeAnswer =
        await this.#ask(
          observation,
          "route"
        );

      judgement.route =
        routeAnswer.choice;

      judgement.routeConfidence =
        routeAnswer
          .probabilities?.[
            routeAnswer.choice
          ] ?? null;
    }


    return {
      judgement,

      policy:
        result
    };
  }


  /*
   * Ask one Laya question.
   *
   * There is deliberately no queue here.
   *
   * #evaluate() holds an evaluation slot, so
   * all questions belonging to one
   * observation remain together.
   */
  async #ask(
    observation,
    questionName
  ) {
    const question =
      this.config.laya
        .questions[
          questionName
        ];


    const state = {
      source:
        observation.source,

      type:
        observation.type,

      state:
        observation.state,

      title:
        observation.title,

      message:
        observation.message,

      data:
        observation.data ?? {}
    };


    const result =
      await this.laya.systemOne(
        state,
        {
          [questionName]:
            question
        }
      );


    return result.answers[
      questionName
    ];
  }


  /*
   * Generic Brainstem policy.
   */
  #decide(
    observation,
    judgement
  ) {
    const policy =
      this.config.policy;

    let decision;
    let reason;


    /*
     * Immediate investigation.
     */
    if (
      judgement.attention >=
        policy.dispatch.attention &&
      judgement.actionable >=
        policy.dispatch.actionable
    ) {
      decision =
        "dispatch";

      reason =
        "Observation requires immediate investigation";
    }


    /*
     * Actionable work where severity was
     * required to determine queue.
     */
    else if (
      judgement.actionable >=
        policy.queue.actionable &&
      judgement.severity !== null &&
      judgement.severity >=
        policy.queue.severity
    ) {
      decision =
        "queue";

      reason =
        "Observation represents actionable work";
    }


    /*
     * Sufficiently actionable on its own.
     */
    else if (
      judgement.actionable >=
        policy.actionableQueue.actionable
    ) {
      decision =
        "queue";

      reason =
        "Observation is suitable for agent work";
    }


    /*
     * Nothing useful to do.
     */
    else {
      decision =
        "ignore";

      reason =
        "Observation does not require further action";
    }


    /*
     * Deterministic minimum decision.
     *
     * Adapters can raise the minimum decision,
     * but can never lower the semantic result.
     */
    const minimum =
      observation.facts
        ?.minimum_decision;


    if (
      minimum &&
      DECISIONS.indexOf(minimum) >
      DECISIONS.indexOf(decision)
    ) {
      decision =
        minimum;

      reason =
        `Deterministic policy requires at least '${minimum}'`;
    }


    return {
      decision,
      reason
    };
  }


  /*
   * Store access.
   *
   * Async, like the record store. Always
   * return copies so external code cannot
   * modify Brainstem's internal state.
   */

  async getRecord(id) {
    const record =
      await this.records.get(id);

    return record
      ? structuredClone(
          record
        )
      : null;
  }


  async getObservation(id) {
    const observation =
      (await this.records.get(id))
        ?.observation;

    return observation
      ? structuredClone(
          observation
        )
      : null;
  }


  async getDecision(id) {
    const decision =
      (await this.records.get(id))
        ?.decision;

    return decision
      ? structuredClone(
          decision
        )
      : null;
  }
}


/*
 * Decision envelope for one evaluation.
 */

function decisionOf({
  payload,
  revision,
  fingerprint,
  evaluation
}) {
  return {
    version: VERSION,
    kind: "decision",

    payload: {
      observation_id:
        payload.id,

      revision,

      fingerprint,

      decision:
        evaluation.policy.decision,

      route:
        evaluation.judgement.route,

      signals: {
        attention:
          evaluation.judgement.attention,

        actionable:
          evaluation.judgement.actionable,

        severity:
          evaluation.judgement.severity
      },

      confidence: {
        route:
          evaluation.judgement
            .routeConfidence
      },

      reason:
        evaluation.policy.reason,

      timestamp:
        new Date().toISOString()
    }
  };
}


/*
 * Observation helper.
 */

// Observations are built by the SDK (shared with plugins).
export { createObservation };


/*
 * Fingerprinting.
 *
 * Timestamp is intentionally excluded.
 *
 * Polling the same state at a later time
 * should not trigger semantic evaluation.
 */

function layaLoadOptionsFromConfig(config) {
  const options = {
    ...(config.runtime?.laya ?? {}),
    ...(config.laya?.download ?? {})
  };

  if (
    options.tokenEnv &&
    !options.token
  ) {
    options.token =
      process.env[options.tokenEnv];
  }

  // A mounted model (the brainstem-models image) wins over
  // downloading.
  if (
    !options.modelDir &&
    process.env.BRAINSTEM_LAYA_MODEL_DIR
  ) {
    options.modelDir =
      process.env.BRAINSTEM_LAYA_MODEL_DIR;
  }

  delete options.tokenEnv;
  delete options.retry;
  delete options.workers;

  return options;
}

function cacheKeyOf(config) {
  const content = {
    version: VERSION,
    policy:
      config.policy ?? {},
    laya:
      config.laya ?? {}
  };

  return createHash(
    "sha256"
  )
    .update(
      stableStringify(
        content
      )
    )
    .digest("hex");
}

function fingerprintOf(
  observation
) {
  const content = {
    source:
      observation.source,

    type:
      observation.type,

    state:
      observation.state,

    title:
      observation.title,

    message:
      observation.message,

    facts:
      observation.facts ?? {},

    data:
      observation.data ?? {}
  };


  return createHash(
    "sha256"
  )
    .update(
      stableStringify(
        content
      )
    )
    .digest("hex");
}


/*
 * Deterministic JSON-like serialization.
 *
 * Validation of supported observation data
 * belongs outside the core.
 */

function stableStringify(value) {
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return JSON.stringify(
      value
    );
  }


  if (
    Array.isArray(value)
  ) {
    return (
      "[" +
      value
        .map(
          stableStringify
        )
        .join(",") +
      "]"
    );
  }


  return (
    "{" +
    Object.keys(value)
      .sort()
      .map(
        key =>
          JSON.stringify(key) +
          ":" +
          stableStringify(
            value[key]
          )
      )
      .join(",") +
    "}"
  );
}
