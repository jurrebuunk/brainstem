# State

Brainstem uses two separate kinds of state.

## Core records

Core records persist the latest Brainstem decision for each observation ID.

They are used for durable deduplication:

```text
same observation ID + same fingerprint + same decision cache key
→ reuse previous decision without calling Laya
```

The default configured store is SQLite:

```js
runtime: {
  records: {
    type: "sqlite",
    path: "data/brainstem.sqlite",
    pruneAfterDays: 90
  }
}
```

The SQLite store keeps one row per observation ID, not a full event history.

Stored fields include:

```text
id
fingerprint
cache_key
revision
observation_json
decision_json
first_seen_at
last_seen_at
updated_at
```

`last_seen_at` is updated when the same observation is seen again. Records older than `pruneAfterDays` are removed on startup. Set `pruneAfterDays: null` to disable pruning.

The `cache_key` is derived from the Brainstem core version, policy config, and Laya question config. If those change, Brainstem reevaluates matching observations instead of reusing stale decisions.

## Input checkpoints

Input checkpoints are tiny adapter cursors, such as:

```js
{ lastSeenAt: "2026-09-22T08:30:00Z" }
```

They are used by append-only sources like chats, logs, and email to avoid refetching old items.

Adapters access checkpoints through:

```js
ctx.checkpoint.get()
ctx.checkpoint.defer(value)
```

Deferred checkpoints are committed only after all emitted observations have been processed successfully.

Configured checkpoint store:

```js
runtime: {
  checkpoints: {
    type: "json",
    path: "data/checkpoints.json"
  }
}
```

Adapters should not access storage directly.
