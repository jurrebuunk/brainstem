import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { MemoryPluginStateStore } from "../../src/runtime/plugin-state.mjs";
import { createPluginState } from "../../src/sdk/index.mjs";

const DEFAULT_REPEAT_AFTER_MS =
  60 * 60 * 1000;

/*
 * How long a send claimed by one process blocks the same
 * notification in other processes. A claim that is neither
 * committed nor released within this window (crashed process)
 * is ignored, so the next event sends again: a duplicate beats
 * a missed alert.
 */
const DEFAULT_CLAIM_TIMEOUT_MS =
  5 * 60 * 1000;

const DEFAULT_ACTIONABLE_DECISIONS = [
  "dispatch",
  "escalate"
];

const DEFAULT_LEGACY_STATE_PATH =
  "data/matrix-notifications.json";

const NOTIFICATION_KEY_PREFIX =
  "notification:";

const LEGACY_IMPORT_KEY =
  "legacy-import";

const FALLBACK_NAMESPACE =
  "destination:@brainstem/matrix:room";

/*
 * Used only when the destination context has no ctx.state
 * (hand-built contexts in tests or scripts).
 */
let fallbackStore =
  new MemoryPluginStateStore();

/*
 * Decide whether to send, and atomically claim the send.
 *
 * The decision and the claim happen in one ctx.state.update(),
 * so two processes sharing the state store cannot both send the
 * same alert. After sending, call commit({ eventId }); if the
 * send fails, call release() so the next event can retry.
 */
export async function planNotification(ctx, event) {
  const notify =
    normalizeNotifyConfig(ctx.config.notify ?? {});

  const state =
    notificationState(ctx);

  await importLegacyState(state, notify, ctx.logger);

  const decision =
    event.decision.payload;

  const observation =
    event.observation.payload;

  const stateKey =
    NOTIFICATION_KEY_PREFIX + notificationKey(ctx, event);

  const now =
    Date.now();

  const claimId =
    randomUUID();

  let plan =
    suppressed();

  await state.update(stateKey, current => {
    const previous =
      effectiveEntry(current, now, notify.claimTimeoutMs);

    plan =
      decide({
        notify,
        decision,
        observation,
        previous,
        now
      });

    if (!plan.send) {
      return undefined;
    }

    return {
      ...plan.entry,
      pending: {
        id: claimId,
        at: now,
        previous: withoutPending(previous)
      }
    };
  });

  if (!plan.send) {
    return suppressed();
  }

  const { kind, previousEventId, previous, entry } =
    plan;

  return {
    send: true,
    kind,
    previousEventId,

    async commit({ eventId } = {}) {
      await state.update(stateKey, current => {
        if (current?.pending?.id !== claimId) {
          return undefined;
        }

        return {
          ...entry,
          rootEventId: rootEventIdFor(kind, previous, eventId),
          eventId: eventId ?? previous?.eventId ?? null
        };
      });
    },

    async release() {
      await state.update(stateKey, current => {
        if (current?.pending?.id !== claimId) {
          return undefined;
        }

        return current.pending.previous ?? {
          status: "unsent",
          updatedAt: new Date().toISOString()
        };
      });
    }
  };
}

/*
 * Reset the fallback in-memory state used by contexts without
 * ctx.state. Tests call this between cases.
 */
export function resetNotificationState() {
  fallbackStore =
    new MemoryPluginStateStore();
}

function decide({
  notify,
  decision,
  observation,
  previous,
  now
}) {
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
      const kind =
        previous?.status === "active" &&
        !changed
          ? "repeat"
          : "alert";

      const previousEventId =
        kind === "repeat"
          ? previous?.rootEventId ?? previous?.eventId ?? null
          : null;

      return {
        send: true,
        kind,
        previousEventId,
        previous,
        entry: {
          status: "active",
          fingerprint: decision.fingerprint,
          decision: decision.decision,
          observationState: observation.state,
          rootEventId:
            kind === "repeat"
              ? previous?.rootEventId ?? previous?.eventId ?? null
              : null,
          eventId: previous?.eventId ?? null,
          lastSentAt: now,
          updatedAt: new Date(now).toISOString()
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
        previous.rootEventId ?? previous.eventId ?? null,
      previous,
      entry: {
        status: "resolved",
        fingerprint: decision.fingerprint,
        decision: decision.decision,
        observationState: observation.state,
        rootEventId: previous.rootEventId ?? previous.eventId ?? null,
        eventId: previous.eventId ?? null,
        lastSentAt: now,
        updatedAt: new Date(now).toISOString()
      }
    };
  }

  return suppressed();
}

function rootEventIdFor(kind, previous, eventId) {
  if (kind === "alert") {
    return eventId ?? null;
  }

  if (kind === "repeat") {
    return previous?.rootEventId ?? previous?.eventId ?? eventId ?? null;
  }

  return previous?.rootEventId ?? previous?.eventId ?? null;
}

/*
 * A fresh claim counts as sent (another process is sending it).
 * A stale claim is rolled back to the state before it.
 */
function effectiveEntry(entry, now, claimTimeoutMs) {
  if (!entry?.pending) {
    return entry ?? null;
  }

  if (now - entry.pending.at < claimTimeoutMs) {
    return entry;
  }

  return entry.pending.previous ?? null;
}

function withoutPending(entry) {
  if (!entry) {
    return null;
  }

  const { pending: _pending, ...rest } =
    entry;

  return rest;
}

function suppressed() {
  return {
    send: false,
    kind: "suppressed",
    previousEventId: null,
    async commit() {},
    async release() {}
  };
}

function notificationState(ctx) {
  return ctx.state ??
    createPluginState(fallbackStore, FALLBACK_NAMESPACE);
}

/*
 * One-time import of the pre-database JSON state file. Entries are
 * only written to keys that are still empty, and the file itself is
 * left untouched.
 */
async function importLegacyState(state, notify, logger) {
  if (!notify.legacyStatePath) {
    return;
  }

  const marker =
    await state.get(LEGACY_IMPORT_KEY);

  if (marker) {
    return;
  }

  const legacy =
    await loadLegacyStateFile(notify.legacyStatePath);

  let imported = 0;

  for (const [key, value] of Object.entries(legacy ?? {})) {
    if (!value || typeof value !== "object") {
      continue;
    }

    await state.update(
      NOTIFICATION_KEY_PREFIX + key,
      current => {
        if (current !== undefined) {
          return undefined;
        }

        imported += 1;
        return value;
      }
    );
  }

  await state.update(LEGACY_IMPORT_KEY, current =>
    current ?? {
      path: notify.legacyStatePath,
      found: legacy !== null,
      imported,
      importedAt: new Date().toISOString()
    }
  );

  if (imported > 0) {
    logger?.info?.(
      "matrix notification state imported from legacy file",
      {
        path: notify.legacyStatePath,
        imported
      }
    );
  }
}

async function loadLegacyStateFile(path) {
  try {
    return JSON.parse(
      await readFile(path, "utf8")
    );
  }
  catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
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

  const claimTimeoutMs =
    config.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;

  if (
    typeof claimTimeoutMs !== "number" ||
    claimTimeoutMs < 0
  ) {
    throw new Error(
      "Matrix notify.claimTimeoutMs must be a non-negative number"
    );
  }

  return {
    repeatAfterMs,
    claimTimeoutMs,

    onRecovery:
      config.onRecovery ?? true,

    actionableDecisions:
      config.actionableDecisions ??
      DEFAULT_ACTIONABLE_DECISIONS,

    // Pre-database state file, imported once into ctx.state.
    legacyStatePath:
      config.statePath === false
        ? null
        : resolve(
            config.statePath ??
            DEFAULT_LEGACY_STATE_PATH
          )
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
