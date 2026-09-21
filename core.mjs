import { createHash } from "node:crypto";
import { Laya } from "@receptron/laya";

const VERSION = "1";

const DECISIONS = [
  "ignore",
  "queue",
  "dispatch",
  "escalate"
];


export class Brainstem {
  constructor(config) {
    this.config =
      structuredClone(config);

    this.laya = null;

    this.records =
      new Map();

    /*
     * Per-observation locks.
     *
     * Updates for the same ID are always
     * processed in arrival order.
     */
    this.locks =
      new Map();

    /*
     * Global semantic evaluation queue.
     *
     * Only one changed observation may use
     * Laya at a time.
     *
     * Cached observations never enter this
     * queue.
     */
    this.evaluationQueue =
      Promise.resolve();
  }


  async start() {
    if (!this.laya) {
      this.laya =
        await Laya.load();
    }
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
     * Wait for the semantic queue.
     */
    await this.evaluationQueue
      .catch(() => {});

    await this.laya?.close();

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
      this.records.get(
        payload.id
      );


    /*
     * Nothing meaningful changed.
     *
     * Store the newest observation so the
     * latest observation timestamp/state is
     * available, but reuse the old decision.
     */
    if (
      existing?.fingerprint ===
      fingerprint
    ) {
      existing.observation =
        observation;

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


    const revision =
      (existing?.revision ?? 0) + 1;


    const decision = {
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


    /*
     * Store private copies.
     */
    this.records.set(
      payload.id,
      {
        revision,
        fingerprint,

        observation:
          structuredClone(
            observation
          ),

        decision:
          structuredClone(
            decision
          )
      }
    );


    return structuredClone(
      decision
    );
  }


  /*
   * Global evaluation queue.
   *
   * Each queued item represents one complete
   * changed observation, not one question.
   */
  async #queueEvaluation(
    observation
  ) {
    const run =
      this.evaluationQueue
        .catch(() => {})
        .then(() =>
          this.#evaluate(
            observation
          )
        );


    /*
     * Keep the queue alive even when one
     * evaluation fails.
     */
    this.evaluationQueue =
      run.then(
        () => undefined,
        () => undefined
      );


    return await run;
  }


  /*
   * Complete semantic evaluation.
   *
   * Once this starts, no other observation
   * can use Laya until it returns.
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
   * #evaluate() itself is globally
   * serialized, so all questions belonging
   * to one observation remain together.
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
   * Always return copies so external code
   * cannot modify Brainstem's internal state.
   */

  getRecord(id) {
    const record =
      this.records.get(id);

    return record
      ? structuredClone(
          record
        )
      : null;
  }


  getObservation(id) {
    const observation =
      this.records.get(id)
        ?.observation;

    return observation
      ? structuredClone(
          observation
        )
      : null;
  }


  getDecision(id) {
    const decision =
      this.records.get(id)
        ?.decision;

    return decision
      ? structuredClone(
          decision
        )
      : null;
  }
}


/*
 * Observation helper.
 */

export function createObservation({
  id,
  source,
  type,
  state,
  timestamp =
    new Date().toISOString(),
  title,
  message,
  facts = {},
  data = {}
}) {
  return {
    version: VERSION,
    kind: "observation",

    payload: {
      id,
      source,
      type,
      state,
      timestamp,
      title,
      message,
      facts,
      data
    }
  };
}


/*
 * Fingerprinting.
 *
 * Timestamp is intentionally excluded.
 *
 * Polling the same state at a later time
 * should not trigger semantic evaluation.
 */

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
