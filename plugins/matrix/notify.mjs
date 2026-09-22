const DEFAULT_REPEAT_AFTER_MS =
  60 * 60 * 1000;

const DEFAULT_ACTIONABLE_DECISIONS = [
  "dispatch",
  "escalate"
];

const states =
  new Map();

export function planNotification(ctx, event) {
  const notify =
    normalizeNotifyConfig(ctx.config.notify ?? {});

  const decision =
    event.decision.payload;

  const observation =
    event.observation.payload;

  const key =
    notificationKey(ctx, event);

  const previous =
    states.get(key);

  const now =
    Date.now();

  const actionable =
    notify.actionableDecisions.includes(
      decision.decision
    );

  if (actionable) {
    const changed =
      previous?.fingerprint !==
      decision.fingerprint;

    const repeatDue =
      notify.repeatAfterMs !== null &&
      previous?.status === "active" &&
      now - previous.lastSentAt >=
        notify.repeatAfterMs;

    if (
      !previous ||
      previous.status !== "active" ||
      changed ||
      repeatDue
    ) {
      return {
        send: true,
        kind:
          previous?.status === "active" &&
          !changed
            ? "repeat"
            : "alert",
        commit() {
          states.set(key, {
            status: "active",
            fingerprint: decision.fingerprint,
            decision: decision.decision,
            observationState: observation.state,
            lastSentAt: now
          });
        }
      };
    }

    return {
      send: false,
      kind: "suppressed",
      commit() {}
    };
  }

  if (
    notify.onRecovery &&
    previous?.status === "active"
  ) {
    return {
      send: true,
      kind: "recovery",
      commit() {
        states.set(key, {
          status: "resolved",
          fingerprint: decision.fingerprint,
          decision: decision.decision,
          observationState: observation.state,
          lastSentAt: now
        });
      }
    };
  }

  return {
    send: false,
    kind: "suppressed",
    commit() {}
  };
}

export function resetNotificationState() {
  states.clear();
}

function normalizeNotifyConfig(config) {
  return {
    repeatAfterMs:
      config.repeatAfterMs === undefined
        ? DEFAULT_REPEAT_AFTER_MS
        : config.repeatAfterMs,

    onRecovery:
      config.onRecovery ?? true,

    actionableDecisions:
      config.actionableDecisions ??
      DEFAULT_ACTIONABLE_DECISIONS
  };
}

function notificationKey(ctx, event) {
  if (typeof ctx.config.notificationKey === "function") {
    return ctx.config.notificationKey(event);
  }

  const observation =
    event.observation.payload;

  return [
    ctx.config.roomId,
    observation.source.type,
    observation.source.name,
    observation.type,
    observation.id
  ].join("|");
}
