import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_REPEAT_AFTER_MS =
  60 * 60 * 1000;

const DEFAULT_ACTIONABLE_DECISIONS = [
  "dispatch",
  "escalate"
];

const memoryStates =
  new Map();

const fileCache =
  new Map();

export async function planNotification(ctx, event) {
  const notify =
    normalizeNotifyConfig(ctx.config.notify ?? {});

  const decision =
    event.decision.payload;

  const observation =
    event.observation.payload;

  const key =
    notificationKey(ctx, event);

  const state =
    await loadState(notify);

  const previous =
    state[key];

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
        previousEventId:
          previous?.eventId,
        async commit({ eventId } = {}) {
          state[key] = {
            status: "active",
            fingerprint: decision.fingerprint,
            decision: decision.decision,
            observationState: observation.state,
            eventId: eventId ?? previous?.eventId ?? null,
            lastSentAt: now,
            updatedAt: new Date(now).toISOString()
          };

          await saveState(notify, state);
        }
      };
    }

    return suppressed();
  }

  if (
    notify.onRecovery &&
    previous?.status === "active"
  ) {
    return {
      send: true,
      kind: "recovery",
      previousEventId:
        previous.eventId,
      async commit({ eventId } = {}) {
        state[key] = {
          status: "resolved",
          fingerprint: decision.fingerprint,
          decision: decision.decision,
          observationState: observation.state,
          eventId: eventId ?? previous.eventId ?? null,
          lastSentAt: now,
          updatedAt: new Date(now).toISOString()
        };

        await saveState(notify, state);
      }
    };
  }

  return suppressed();
}

export function resetNotificationState() {
  memoryStates.clear();
  fileCache.clear();
}

function suppressed() {
  return {
    send: false,
    kind: "suppressed",
    previousEventId: null,
    async commit() {}
  };
}

function normalizeNotifyConfig(config) {
  const repeatAfterMs =
    config.repeatAfterMs === undefined
      ? DEFAULT_REPEAT_AFTER_MS
      : config.repeatAfterMs;

  if (
    repeatAfterMs !== null &&
    (
      typeof repeatAfterMs !== "number" ||
      repeatAfterMs < 0
    )
  ) {
    throw new Error(
      "Matrix notify.repeatAfterMs must be a non-negative number or null"
    );
  }

  return {
    repeatAfterMs,

    onRecovery:
      config.onRecovery ?? true,

    actionableDecisions:
      config.actionableDecisions ??
      DEFAULT_ACTIONABLE_DECISIONS,

    statePath:
      config.statePath === false
        ? null
        : resolve(
            config.statePath ??
            "data/matrix-notifications.json"
          )
  };
}

async function loadState(notify) {
  if (!notify.statePath) {
    return objectFromMap(memoryStates);
  }

  if (fileCache.has(notify.statePath)) {
    return fileCache.get(notify.statePath);
  }

  try {
    const data = JSON.parse(
      await readFile(notify.statePath, "utf8")
    );

    fileCache.set(notify.statePath, data);
    return data;
  }
  catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    const data = {};
    fileCache.set(notify.statePath, data);
    return data;
  }
}

async function saveState(notify, state) {
  if (!notify.statePath) {
    memoryStates.clear();

    for (const [key, value] of Object.entries(state)) {
      memoryStates.set(key, value);
    }

    return;
  }

  await mkdir(dirname(notify.statePath), {
    recursive: true
  });

  const temporaryPath =
    `${notify.statePath}.tmp`;

  await writeFile(
    temporaryPath,
    JSON.stringify(state, null, 2) + "\n"
  );

  await rename(
    temporaryPath,
    notify.statePath
  );
}

function objectFromMap(map) {
  return Object.fromEntries(
    map.entries()
  );
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
