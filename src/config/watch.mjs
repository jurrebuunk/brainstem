/*
 * Hot reload (roadmap 4.6): call onChange(version) whenever the
 * active config version changes.
 *
 * Woken by the "config" notification (LISTEN/NOTIFY on Postgres) and
 * checked every intervalMs as a fallback (SQLite across processes, a
 * missed notification). Changes are handled one at a time, newest
 * wins.
 */
export function watchActiveConfig({
  store,
  notifier = null,
  currentId = null,
  onChange,
  intervalMs = 30_000,
  logger = null
}) {
  let current = currentId;
  let running = Promise.resolve();
  let stopped = false;

  const check = () => {
    running = running.then(async () => {
      if (stopped) return;

      try {
        const id = await store.activeId();
        if (id === null || id === current) return;

        const version = await store.active();
        if (!version || version.id === current) return;

        const previous = current;
        current = version.id;

        try {
          await onChange(version, { previous });
        }
        catch (error) {
          // Retried on the next change or interval.
          current = previous;
          logger?.error?.("config reload failed", { version: version.id, error });
        }
      }
      catch (error) {
        logger?.warn?.("config version check failed", { error });
      }
    });

    return running;
  };

  const unlisten = notifier?.listen("config", () => check());
  const unlistenReconnect = notifier?.listen("$reconnect", () => check());
  const timer = intervalMs > 0 ? setInterval(check, intervalMs) : null;
  timer?.unref?.();

  return {
    check,
    get currentId() {
      return current;
    },
    async stop() {
      stopped = true;
      unlisten?.();
      unlistenReconnect?.();
      if (timer) clearInterval(timer);
      await running;
    }
  };
}
