# GitHub Issues Input

Polls GitHub issues and emits Brainstem observations.

## Module

```js
"./plugins/github-issues/index.mjs"
```

## Config

```js
inputs: [
  {
    id: "github-my-repo-issues",
    module: "./plugins/github-issues/index.mjs",
    input: "issues",
    config: {
      repo: "owner/repo",
      tokenEnv: "GITHUB_TOKEN",
      state: "all",
      perPage: 100,
      maxPages: 10,
      startFromNow: true
    }
  }
]
```

## Options

```js
repo       // required, owner/repo
state      // default: all
perPage    // default: 100, capped at 100
maxPages   // default: 10
startFromNow // default: true; checkpoint current issues on first run without emitting
labels     // optional GitHub labels query
tokenEnv   // env var containing token
token      // string or { env: "GITHUB_TOKEN" }
```

## Deduplication

The plugin stores a per-issue fingerprint in the input checkpoint. It emits an issue only when the issue is new to the checkpoint or when meaningful issue content changes, such as title, body, labels, comments count, state, or GitHub `updated_at`.

By default `startFromNow` is `true`, so the first poll records currently visible issues without emitting them. Set `startFromNow: false` if you want the first run to process existing matching issues.

## Emitted observations

```js
source.type = "github"
type = "issue"
state = issue.state
```

Observation ID:

```text
github:<owner/repo>:issue:<number>
```

If an issue has a `security` label, the plugin sets:

```js
facts.minimum_decision = "dispatch"
```

## Tokens

Public repositories may work without a token, but GitHub rate limits are stricter.

For private repositories or higher rate limits, set:

```sh
GITHUB_TOKEN=...
```

and configure:

```js
tokenEnv: "GITHUB_TOKEN"
```
